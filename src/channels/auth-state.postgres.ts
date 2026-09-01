// Auth state do Baileys persistido em hub.canal_sessoes — Fase 5 do plano
// ("auth state do Baileys no banco, não em arquivo. Faz a VM ficar
// descartável: reboot não derruba as linhas").
//
// Verificado contra o pacote instalado (@whiskeysockets/baileys@6.7.24,
// node_modules/@whiskeysockets/baileys/lib/Types/Auth.d.ts):
//   AuthenticationState = { creds: AuthenticationCreds, keys: SignalKeyStore }
//   SignalKeyStore = { get(type, ids), set(data), clear?() }
// `initAuthCreds()` e `BufferJSON` são exports reais do pacote (Utils),
// não inventados — é o padrão usado por praticamente toda implementação
// de auth state customizado da comunidade Baileys (o pacote só inclui
// `useMultiFileAuthState`, que grava em arquivo; qualquer backend
// diferente de arquivo precisa reimplementar isto).
//
// Estratégia de armazenamento: `creds` inteiro em uma coluna jsonb;
// `keys` como um único blob jsonb `{ [tipo]: { [id]: dado } }`, carregado
// uma vez na conexão e regravado por inteiro a cada `set()` (write-through
// simples). Correto e suficiente para o volume de uma linha de WhatsApp;
// não veio otimizado por linha de chave porque não há indício de que
// isso seja gargalo real — se a Fase 9 medir o contrário, revisitar.
//
// NÃO TESTADO CONTRA UMA SESSÃO REAL nesta passada: pareamento de
// verdade exige um número de WhatsApp físico e ambiente ao vivo, que
// esta sessão não tem. O que foi validado: compila contra os tipos reais
// do pacote instalado, e o padrão de serialização (BufferJSON) é o
// documentado pelo próprio Baileys.

import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { supabaseAdmin } from '../db/client.server.js';

// NOTA DE TIPAGEM: `SignalDataTypeMap[T]` varia por tipo de sinal (KeyPair,
// Uint8Array, LTHashState...). Guardar tudo num blob jsonb genérico (o
// design deste arquivo) significa que o valor real só é conhecido em
// runtime, não em compile-time — daí o `as any` no retorno de `get()`.
// A alternativa correta-por-tipo (uma coluna/tabela por SignalDataTypeMap)
// é mais código para um ganho que não há evidência de precisar agora.

type KeysBlob = { [T in keyof SignalDataTypeMap]?: Record<string, unknown> };

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize<T>(text: string): T {
  return JSON.parse(text, BufferJSON.reviver) as T;
}

interface CanalSessaoRow {
  creds: string | null;
  keys: string | null;
}

async function carregar(canalId: string): Promise<{ creds: AuthenticationCreds; keys: KeysBlob }> {
  const { data, error } = await supabaseAdmin
    .from('canal_sessoes')
    .select('creds, keys')
    .eq('canal_id', canalId)
    .maybeSingle<CanalSessaoRow>();

  if (error) {
    throw new Error(`Falha ao carregar hub.canal_sessoes para ${canalId}: ${error.message}`);
  }

  const creds = data?.creds ? deserialize<AuthenticationCreds>(data.creds) : initAuthCreds();
  const keys = data?.keys ? deserialize<KeysBlob>(data.keys) : {};
  return { creds, keys };
}

const PERSISTIR_TENTATIVAS_MAXIMAS = 3;

/**
 * Incidente 2026-08-07 (confirmado em produção via `gcloud logging read`):
 * uma falha transitória de rede ao gravar (`TypeError: fetch failed`) —
 * comum durante a rajada de `creds.update`/`keys.set()` do handshake de
 * pareamento por QR — se propagada como throw, derruba o processo Node
 * INTEIRO (`socket.ev.on('creds.update', saveCreds)` em baileys.adapter.ts
 * não tem proteção própria, e o próprio Baileys chama `keys.set()` de
 * dentro do handshake sem try/catch). Como o backend é um processo único
 * para todas as linhas (plano-base §5), isso tira do ar linhas saudáveis
 * por causa de uma falha pontual numa única linha.
 *
 * Retry curto absorve blips passageiros. Se persistir a falha, loga e
 * desiste SEM lançar — perder um `set()` de chave nesta janela, na pior
 * hipótese, corrompe o estado de sessão desta linha e força um novo QR
 * dela mais tarde; derrubar o processo tira do ar todas as linhas agora.
 */
async function persistir(
  canalId: string,
  creds: AuthenticationCreds,
  keys: KeysBlob,
  tentativa = 1,
): Promise<void> {
  const { error } = await supabaseAdmin.from('canal_sessoes').upsert(
    {
      canal_id: canalId,
      creds: serialize(creds),
      keys: serialize(keys),
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: 'canal_id' },
  );

  if (!error) return;

  if (tentativa < PERSISTIR_TENTATIVAS_MAXIMAS) {
    await new Promise((resolve) => setTimeout(resolve, 300 * tentativa));
    return persistir(canalId, creds, keys, tentativa + 1);
  }

  // eslint-disable-next-line no-console
  console.error(
    `falha ao persistir hub.canal_sessoes para ${canalId} após ${tentativa} tentativas: ${error.message}`,
  );
}

/**
 * Cria um AuthenticationState do Baileys com backend em hub.canal_sessoes.
 * `saveCreds()` deve ser chamado no handler de `creds.update` do socket —
 * mesmo contrato de `useMultiFileAuthState`, só que gravando no Postgres.
 */
export async function usePostgresAuthState(
  canalId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const { creds, keys } = await carregar(canalId);
  // Mutável de propósito: Baileys muda `creds` in-place e espera que
  // `saveCreds()` capture o estado atual no momento em que é chamado.
  let currentKeys = keys;

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const bucket = (currentKeys[type] ?? {}) as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const id of ids) {
          if (bucket[id] !== undefined) result[id] = bucket[id];
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return result as any; // ver nota de tipagem no topo do arquivo
      },
      set: async (data) => {
        for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const bucket = { ...((currentKeys[type] ?? {}) as Record<string, unknown>) };
          const entries = data[type] as Record<string, unknown> | undefined;
          if (!entries) continue;
          for (const id of Object.keys(entries)) {
            if (entries[id] === null) {
              delete bucket[id];
            } else {
              bucket[id] = entries[id];
            }
          }
          currentKeys = { ...currentKeys, [type]: bucket };
        }
        // Write-through: uma sessão instável que morre sem novo QR (o
        // aceite de A5.5) depende de nunca perder um `set()` de chave.
        await persistir(canalId, creds, currentKeys);
      },
    },
  };

  return {
    state,
    saveCreds: () => persistir(canalId, creds, currentKeys),
  };
}
