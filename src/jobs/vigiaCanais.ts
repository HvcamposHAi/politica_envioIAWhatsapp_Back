// Vigia de canais — a rede de segurança do lado do SERVIDOR.
//
// POR QUE ISTO EXISTE: até o diagnóstico de 2026-08-14 nada no backend
// perguntava "o que deveria estar conectado está?". A única verificação viva
// do sistema era um setInterval de 30s no front (tab-canais.tsx) — que só
// roda enquanto um admin está com a aba Configurações › Canais ABERTA, e só
// para canais que o banco já afirma estarem conectados. Com a tela fechada,
// uma linha podia ficar dias fora do ar sem nenhum sinal, e o primeiro a
// perceber era o cliente do outro lado que não recebia resposta.
//
// Some-se a isso o backstop de `uncaughtException` em server.ts: ele mantém o
// processo de pé (decisão certa num gateway multi-linha), mas um socket que
// morre por exceção interna do Baileys pode não emitir 'close' — e aí nem o
// backoff exponencial do adapter dispara. O `statusAtual` congela em
// 'conectado' e a guarda de staleness de 90s só ajuda se ALGUÉM chamar
// conectar() de novo. Este job é esse alguém.
//
// O QUE ELE NÃO FAZ: não abre socket. Ele só chama `conectar()` pelo
// registry, que é idempotente e tem guarda própria de staleness — quem
// decide entre assumir uma tentativa presa ou virar no-op continua sendo o
// adapter, num lugar só. Os 60s do intervalo são deliberadamente MENORES que
// os 90s dessa guarda: o vigia detecta rápido e chama; a guarda filtra.
//
// E não reconecta qualquer coisa: `canaisRecuperaveis()` já exclui quem não
// tem sessão salva em hub.canal_sessoes. Reconectar às cegas um canal sem
// credencial é o perfil de tráfego que faz o WhatsApp aplicar limitação
// anti-abuso (ver MAXIMO_CICLOS_REGISTRO em baileys.adapter.ts).

import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';
import { canaisRecuperaveis, canalEmMemoria, obterOuCriarCanal } from '../channels/registry.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/** Menor que os 90s de GUARDA_CONEXAO_STALE_MS no adapter, de propósito —
 *  ver nota no topo do arquivo. */
export const VIGIA_INTERVALO_MS = 60_000;

/** Estados em que o canal está em trânsito e o vigia NÃO deve intervir: já
 *  há uma tentativa em andamento (do backoff, de um clique, ou da passada
 *  anterior deste próprio job). Cutucar aqui é o que abriria sockets
 *  concorrentes. */
const EM_TRANSITO = new Set(['conectado', 'conectando', 'lendo_qr']);

/**
 * Uma passada do vigia. Exportada para teste — o `setInterval` só a chama.
 *
 * NUNCA lança: qualquer exceção que escape daqui viraria um
 * unhandledRejection dentro de um timer, e num processo que segura todas as
 * linhas de WhatsApp isso é dano muito maior que uma passada perdida.
 * Devolve quantos canais foram reconectados, só para o teste ter o que
 * afirmar.
 */
export async function vigiarCanais(): Promise<number> {
  let reconectados = 0;
  try {
    const ids = await canaisRecuperaveis();
    for (const id of ids) {
      try {
        const vivo = canalEmMemoria(id);
        // Sem objeto no Map = nenhum socket neste processo, ponto. É o caso
        // do restart sujo e o do canal que nunca foi carregado.
        const status = vivo ? await vivo.status() : 'desconectado';
        if (EM_TRANSITO.has(status)) continue;

        logger.warn(
          { canalId: id, status },
          'vigia: canal deveria estar de pé e não está — reconectando',
        );
        // Registrar ANTES de agir: é este evento que prova, em
        // hub.eventos_canal, que o vigia está vivo. Ausência dele por
        // muito tempo é o sinal de que o próprio vigia morreu (item A8 da
        // auditoria).
        const { error } = await supabaseAdmin
          .from('eventos_canal')
          .insert({ canal_id: id, tipo: 'reconectando', detalhe: { motivo: 'vigia', status } });
        if (error) {
          logger.error({ canalId: id, err: error.message }, 'vigia: falha ao gravar hub.eventos_canal');
        }

        const canal = await obterOuCriarCanal(id);
        // void: conectar() resolve quando o socket abre, não quando ele
        // autentica — esperar aqui seguraria a fila dos outros canais.
        void canal.conectar();
        reconectados += 1;
      } catch (err) {
        // Um canal problemático não pode impedir a verificação dos demais.
        logger.error(
          { canalId: id, err: err instanceof Error ? err.message : String(err) },
          'vigia: falha ao verificar canal — segue para o próximo',
        );
      }
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'vigia: passada falhou por inteiro — próxima passada tenta de novo',
    );
  }
  return reconectados;
}

let timer: ReturnType<typeof setInterval> | undefined;

export function iniciarVigiaDeCanais(): void {
  if (timer) return;
  // Sem passada imediata: reconectarCanaisAoSubir() acabou de rodar no boot
  // e as conexões dele ainda estão em handshake. A primeira passada do vigia
  // vem depois de um intervalo cheio, quando já dá para distinguir "ainda
  // conectando" de "não subiu".
  timer = setInterval(() => void vigiarCanais(), VIGIA_INTERVALO_MS);
  timer.unref?.();
}

export function pararVigiaDeCanais(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
