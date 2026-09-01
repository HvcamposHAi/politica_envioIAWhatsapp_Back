// registry.ts — Map<canal_id, sessão viva> (plano-base §5).
//
// "Uma sessão viva por linha, em memória — backend stateful, 1 instância.
// Não escalar horizontalmente sem sharding por canal_id." Este registry é
// exatamente esse estado — e por isso ele só faz sentido existindo uma
// vez por processo. Rotas e jobs falam com canais SÓ por aqui, nunca
// instanciando BaileysChannel/TwilioChannel diretamente.

import pino from 'pino';
import type { ChannelPort, EventoRecebido } from './port.js';
import { BaileysChannel } from './baileys.adapter.js';
import { TwilioChannel } from './twilio.adapter.js';
import { supabaseAdmin } from '../db/client.server.js';
import { processarEventoRecebido } from '../services/mensagens.js';
import { obterCredenciaisTwilio } from '../services/twilioCredenciais.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

const canaisAtivos = new Map<string, ChannelPort>();

export async function obterOuCriarCanal(canalId: string): Promise<ChannelPort> {
  const existente = canaisAtivos.get(canalId);
  if (existente) return existente;

  const { data, error } = await supabaseAdmin
    .from('canais')
    .select('id, transporte, numero')
    .eq('id', canalId)
    .single();

  if (error || !data) {
    throw new Error(`Canal ${canalId} não encontrado em hub.canais: ${error?.message ?? 'sem dados'}`);
  }

  const canal =
    data.transporte === 'twilio'
      ? new TwilioChannel(canalId, data.numero, await obterCredenciaisTwilio())
      : new BaileysChannel(canalId);
  // aoReceber é o único ponto de entrada de mensagem do lado do canal — sem
  // isto, o adapter recebe o evento e joga fora (era o estado antes desta
  // passada). Try/catch aqui, não dentro do handler: uma falha ao gravar
  // hub.mensagens não pode virar unhandledRejection e derrubar o processo
  // (Node 15+ mata o processo em promise rejeitada sem catch), o que
  // derrubaria TODAS as linhas Baileys ativas, não só esta mensagem.
  canal.aoReceber(async (evento: EventoRecebido) => {
    try {
      await processarEventoRecebido(canalId, evento);
    } catch (err) {
      // Estruturado (não só console.error) para ficar filtrável/alertável
      // no Cloud Logging — hoje é o único jeito de perceber esta falha,
      // não existe Sentry/APM no projeto. Mensagem perdida aqui é
      // silenciosa para o atendente: não há reentrega (diferente do
      // webhook da Twilio, que a WhatsApp Cloud API reenvia sozinha).
      logger.error(
        { canalId, waMessageId: evento.waMessageId, err: err instanceof Error ? err.message : String(err) },
        'falha ao processar mensagem recebida — mensagem perdida, sem reentrega',
      );
    }
  });
  canaisAtivos.set(canalId, canal);
  return canal;
}

export function canalEmMemoria(canalId: string): ChannelPort | undefined {
  return canaisAtivos.get(canalId);
}

export function removerCanal(canalId: string): void {
  canaisAtivos.delete(canalId);
}

/** Graceful shutdown (plano-base §4.4): fechar sockets antes de matar o
 *  processo, senão o WhatsApp marca desconexão suja. Chamar isto a
 *  partir do handler de SIGTERM em server.ts. */
export async function desconectarTodosOsCanais(): Promise<void> {
  // preservarSessao: true — isto é o processo saindo (deploy/restart do
  // Cloud Run), não o usuário clicando "Desconectar linha". Um logout de
  // verdade aqui desvincularia o aparelho a cada restart (causa raiz do
  // incidente 2026-08-07); ver port.ts para o contrato completo.
  const desconexoes = Array.from(canaisAtivos.values()).map((canal) =>
    canal.desconectar({ preservarSessao: true }).catch(() => undefined),
  );
  await Promise.all(desconexoes);
  canaisAtivos.clear();
}

/** Estados de `hub.canais.conexao_status` em que uma linha Baileys ainda é
 *  RECUPERÁVEL sem QR: a credencial em hub.canal_sessoes continua válida e
 *  só falta reabrir o socket.
 *
 *  'desconectado' fica de fora de propósito — é o estado que o usuário
 *  produz clicando em "Desligar linha", que faz `logout()` de protocolo e
 *  invalida a credencial. Reconectar isso sozinho seria desfazer uma ação
 *  explícita do admin e queimar ciclo de registro à toa.
 *
 *  'lendo_qr' também fica de fora: é uma linha esperando um humano na
 *  frente da tela, não uma sessão caída. */
const ESTADOS_RECUPERAVEIS = ['conectado', 'instavel', 'conectando'] as const;

/**
 * Canais Baileys que DEVERIAM estar de pé e têm credencial salva para isso.
 *
 * A guarda por `hub.canal_sessoes` não é detalhe: sem ela, um canal sem
 * credencial (cadastrado e nunca pareado, ou limpo por um 401 loggedOut)
 * entraria em ciclo de REGISTRO sozinho — no boot e a cada passada do vigia
 * —, que é exatamente o perfil de tráfego que faz o WhatsApp aplicar
 * limitação anti-abuso ("Connection Terminated" antes de qualquer QR, ver
 * MAXIMO_CICLOS_REGISTRO em baileys.adapter.ts). Quem não tem sessão salva
 * precisa de um humano lendo um QR, não de uma reconexão automática.
 */
export async function canaisRecuperaveis(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('canais')
    .select('id')
    .eq('transporte', 'baileys')
    .in('conexao_status', ESTADOS_RECUPERAVEIS as unknown as string[]);

  if (error) {
    logger.error({ err: error.message }, 'falha ao listar canais Baileys recuperáveis');
    return [];
  }
  const ids = (data ?? []).map((c) => c.id as string);
  if (!ids.length) return [];

  const { data: sessoes, error: erroSessoes } = await supabaseAdmin
    .from('canal_sessoes')
    .select('canal_id')
    .in('canal_id', ids);

  if (erroSessoes) {
    // Fail-closed: sem conseguir provar que há credencial, NÃO reconecta.
    // Tentar às cegas é o caminho para a limitação anti-abuso descrita acima.
    logger.error({ err: erroSessoes.message }, 'falha ao ler hub.canal_sessoes — nenhuma reconexão automática nesta passada');
    return [];
  }

  const comSessao = new Set((sessoes ?? []).map((s) => s.canal_id as string));
  const elegiveis = ids.filter((id) => comSessao.has(id));
  const semSessao = ids.length - elegiveis.length;
  if (semSessao > 0) {
    logger.warn({ semSessao }, 'canais recuperáveis SEM sessão salva — precisam de QR humano, não de reconexão automática');
  }
  return elegiveis;
}

/** Reconecta no boot os canais Baileys recuperáveis (ver
 *  ESTADOS_RECUPERAVEIS) que tinham sessão salva antes do processo cair.
 *  Causa raiz do incidente 2026-08-07 ("mensagens recebidas
 *  não aparecem"): a sessão do Baileys só existe no `canaisAtivos` acima —
 *  em memória, por processo — e nada em server.ts a repunha depois de um
 *  restart. Resultado: hub-api reiniciou 10x em ~18h (deploys do Cloud
 *  Run) e nenhuma dessas vezes reconectou sozinho; o WhatsApp seguia
 *  emitindo mensagens que nenhum processo mais escutava.
 *
 *  Assume 1 instância do serviço (mesmo pressuposto já documentado no
 *  topo deste arquivo) — rodar isto em mais de uma instância ao mesmo
 *  tempo tentaria abrir o mesmo número em paralelo, o que o WhatsApp
 *  responde derrubando ambas as sessões por conflito. Configurar
 *  min/max-instances=1 no Cloud Run deste serviço é pré-requisito
 *  operacional, não só uma otimização de custo. */
export async function reconectarCanaisAoSubir(): Promise<void> {
  // Reconciliação ANTES de qualquer coisa: neste instante, por definição,
  // nenhum canal está conectado NESTE processo — o Map acima está vazio. Um
  // canal gravado como 'conectado' aqui é resíduo de um processo anterior
  // que morreu sujo (SIGKILL/OOM, sem passar pelo shutdown gracioso), e
  // deixá-lo assim faz a tela afirmar "conectado há 18h" sobre uma sessão
  // que não existe — exatamente o que mascarou o incidente 2026-08-07.
  const { error: erroReconciliacao } = await supabaseAdmin
    .from('canais')
    .update({ conexao_status: 'instavel' })
    .eq('transporte', 'baileys')
    .eq('conexao_status', 'conectado');
  if (erroReconciliacao) {
    logger.error({ err: erroReconciliacao.message }, 'falha ao reconciliar conexao_status no boot');
  }

  const ids = await canaisRecuperaveis();
  if (!ids.length) return;

  logger.info({ total: ids.length }, 'reconectando canais Baileys que estavam ativos antes do restart');

  for (const id of ids) {
    try {
      const canal = await obterOuCriarCanal(id);
      await canal.conectar();
    } catch (err) {
      logger.error(
        { canalId: id, err: err instanceof Error ? err.message : String(err) },
        'falha ao reconectar canal no boot — segue tentando os demais',
      );
    }
  }
}
