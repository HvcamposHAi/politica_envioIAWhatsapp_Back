// Suporte a conversas de GRUPO.
//
// Duas responsabilidades, ambas fora do adapter de propósito:
//  · o opt-in por linha (`hub.canais.receber_grupos`), consultado a CADA
//    mensagem de grupo e por isso cacheado;
//  · o roster do grupo (quem participa), que alimenta a Ficha.
//
// POR QUE OPT-IN, E POR QUE POR LINHA: uma linha pareada a um celular que
// participa de 40 grupos despejaria 40 conversas na Caixa no primeiro minuto,
// e cada uma delas contaria como chamado no Painel. O admin liga linha a
// linha, pela tela de Configurações → Canais. Desligar é o rollback da fase
// de grupos inteira: um UPDATE, sem deploy.

import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/** Cache curto do opt-in. Curto de propósito: o admin liga o botão e espera
 *  ver efeito na conversa seguinte, não daqui a uma hora. 60s é o suficiente
 *  para não fazer um SELECT por mensagem numa rajada de grupo. */
const CACHE_OPTIN_MS = 60_000;

const cacheOptIn = new Map<string, { valor: boolean; em: number }>();

/**
 * A linha aceita mensagens de grupo?
 *
 * Falha FECHADA: erro de leitura devolve `false`. Assumir "sim" faria um
 * problema transitório de banco inundar a Caixa com grupos que o admin nunca
 * autorizou — e a mensagem de grupo perdida enquanto o banco estava fora é
 * um preço muito menor.
 */
export async function canalRecebeGrupos(canalId: string): Promise<boolean> {
  const guardado = cacheOptIn.get(canalId);
  if (guardado && Date.now() - guardado.em < CACHE_OPTIN_MS) return guardado.valor;

  const { data, error } = await supabaseAdmin
    .from('canais')
    .select('receber_grupos')
    .eq('id', canalId)
    .maybeSingle<{ receber_grupos: boolean | null }>();

  if (error) {
    logger.error({ canalId, err: error.message }, 'falha ao ler receber_grupos — assumindo NÃO receber');
    return false;
  }
  const valor = !!data?.receber_grupos;
  cacheOptIn.set(canalId, { valor, em: Date.now() });
  return valor;
}

/** Chamado pela rota que grava o toggle — faz o botão valer na hora, sem
 *  esperar o TTL do cache. Mesmo padrão de invalidarCacheClienteAnthropic(). */
export function invalidarCacheOptInGrupos(canalId?: string): void {
  if (canalId) cacheOptIn.delete(canalId);
  else cacheOptIn.clear();
}

interface ParticipanteBaileys {
  id?: string | null;
  admin?: string | null;
  name?: string | null;
  notify?: string | null;
}

/**
 * Persiste o roster do grupo em hub.grupo_participantes.
 *
 * Fire-and-forget por contrato: é informação de Ficha, não a mensagem. Chamado
 * de dentro do adapter sem `await` — falhar aqui não pode segurar a entrega.
 *
 * O `cliente_id` do grupo é resolvido pelo par (empresa, wa_jid), que é como
 * services/mensagens.ts grava o "cliente-grupo". Se o grupo ainda não existe
 * como cliente (primeiríssima mensagem, ordem de corrida), sai em silêncio: a
 * próxima mensagem sincroniza.
 */
export async function sincronizarParticipantes(
  canalId: string,
  jidGrupo: string,
  participantes: ParticipanteBaileys[],
): Promise<void> {
  try {
    if (!participantes.length) return;

    // Colunas simples e consultas separadas, sem embed do PostgREST: uma FK
    // nova em outra feature já tornou um embed ambíguo e parou um serviço
    // fire-and-forget desta base por uma hora, em silêncio.
    const { data: canal } = await supabaseAdmin
      .from('canais')
      .select('empresa_id')
      .eq('id', canalId)
      .maybeSingle<{ empresa_id: string | null }>();
    if (!canal?.empresa_id) return;

    const { data: grupo } = await supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('empresa_id', canal.empresa_id)
      .eq('wa_jid', jidGrupo)
      .maybeSingle<{ id: string }>();
    if (!grupo) return;

    const linhas = participantes
      .filter((p) => !!p.id)
      .map((p) => ({
        cliente_id: grupo.id,
        wa_jid: p.id as string,
        nome: p.name?.trim() || p.notify?.trim() || null,
        admin: p.admin === 'admin' || p.admin === 'superadmin',
        atualizado_em: new Date().toISOString(),
      }));
    if (!linhas.length) return;

    const { error } = await supabaseAdmin
      .from('grupo_participantes')
      .upsert(linhas, { onConflict: 'cliente_id,wa_jid' });
    if (error) {
      logger.warn({ canalId, jidGrupo, err: error.message }, 'falha ao sincronizar participantes do grupo');
      return;
    }

    // Quem saiu do grupo some do roster. Sem isto a Ficha listaria para
    // sempre gente que já não está lá.
    const jidsAtuais = linhas.map((l) => l.wa_jid);
    await supabaseAdmin
      .from('grupo_participantes')
      .delete()
      .eq('cliente_id', grupo.id)
      .not('wa_jid', 'in', `(${jidsAtuais.map((j) => `"${j}"`).join(',')})`);
  } catch (err) {
    logger.warn(
      { canalId, jidGrupo, err: err instanceof Error ? err.message : String(err) },
      'falha ao sincronizar participantes do grupo',
    );
  }
}
