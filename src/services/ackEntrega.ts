// Confirmação de entrega (ack) — estágio 5 da mecânica de disparo.
//
// POR QUE ESTE ARQUIVO EXISTE. Até 10/09/2026 o sistema não consumia ack
// nenhum do Baileys. A consequência (defeito D-04 do dossiê) é mais grave
// do que "falta um dado no painel":
//
//   `sendMessage()` para um JID que não existe NÃO FALHA. O WhatsApp
//   aceita, o Baileys devolve um `key.id`, e nós gravávamos
//   `status_entrega = 'enviada'` e `disparo_alvos.status = 'enviado'`.
//   Ou seja: o número que o painel da campanha mostrava como sucesso era
//   uma afirmação sobre NÓS ("o transporte aceitou"), nunca sobre a
//   pessoa do outro lado.
//
// O ack é a única evidência de que a mensagem chegou. Com ele, "enviado"
// volta a ser um estado intermediário honesto, e o painel passa a poder
// separar três coisas que antes eram uma só: saiu, chegou, e foi lida.
//
// ORDEM NÃO É GARANTIDA. Um ack de 'lida' pode chegar antes do 'entregue'
// que o precede logicamente, e o mesmo id pode ser confirmado várias
// vezes. Todo avanço aqui é monotônico: nunca regride.

import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';
import { atualizarStatusEntregaPorWaMessageId } from './mensagens.js';
import type { AckEntrega } from '../channels/port.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/**
 * Rank de avanço de `hub.disparo_alvos.status`.
 *
 * Espelha RANK_STATUS_ENTREGA de services/mensagens.ts, com o vocabulário
 * do alvo. Os estados terminais que NÃO vêm de ack (`cancelado`,
 * `sem_whatsapp`) recebem rank alto de propósito: um ack atrasado do
 * WhatsApp não pode ressuscitar como "entregue" um alvo que foi cancelado
 * por descadastro. Uma pessoa que pediu para sair não volta para a
 * contagem de sucesso da campanha por causa de um pacote fora de ordem.
 */
const RANK_STATUS_ALVO: Record<string, number> = {
  pendente: 0,
  enviando_agora: 1,
  enviado: 2,
  entrega_incerta: 2,
  entregue: 3,
  lido: 4,
  falhou: 8,
  sem_whatsapp: 9,
  cancelado: 9,
};

/** Vocabulário de hub.mensagens.status_entrega -> o do alvo. */
const STATUS_ALVO_POR_ACK: Record<AckEntrega['status'], string> = {
  enviada: 'enviado',
  entregue: 'entregue',
  lida: 'lido',
  falhou: 'falhou',
};

/**
 * Aplica um ack nas duas tabelas que registram a mesma mensagem.
 *
 * `hub.mensagens` é o fio da conversa (o que a equipe vê na Caixa);
 * `hub.disparo_alvos` é a fila da campanha (o que o painel conta). São
 * registros diferentes do mesmo fato e os dois precisam avançar — deixar
 * só um atualizado é como o sistema ficou incoerente consigo mesmo em
 * outros pontos do dossiê.
 *
 * Nunca lança: é chamado de dentro de um handler de socket, num processo
 * que segura todas as linhas de WhatsApp.
 */
export async function aplicarAckDeEntrega(ack: AckEntrega): Promise<void> {
  if (!ack.waMessageId) return;

  try {
    await atualizarStatusEntregaPorWaMessageId(ack.waMessageId, ack.status);
  } catch (err) {
    logger.error(
      { waMessageId: ack.waMessageId, err: err instanceof Error ? err.message : String(err) },
      'ack: falha ao atualizar hub.mensagens — o alvo do disparo ainda será tentado',
    );
  }

  try {
    await avancarAlvoDoDisparo(ack);
  } catch (err) {
    logger.error(
      { waMessageId: ack.waMessageId, err: err instanceof Error ? err.message : String(err) },
      'ack: falha ao atualizar hub.disparo_alvos',
    );
  }
}

async function avancarAlvoDoDisparo(ack: AckEntrega): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('disparo_alvos')
    .select('id, status')
    .eq('wa_message_id', ack.waMessageId);
  if (error) throw new Error(error.message);

  const linhas = (data ?? []) as Array<{ id: string; status: string }>;
  // O caso comum: a mensagem não veio de campanha (é atendimento 1:1) e
  // não há alvo nenhum. Não é erro.
  if (!linhas.length) return;

  const novo = STATUS_ALVO_POR_ACK[ack.status];
  const rankNovo = RANK_STATUS_ALVO[novo] ?? -1;

  for (const linha of linhas) {
    const rankAtual = RANK_STATUS_ALVO[linha.status] ?? -1;
    if (rankNovo <= rankAtual) continue;

    const { error: erroUpdate } = await supabaseAdmin
      .from('disparo_alvos')
      .update({ status: novo })
      .eq('id', linha.id);
    if (erroUpdate) throw new Error(erroUpdate.message);
  }
}

/**
 * Quanto tempo esperar o ack de entrega antes de admitir que não sabemos.
 *
 * Dez minutos é generoso: o aparelho do destinatário pode estar sem rede,
 * e o WhatsApp entrega o ack quando ele voltar. O ponto não é declarar
 * falha — é PARAR DE CONTAR COMO SUCESSO algo que nunca foi confirmado.
 */
const PRAZO_ACK_MS = 10 * 60_000;

/**
 * Marca como `entrega_incerta` o que saiu e nunca foi confirmado.
 *
 * A alternativa — deixar em `enviado` para sempre — é o que produzia o
 * relatório mentiroso: uma campanha inteira "enviada" com zero entregas
 * confirmadas parecia idêntica a uma campanha inteira entregue.
 *
 * `entrega_incerta` não é `falhou`: a mensagem pode ter chegado. É a
 * descrição honesta do que sabemos, e sai do numerador de sucesso do
 * painel.
 */
export async function marcarEntregasIncertas(agora = new Date()): Promise<number> {
  const limite = new Date(agora.getTime() - PRAZO_ACK_MS).toISOString();

  const { data, error } = await supabaseAdmin
    .from('disparo_alvos')
    .update({ status: 'entrega_incerta' })
    .eq('status', 'enviado')
    .lt('enviado_em', limite)
    .select('id');

  if (error) {
    logger.error({ err: error.message }, 'falha ao marcar entregas incertas');
    return 0;
  }
  const total = data?.length ?? 0;
  if (total) {
    logger.warn(
      { total },
      'alvos sem confirmação de entrega no prazo — marcados como entrega_incerta',
    );
  }
  return total;
}
