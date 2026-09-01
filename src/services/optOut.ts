// Descadastro — a obrigação mais dura desta plataforma.
//
// A mensagem de campanha diz "responda SAIR". Sem este módulo, ela mente:
// a pessoa responde, alguém lê depois, e a próxima onda sai assim mesmo.
//
// TRÊS DECISÕES QUE NÃO SÃO NEGOCIÁVEIS:
//
//   1. DETERMINÍSTICO, NÃO IA. A detecção é por palavra e por padrão de
//      texto, não por modelo. Um modelo indisponível, lento ou caro não
//      pode ser o motivo de um descadastro não ser atendido. A IA da Fase
//      4 pode CONFIRMAR um caso ambíguo, nunca ser a única porta.
//
//   2. ANTES DE TUDO. Roda antes de resumo, análise, triagem e resposta
//      automática. Quem pediu para sair não vira insumo de nada.
//
//   3. IRREVERSÍVEL PELA UI. Sai por aqui, não volta por reimportação
//      (routes/importacao.ts) nem por lista (routes/disparos.ts) nem no
//      instante do envio (jobs/disparador.ts). São quatro pontos de
//      bloqueio para a mesma pessoa, de propósito.

import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/**
 * A resposta que a pessoa recebe ao ser descadastrada.
 *
 * Curta, sem tentativa de reconquista e sem pergunta. Quem pediu para sair
 * não deve precisar responder de novo — uma mensagem que termina em
 * pergunta é mais uma mensagem que ela não pediu.
 */
export const CONFIRMACAO_OPT_OUT =
  'Pronto, você foi removido(a) da nossa lista e não receberá mais mensagens da campanha. Obrigado.';

/**
 * Palavras que, SOZINHAS na mensagem, são pedido de descadastro.
 *
 * A regra de "sozinhas" existe para "sair" não disparar dentro de "vou
 * sair de casa agora". Comparação já normalizada: minúscula, sem acento,
 * sem pontuação.
 */
const PALAVRAS_ISOLADAS = new Set([
  'sair',
  'saír',
  'pare',
  'parar',
  'para',
  'stop',
  'cancelar',
  'cancela',
  'descadastrar',
  'descadastro',
  'remover',
  'remove',
  'sai',
  'chega',
  'basta',
]);

/**
 * Frases que valem mesmo no meio de um texto maior, porque não têm outra
 * leitura possível. "para" sozinho é ambíguo; "para de mandar" não é.
 */
const FRASES = [
  /\bn[aã]o\s+quero\s+(mais\s+)?(receber|mensagen?s?|nada)/,
  /\bn[aã]o\s+me\s+(mande|manda|mandem|envie|envia|enviem)\s+mais/,
  /\bme\s+(tira|tire|tirem|remova|remove|removam)\s+(daqui|dai|da[ií]|dessa|desta|do)?\s*(lista|grupo)?/,
  /\bpar(a|e|em)\s+de\s+(me\s+)?(mandar|enviar|encher)/,
  /\bme\s+(descadastr\w+|desinscrev\w+|exclu\w+)/,
  /\bsai[ar]?\s+da\s+lista/,
  /\bcancelar?\s+(o\s+)?(cadastro|recebimento|envio)/,
  /\bn[aã]o\s+perturbe/,
  /\bpara\s+de\s+mandar/,
];

/** Minúscula, sem acento, sem pontuação, espaços colapsados. */
export function normalizarTexto(bruto: string): string {
  return (bruto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A mensagem é um pedido de descadastro?
 *
 * Conservador de propósito nos dois sentidos:
 *   · FALSO POSITIVO custa um eleitor removido por engano. Ele pode se
 *     recadastrar, e a plataforma tem o registro de por que saiu.
 *   · FALSO NEGATIVO custa uma pessoa que pediu para sair recebendo
 *     mensagem de novo — que é o dano que não tem desfazer.
 * Quando os dois erros não são simétricos, erra-se para o lado barato.
 */
export function ehPedidoDeDescadastro(texto: string | null | undefined): boolean {
  const t = normalizarTexto(texto ?? '');
  if (!t) return false;

  const palavras = t.split(' ');

  // Mensagem curta formada só por palavras de saída ("sair", "sair por
  // favor", "pare pare"). O teto de 3 palavras é o que separa isso de um
  // texto onde "para" é preposição.
  if (palavras.length <= 3) {
    const uteis = palavras.filter((p) => !['por', 'favor', 'pf', 'pfv', 'obrigado', 'obrigada'].includes(p));
    if (uteis.length && uteis.every((p) => PALAVRAS_ISOLADAS.has(p))) return true;
  }

  return FRASES.some((f) => f.test(t));
}

export interface ResultadoOptOut {
  aplicado: boolean;
  jaEstava?: boolean;
  clienteId?: string;
}

/**
 * Aplica o descadastro e cancela o que ainda estiver na fila para essa
 * pessoa.
 *
 * O cancelamento da fila é o que faz a diferença entre "não recebe mais a
 * partir da próxima campanha" e "não recebe mais". Sem ele, os alvos já
 * enfileirados continuariam pendentes — o worker os barraria no instante
 * do envio (jobs/disparador.ts), mas deixá-los pendentes esconderia o
 * tamanho real da fila de quem olha o painel.
 */
export async function aplicarDescadastro(
  clienteId: string,
  motivo: string,
): Promise<ResultadoOptOut> {
  const { data: cliente } = await supabaseAdmin
    .from('clientes')
    .select('id, opt_out_em')
    .eq('id', clienteId)
    .maybeSingle<{ id: string; opt_out_em: string | null }>();

  if (!cliente) return { aplicado: false };
  if (cliente.opt_out_em) return { aplicado: false, jaEstava: true, clienteId };

  const agora = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from('clientes')
    .update({ opt_out_em: agora, opt_out_motivo: motivo, situacao: 'opt_out' })
    .eq('id', clienteId);
  if (error) throw new Error(`falha ao registrar descadastro: ${error.message}`);

  // Tira da fila o que ainda não saiu.
  const { error: erroFila } = await supabaseAdmin
    .from('disparo_alvos')
    .update({ status: 'cancelado', erro: 'Descadastro pedido pelo destinatário.' })
    .eq('cliente_id', clienteId)
    .eq('status', 'pendente');
  if (erroFila) {
    // Não relança: o descadastro em si já está gravado, e é ele que barra o
    // envio no worker. Perder a limpeza da fila é cosmético perto disso.
    logger.error({ clienteId, err: erroFila.message }, 'descadastro gravado, mas a fila não foi limpa');
  }

  logger.warn({ clienteId, motivo }, 'eleitor descadastrado');
  return { aplicado: true, clienteId };
}

/**
 * O gancho do fluxo de mensagem recebida.
 *
 * Devolve `true` quando a mensagem ERA um pedido de descadastro — e nesse
 * caso quem chamou deve parar o processamento normal: não faz sentido
 * gerar resumo, análise de sentimento ou resposta automática para alguém
 * cuja última palavra foi "não me mande mais nada".
 *
 * Nunca lança: uma falha aqui não pode derrubar o processamento da
 * mensagem. Mas registra em nível de erro — descadastro não atendido é
 * incidente, não ruído.
 */
export async function tratarPossivelDescadastro(
  clienteId: string,
  texto: string | null | undefined,
): Promise<boolean> {
  try {
    if (!ehPedidoDeDescadastro(texto)) return false;
    const r = await aplicarDescadastro(clienteId, `Pediu pelo WhatsApp: "${(texto ?? '').slice(0, 120)}"`);
    return r.aplicado || !!r.jaEstava;
  } catch (err) {
    logger.error(
      { clienteId, err: err instanceof Error ? err.message : String(err) },
      'FALHA AO ATENDER PEDIDO DE DESCADASTRO — verificar manualmente',
    );
    return false;
  }
}
