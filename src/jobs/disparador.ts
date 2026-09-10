// O worker de disparo — Fase 3 do PLANO_CAMPANHA_INDIARA.md.
//
// POR QUE FILA EM PROCESSO, e não worker separado: este serviço já roda em
// UMA instância permanente e sempre acordada (render.yaml: plan starter,
// numInstances 1), porque ele segura os WebSockets do WhatsApp. É
// exatamente o ambiente que uma fila precisa, e é o mesmo processo que tem
// o socket na mão — mandar por outro processo exigiria um protocolo entre
// os dois para nada.
//
// "Uma instância" NÃO é garantido pela configuração do Render: o deploy
// sobrepõe a nova com a velha por alguns segundos. Quem garante é a posse
// do gateway (jobs/lease.ts), consultada na primeira linha da passada. O
// índice único (disparo_id, telefone) e o trigger de teto no banco são a
// terceira camada, para o dia em que alguém mexer nisso.
//
// O QUE ESTE JOB NUNCA FAZ:
//   · não envia fora da janela horária;
//   · não envia com o canal fora do ar;
//   · não envia para quem está em opt-out — reconferido NO INSTANTE do
//     envio, não só quando o alvo entrou na fila (a pessoa pode ter pedido
//     descadastro entre uma coisa e outra, e é justamente aí que o erro
//     dói);
//   · não lança. Exceção que escape daqui vira unhandledRejection dentro de
//     um timer, num processo que segura todas as linhas de WhatsApp.

import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';
import { canalEmMemoria, obterOuCriarCanal } from '../channels/registry.js';
import type { ChannelPort } from '../channels/port.js';
import { souODonoDoGateway } from './lease.js';
import { marcarEntregasIncertas } from '../services/ackEntrega.js';
import {
  aplicarCampos,
  avaliarPausaAutomatica,
  decidir,
  dentroDaJanela,
  diaNaCampanha,
  diasDeVidaDaLinha,
  proximoIntervaloMs,
  tempoDigitandoMs,
  type LimiaresPausa,
  type RitmoConfig,
} from '../services/ritmoDisparo.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/** De quanto em quanto tempo o worker acorda. Bem menor que o menor
 *  intervalo entre mensagens: o tick só CONFERE se já é hora; quem
 *  espaça os envios é o agendamento por disparo. */
export const TICK_MS = 5_000;

/** Janela recente para calcular taxa de falha e de opt-out. */
const JANELA_PAUSA_MIN = 30;

/**
 * De quanto em quanto tempo registrar que o worker está vivo.
 *
 * NÃO É RUÍDO DE LOG — é a lacuna que custou a investigação de 10/09/2026.
 * A campanha de 04/09 passou 56 minutos com janela aberta, canal
 * conectado, posse renovada e fila cheia, sem enviar nada e SEM DEIXAR
 * RASTRO NENHUM: `passadaDoDisparador` retornava na primeira linha
 * (interruptor desligado) em silêncio absoluto. Um worker parado de
 * propósito era indistinguível de um worker morto, e essa diferença só
 * apareceu depois de reconstruir a linha do tempo a partir do banco.
 *
 * Uma linha a cada 5 minutos é barata e transforma a próxima investigação
 * de horas em minutos.
 */
const BATIMENTO_MS = 5 * 60_000;
let ultimoBatimento = 0;

/** Motivos de pausa que o código entende (hub.disparos.pausa_codigo).
 *  Só `linha_caiu` é elegível a retomada automática — ver retomarOQueCaiu. */
export type PausaCodigo =
  | 'linha_caiu'
  | 'sem_canal'
  | 'taxa_de_optout'
  | 'taxa_de_falha'
  | 'parada_manual'
  | 'parada_geral';

/** Quanto tempo o canal precisa estar de pé antes de uma campanha pausada
 *  por queda de linha voltar sozinha. Ver retomarOQueCaiu. */
const ESTABILIDADE_PARA_RETOMAR_MS = 60_000;

/** A cada quantas passadas rodar a manutenção (reservas presas, entregas
 *  não confirmadas). 60 passadas de 5s = 5 minutos. */
const PASSADAS_POR_MANUTENCAO = 60;
let passadasDesdeManutencao = 0;

function limiares(): LimiaresPausa {
  return {
    falhaPct: Number(process.env.DISPARO_LIMIAR_FALHA_PCT ?? 15),
    optOutPct: Number(process.env.DISPARO_LIMIAR_OPTOUT_PCT ?? 5),
    amostraMinima: Number(process.env.DISPARO_AMOSTRA_MINIMA ?? 20),
  };
}

function rampaDoAmbiente(): number[] {
  return String(process.env.DISPARO_RAMPA ?? '40,80,150,250,400')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Interruptor geral, em memória.
 *
 * `DISPARO_ATIVO=false` no ambiente desliga sem redeploy. `pararTudo()`
 * desliga em runtime, pelo botão do painel. Os dois são conferidos ANTES
 * de qualquer coisa na passada — é o que faz o botão ter efeito no próximo
 * tick, e não no próximo deploy.
 */
const interruptorGeral = String(process.env.DISPARO_ATIVO ?? 'true') !== 'false';

/**
 * A chave-geral do PROCESSO. Vem só do ambiente e não muda em runtime.
 *
 * O interruptor que o painel opera é outro, e vive no banco por empresa
 * (hub.empresas.disparo_ativo) — ver disparoHabilitado(). A separação é o
 * conserto de D-13: até 10/09/2026 o botão da tela mexia numa variável em
 * memória, então todo deploy devolvia o estado ao default do ambiente sem
 * ninguém perceber. "Parar tudo" clicado às 18h não sobrevivia ao deploy
 * das 19h.
 */
export function processoPodeDisparar(): boolean {
  return interruptorGeral;
}

/**
 * O envio está ligado para esta empresa?
 *
 * As duas condições precisam valer: a chave-geral do processo
 * (DISPARO_ATIVO) e o interruptor da empresa, persistido no banco.
 */
export async function disparoHabilitado(empresaId: string): Promise<boolean> {
  if (!interruptorGeral) return false;
  const { data } = await supabaseAdmin
    .from('empresas')
    .select('disparo_ativo')
    .eq('id', empresaId)
    .maybeSingle<{ disparo_ativo: boolean }>();
  return data?.disparo_ativo === true;
}

/** Religa o envio DESTA empresa. Não retoma campanha nenhuma: cada uma
 *  precisa ser retomada de propósito, uma a uma. */
export async function religarDisparos(empresaId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('empresas')
    .update({ disparo_ativo: true })
    .eq('id', empresaId);
  if (error) throw new Error(`falha ao religar o envio: ${error.message}`);
  logger.warn({ empresaId }, 'envio religado para a empresa');
}

/**
 * Para tudo: desliga o interruptor da empresa E pausa no banco os disparos
 * dela que estavam enviando. Os dois, de propósito — só o interruptor não
 * interromperia a passada em andamento, e só a pausa deixaria a próxima
 * campanha criada sair sozinha.
 *
 * ESCOPADO POR EMPRESA (D-07). Até 10/09/2026 o `update` não tinha filtro
 * de empresa nenhum, apesar de a rota já ter validado `ctx.empresaId` na
 * linha de cima: um admin da empresa A parava as campanhas da empresa B.
 */
export async function pararTudo(empresaId: string, motivo: string): Promise<number> {
  const { error: erroInterruptor } = await supabaseAdmin
    .from('empresas')
    .update({ disparo_ativo: false })
    .eq('id', empresaId);
  if (erroInterruptor) {
    // Sem interruptor desligado, pausar as campanhas não basta — a próxima
    // criada sairia. Falhar alto é melhor que um "parado" que não parou.
    throw new Error(`falha ao desligar o envio: ${erroInterruptor.message}`);
  }

  const { data, error } = await supabaseAdmin
    .from('disparos')
    .update({ pausado_em: new Date().toISOString(), pausa_motivo: motivo, pausa_codigo: 'parada_geral' })
    .eq('empresa_id', empresaId)
    .eq('status', 'enviando')
    .is('pausado_em', null)
    .select('id');
  if (error) {
    logger.error(
      { empresaId, err: error.message },
      'pararTudo: interruptor desligado, mas as campanhas não foram pausadas',
    );
    return 0;
  }
  logger.warn({ empresaId, motivo, pausados: data?.length ?? 0 }, 'PARAR TUDO acionado');
  return data?.length ?? 0;
}

/** Quando cada disparo pode mandar a próxima. Em memória de propósito: um
 *  restart no meio da campanha faz um envio sair imediatamente, e isso é
 *  preferível a gravar um agendamento por mensagem no banco. */
const proximoEnvioEm = new Map<string, number>();

interface DisparoRow {
  id: string;
  empresa_id: string;
  canal_id: string | null;
  status: string;
  pausado_em: string | null;
  texto_base: string | null;
  janela_inicio: string;
  janela_fim: string;
  intervalo_min_seg: number;
  intervalo_max_seg: number;
  teto_diario: number | null;
  enviados_hoje: number;
  contador_dia: string | null;
  amostra_aprovada_em: string | null;
}

interface AlvoRow {
  id: string;
  telefone: string;
  cliente_id: string | null;
  texto_gerado: string | null;
  tentativas: number;
}

interface ClienteRow {
  id: string;
  nome: string;
  telefone: string;
  bairro: string | null;
  cidade: string | null;
  situacao: string;
  opt_out_em: string | null;
  wa_jid: string | null;
}

export interface ResultadoPassada {
  avaliados: number;
  enviados: number;
  pulados: Record<string, number>;
  pausados: number;
}

/**
 * Uma passada. Exportada para teste — o `setInterval` só a chama.
 *
 * Manda NO MÁXIMO uma mensagem por disparo por passada. Não é limitação
 * técnica: é o que garante que o intervalo configurado seja respeitado
 * mesmo se um tick atrasar e dois vencerem juntos.
 */
export async function passadaDoDisparador(agora = new Date()): Promise<ResultadoPassada> {
  const resultado: ResultadoPassada = { avaliados: 0, enviados: 0, pulados: {}, pausados: 0 };

  const dono = souODonoDoGateway();

  // BATIMENTO. Registrado ANTES de qualquer decisão de sair, justamente
  // para cobrir os casos em que o worker não faz nada — que era o cenário
  // sem rastro nenhum do incidente de 04/09. Ver BATIMENTO_MS.
  if (agora.getTime() - ultimoBatimento >= BATIMENTO_MS) {
    ultimoBatimento = agora.getTime();
    logger.warn(
      {
        habilitado: interruptorGeral,
        souDono: dono,
        motivo: !interruptorGeral
          ? 'DISPARO_ATIVO=false ou "parar tudo" acionado — nenhuma mensagem sai'
          : !dono
            ? 'outra instância detém a posse do gateway — worker em espera'
            : 'operando',
      },
      'disparador: batimento',
    );
  }

  if (!interruptorGeral) return resultado;
  // Dois processos tirando alvos da mesma fila mandariam a mesma mensagem
  // duas vezes para a mesma pessoa. O índice único (disparo_id, telefone)
  // barra a duplicata no banco, mas só DEPOIS de a mensagem ter saído —
  // esta guarda é a que impede o envio. Ver jobs/lease.ts.
  if (!dono) return resultado;

  // Manutenção periódica: devolver à fila alvos presos por um processo que
  // morreu no meio, e parar de contar como sucesso o que saiu e nunca foi
  // confirmado. As duas coisas corrigem estado, não enviam nada.
  if (++passadasDesdeManutencao >= PASSADAS_POR_MANUTENCAO) {
    passadasDesdeManutencao = 0;
    await rodarManutencao(agora);
  }

  // Retomada governada ANTES de avaliar as campanhas ativas: uma campanha
  // que volta nesta passada já pode enviar nela mesma.
  await retomarOQueCaiu(agora);

  try {
    const { data: disparos, error } = await supabaseAdmin
      .from('disparos')
      .select(
        'id, empresa_id, canal_id, status, pausado_em, texto_base, janela_inicio, janela_fim, ' +
          'intervalo_min_seg, intervalo_max_seg, teto_diario, enviados_hoje, contador_dia, ' +
          // !inner: a empresa entra como JOIN obrigatório só para filtrar
          // pelo interruptor dela. Campanha de empresa com o envio
          // desligado nem é lida — é o "Parar tudo" tendo efeito no
          // próximo tick, agora sobrevivendo a restart (D-13).
          'amostra_aprovada_em, empresas!inner(disparo_ativo)',
      )
      .eq('status', 'enviando')
      .eq('empresas.disparo_ativo', true)
      .is('pausado_em', null);

    if (error) throw new Error(error.message);

    // `db/types.ts` e gerado por `supabase gen types` e ainda descreve o
    // schema anterior a Fase 1 — as colunas de ritmo nao existem la, entao
    // o supabase-js nao consegue inferir a linha. Ver docs/divida-tecnica.md:
    // o cast sai quando os tipos forem regerados contra o banco da campanha.
    for (const disparo of (disparos ?? []) as unknown as DisparoRow[]) {
      resultado.avaliados += 1;
      try {
        const passo = await processarUmDisparo(disparo, agora);
        if (passo === 'enviado') resultado.enviados += 1;
        else if (passo === 'pausado') resultado.pausados += 1;
        else resultado.pulados[passo] = (resultado.pulados[passo] ?? 0) + 1;
      } catch (err) {
        // Um disparo doente não pode parar os outros.
        logger.error(
          { disparoId: disparo.id, err: err instanceof Error ? err.message : String(err) },
          'disparador: falha ao processar disparo — segue para o próximo',
        );
      }
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'disparador: passada falhou por inteiro — próxima passada tenta de novo',
    );
  }
  return resultado;
}

/**
 * Manutenção de estado. Não envia nada; conserta o que ficou torto.
 *
 * Duas varreduras, as duas nascidas de "o processo pode morrer a qualquer
 * momento e todo deploy é um restart":
 *
 *   · alvo reservado por uma instância que morreu antes de enviar fica em
 *     `enviando_agora` para sempre — some da fila sem ter recebido nada;
 *   · alvo que saiu e nunca teve ack não pode continuar contando como
 *     sucesso no painel (ver services/ackEntrega.ts).
 */
async function rodarManutencao(agora: Date): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.rpc('liberar_alvos_travados', { p_minutos: 2 });
    if (error) throw new Error(error.message);
    if (typeof data === 'number' && data > 0) {
      logger.warn({ devolvidos: data }, 'alvos presos em enviando_agora devolvidos à fila');
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'manutenção: falha ao liberar alvos travados',
    );
  }

  try {
    await marcarEntregasIncertas(agora);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'manutenção: falha ao marcar entregas incertas',
    );
  }
}

/**
 * Retomada automática — e SÓ de quem caiu por queda de linha (estágio 7).
 *
 * A regra antiga ("quem religa o disparo é gente") é defensável e continua
 * valendo para tudo que envolve a pessoa do outro lado: opt-out alto, taxa
 * de falha alta e parada manual seguem exigindo decisão humana, sempre.
 *
 * O que ela não previa é a queda que não é incidente: em 04/09 a linha caiu
 * por hibernação da hospedagem e voltou em NOVE SEGUNDOS — e as duas
 * campanhas ficaram paradas para sempre, sem ninguém saber. Exigir gente
 * para desfazer um problema que já se desfez sozinho não protege ninguém;
 * só transforma toda instabilidade transitória em campanha morta.
 *
 * Daí `pausa_codigo` ser um valor fechado: sem ele não havia como
 * distinguir por código "caiu sozinha" de "mandaram parar", e retomar às
 * cegas seria muito pior que não retomar.
 */
async function retomarOQueCaiu(agora: Date): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from('disparos')
      .select('id, canal_id, janela_inicio, janela_fim, empresas!inner(disparo_ativo)')
      .eq('status', 'enviando')
      .eq('pausa_codigo', 'linha_caiu')
      // Empresa com o envio desligado não tem campanha retomada por
      // ninguém, muito menos automaticamente.
      .eq('empresas.disparo_ativo', true)
      .not('pausado_em', 'is', null);
    if (error) throw new Error(error.message);

    type Linha = { id: string; canal_id: string | null; janela_inicio: string; janela_fim: string };
    for (const disparo of (data ?? []) as unknown as Linha[]) {
      if (!disparo.canal_id) continue;

      // Fora da janela não há por que retomar agora — a próxima passada
      // dentro do horário retoma, e retomar fora dela deixaria a campanha
      // "ativa" à noite só para ser barrada a cada tick.
      if (!dentroDaJanela(agora, disparo.janela_inicio, disparo.janela_fim)) continue;

      // O banco dizer 'conectado' não basta: o socket pode ter aberto há
      // dois segundos. `prontoParaCampanha()` é o aquecimento do estágio 2.
      if (!(await canalConectado(disparo.canal_id))) continue;
      const canal = canalEmMemoria(disparo.canal_id);
      if (!canal) continue;
      if (canal.prontoParaCampanha && !canal.prontoParaCampanha()) continue;

      const desde = await estavelDesde(disparo.canal_id);
      if (!desde || agora.getTime() - desde.getTime() < ESTABILIDADE_PARA_RETOMAR_MS) continue;

      await supabaseAdmin
        .from('disparos')
        .update({ pausado_em: null, pausa_motivo: null, pausa_codigo: null })
        .eq('id', disparo.id)
        // Só retoma se AINDA estiver pausada por queda de linha. Entre a
        // leitura e este update alguém pode ter clicado "Parar tudo", e a
        // decisão humana vence sempre.
        .eq('pausa_codigo', 'linha_caiu');

      logger.warn(
        { disparoId: disparo.id, canalId: disparo.canal_id },
        'campanha retomada automaticamente: a linha voltou e está estável',
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'falha na retomada automática — campanhas seguem pausadas, que é o lado seguro',
    );
  }
}

/** Desde quando o canal está conectado, segundo o banco. */
async function estavelDesde(canalId: string): Promise<Date | null> {
  const { data } = await supabaseAdmin
    .from('canais')
    .select('ultima_conexao')
    .eq('id', canalId)
    .maybeSingle<{ ultima_conexao: string | null }>();
  return data?.ultima_conexao ? new Date(data.ultima_conexao) : null;
}

async function processarUmDisparo(disparo: DisparoRow, agora: Date): Promise<string> {
  const agendado = proximoEnvioEm.get(disparo.id);
  if (agendado !== undefined && agora.getTime() < agendado) return 'aguardando_intervalo';

  if (!disparo.canal_id) {
    await pausar(disparo.id, 'sem_canal', 'Disparo sem canal escolhido.');
    return 'pausado';
  }

  // Freio automático ANTES de decidir enviar: se a campanha está fazendo
  // gente pedir descadastro, a próxima mensagem é a que não deveria sair.
  const janela = await medirJanelaRecente(disparo.id, agora);
  const motivoPausa = avaliarPausaAutomatica(janela, limiares());
  if (motivoPausa) {
    await pausar(
      disparo.id,
      motivoPausa,
      motivoPausa === 'taxa_de_optout'
        ? `Pausado automaticamente: ${janela.optOuts} descadastro(s) nos últimos ${janela.enviados} envios.`
        : `Pausado automaticamente: ${janela.falhas} falha(s) nos últimos ${janela.enviados} envios.`,
    );
    return 'pausado';
  }

  const [pendentes, canalOk, diasDeVida] = await Promise.all([
    contarPendentes(disparo.id),
    canalConectado(disparo.canal_id),
    idadeDaLinha(disparo.canal_id, agora),
  ]);

  const config: RitmoConfig = {
    janelaInicio: disparo.janela_inicio,
    janelaFim: disparo.janela_fim,
    intervaloMinSeg: disparo.intervalo_min_seg,
    intervaloMaxSeg: disparo.intervalo_max_seg,
    rampa: rampaDoAmbiente(),
    tetoDiario: disparo.teto_diario,
  };

  const decisao = decidir(
    {
      status: disparo.status,
      pausadoEm: disparo.pausado_em,
      enviadosHoje: disparo.enviados_hoje,
      contadorDia: disparo.contador_dia,
      pendentes,
      canalConectado: canalOk,
      diasDeVidaDaLinha: diasDeVida,
    },
    config,
    agora,
  );

  if (!decisao.enviar) {
    if (decisao.motivo === 'sem_pendentes') {
      await supabaseAdmin
        .from('disparos')
        .update({ status: 'concluido', concluido_em: agora.toISOString() })
        .eq('id', disparo.id);
      proximoEnvioEm.delete(disparo.id);
      return 'concluido';
    }
    if (decisao.motivo === 'canal_desconectado') {
      // Pausa de verdade, não só "pula": senão a campanha fica em silêncio
      // e ninguém sabe por quê. O vigia de canais reconecta; a campanha
      // volta por retomarOQueCaiu() — e SÓ ela, porque só esta pausa
      // carrega o código 'linha_caiu'. Toda outra continua esperando gente.
      await pausar(disparo.id, 'linha_caiu', 'Pausado automaticamente: a linha de WhatsApp caiu.');
      return 'pausado';
    }
    return decisao.motivo;
  }

  // AQUECIMENTO DA LINHA (estágio 2). Depois de `decidir`, de propósito:
  // não é uma condição de parada da campanha, é um "ainda não, espera o
  // socket assentar". O socket abre antes de a sessão estar utilizável, e
  // a reconexão automática é justamente quando o worker acorda com a fila
  // cheia na mão. Atendimento 1:1 não passa por aqui.
  const canalVivo = canalEmMemoria(disparo.canal_id);
  if (canalVivo?.prontoParaCampanha && !canalVivo.prontoParaCampanha()) {
    return 'aquecendo_linha';
  }

  const enviou = await enviarProximo(disparo, agora);

  // Reagenda em qualquer caso. Falha de envio não pode virar laço apertado
  // contra o WhatsApp — é o padrão de tráfego que mais parece abuso.
  proximoEnvioEm.set(
    disparo.id,
    agora.getTime() + proximoIntervaloMs(disparo.intervalo_min_seg, disparo.intervalo_max_seg, Math.random()),
  );

  return enviou;
}

async function contarPendentes(disparoId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('disparo_alvos')
    .select('id', { count: 'exact', head: true })
    .eq('disparo_id', disparoId)
    // `enviando_agora` conta como pendente: é alvo reservado que ainda não
    // saiu. Sem ele aqui, uma campanha cujo último alvo está reservado
    // seria declarada CONCLUÍDA antes de a mensagem sair — e a conclusão
    // é irreversível pela tela.
    .in('status', ['pendente', 'enviando_agora']);
  if (error) throw new Error(`falha ao contar pendentes: ${error.message}`);
  return count ?? 0;
}

async function canalConectado(canalId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('canais')
    .select('conexao_status')
    .eq('id', canalId)
    .maybeSingle<{ conexao_status: string | null }>();
  if (error) throw new Error(`falha ao ler o canal: ${error.message}`);
  return data?.conexao_status === 'conectado';
}

async function idadeDaLinha(canalId: string, agora: Date): Promise<number> {
  const { data } = await supabaseAdmin
    .from('canais')
    .select('criado_em, ultima_conexao')
    .eq('id', canalId)
    .maybeSingle<{ criado_em: string | null; ultima_conexao: string | null }>();
  const nascimento = data?.criado_em ?? null;
  return diasDeVidaDaLinha(nascimento ? new Date(nascimento) : null, agora);
}

/**
 * Status de alvo que representam UMA TENTATIVA DE ENVIO.
 *
 * O denominador do freio automático são as mensagens que de fato saíram.
 * `cancelado` (descadastrou antes do envio) e `sem_whatsapp` (o pré-voo
 * barrou) nunca foram tentativa, e contá-los inflava o denominador —
 * diluindo a taxa de falha para baixo e adiando exatamente a pausa que o
 * freio existe para provocar.
 */
const STATUS_DE_TENTATIVA = new Set([
  'enviado',
  'entregue',
  'lido',
  'entrega_incerta',
  'falhou',
]);

async function medirJanelaRecente(
  disparoId: string,
  agora: Date,
): Promise<{ enviados: number; falhas: number; optOuts: number }> {
  const desdeMs = agora.getTime() - JANELA_PAUSA_MIN * 60_000;
  const desde = new Date(desdeMs).toISOString();

  const { data, error } = await supabaseAdmin
    .from('disparo_alvos')
    .select('status, cliente_id, clientes(opt_out_em)')
    .eq('disparo_id', disparoId)
    .gte('enviado_em', desde);
  if (error) throw new Error(`falha ao medir a janela: ${error.message}`);

  type Linha = { status: string; clientes: { opt_out_em: string | null } | null };
  const linhas = ((data ?? []) as unknown as Linha[]).filter((l) => STATUS_DE_TENTATIVA.has(l.status));

  return {
    enviados: linhas.length,
    falhas: linhas.filter((l) => l.status === 'falhou').length,
    // COMPARAR INSTANTES, NÃO TEXTO. Até 10/09/2026 isto era
    // `l.clientes.opt_out_em >= desde` — comparação lexicográfica entre
    // "2026-09-04T22:56:23.339+00:00" (grafia do PostgREST) e
    // "2026-09-04T22:56:23.339Z" (grafia do toISOString). São o mesmo
    // instante escrito de dois jeitos, e o `>=` de string não sabe disso:
    // o freio de descadastro — descrito neste próprio arquivo como a
    // medida mais importante da campanha — não era confiável (D-08).
    optOuts: linhas.filter((l) => {
      const t = l.clientes?.opt_out_em ? Date.parse(l.clientes.opt_out_em) : NaN;
      return Number.isFinite(t) && t >= desdeMs;
    }).length,
  };
}

async function pausar(disparoId: string, codigo: PausaCodigo, motivo: string): Promise<void> {
  await supabaseAdmin
    .from('disparos')
    .update({ pausado_em: new Date().toISOString(), pausa_motivo: motivo, pausa_codigo: codigo })
    .eq('id', disparoId);
  proximoEnvioEm.delete(disparoId);
  logger.warn({ disparoId, codigo, motivo }, 'disparo pausado automaticamente');
}

/** Primeiro nome, para o texto soar como gente. "MARIA DAS GRAÇAS SILVA"
 *  vira "Maria" — planilha de campanha vem em caixa alta com frequência. */
export function primeiroNome(nomeCompleto: string): string {
  const primeiro = nomeCompleto.trim().split(/\s+/)[0] ?? '';
  if (!primeiro) return '';
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

/**
 * Garante um JID canônico para este eleitor, resolvendo se preciso.
 *
 * ESTA É A CORREÇÃO DE D-03, e ela mora aqui — no caminho do envio — de
 * propósito, além de existir no pré-voo da rota. A razão é que o modo de
 * falha é silencioso: `sendMessage()` para um JID inexistente devolve um
 * `key.id` normalmente e a mensagem some. Depender de alguém ter clicado
 * "verificar" antes seria deixar a falha silenciosa a uma distração de
 * distância.
 *
 * Custo real: uma consulta por eleitor, UMA VEZ NA VIDA — o resultado vai
 * para hub.clientes.wa_jid e nunca mais é reconsultado.
 *
 * Devolve `undefined` quando não foi possível verificar (rede, rate
 * limit), que é diferente de `null` (verificado e não tem WhatsApp).
 */
async function resolverJid(
  canal: ChannelPort,
  cliente: ClienteRow,
): Promise<string | null | undefined> {
  if (cliente.wa_jid) return cliente.wa_jid;
  if (!canal.verificarNoWhatsApp) return undefined;

  const mapa = await canal.verificarNoWhatsApp([cliente.telefone]);
  const digitos = cliente.telefone.replace(/\D/g, '');
  if (!mapa.has(digitos)) return undefined; // não deu para verificar

  const jid = mapa.get(digitos) ?? null;
  if (jid) {
    await supabaseAdmin.from('clientes').update({ wa_jid: jid }).eq('id', cliente.id);
  }
  return jid;
}

async function enviarProximo(disparo: DisparoRow, agora: Date): Promise<string> {
  // RESERVA ATÔMICA (D-11). Antes disto era `select ... limit 1` e o
  // `update` só acontecia depois do envio — segundos depois. Nessa janela
  // um segundo processo lia o MESMO alvo, e o índice único só barra a
  // duplicata depois de a mensagem ter saído. A RPC usa
  // `FOR UPDATE SKIP LOCKED`: duas instâncias simultâneas recebem alvos
  // diferentes, nenhuma espera a outra.
  const { data: reservados, error: erroAlvo } = await supabaseAdmin.rpc('reservar_proximo_alvo', {
    p_disparo_id: disparo.id,
  });
  if (erroAlvo) throw new Error(`falha ao reservar o próximo alvo: ${erroAlvo.message}`);

  const alvo = ((reservados ?? []) as unknown as AlvoRow[])[0];
  if (!alvo) return 'sem_pendentes';

  if (!alvo.cliente_id) {
    await marcarAlvo(alvo.id, 'falhou', null, 'Alvo sem cadastro de eleitor vinculado.');
    return 'alvo_sem_cliente';
  }

  const { data: cliente } = await supabaseAdmin
    .from('clientes')
    .select('id, nome, telefone, bairro, cidade, situacao, opt_out_em, wa_jid')
    .eq('id', alvo.cliente_id)
    .maybeSingle<ClienteRow>();

  if (!cliente) {
    await marcarAlvo(alvo.id, 'falhou', null, 'Eleitor não encontrado no cadastro.');
    return 'cliente_ausente';
  }

  // A RECONFERÊNCIA QUE MAIS IMPORTA. O trigger do banco barra o alvo na
  // hora de entrar na fila; entre aquele instante e este, a pessoa pode ter
  // respondido "PARE". Ela pediu para sair enquanto a fila andava — mandar
  // assim mesmo é o pior erro que esta plataforma pode cometer.
  if (cliente.opt_out_em || cliente.situacao !== 'ativo') {
    await marcarAlvo(alvo.id, 'cancelado', null, `Descadastrado antes do envio (situação: ${cliente.situacao}).`);
    return 'cancelado_por_opt_out';
  }

  const texto =
    alvo.texto_gerado ??
    aplicarCampos(disparo.texto_base ?? '', {
      nome: cliente.nome,
      primeiro_nome: primeiroNome(cliente.nome),
      bairro: cliente.bairro,
      cidade: cliente.cidade,
    });

  if (!texto.trim()) {
    await marcarAlvo(alvo.id, 'falhou', null, 'Texto vazio depois da substituição de campos.');
    return 'texto_vazio';
  }

  const canal = canalEmMemoria(disparo.canal_id!) ?? (await obterOuCriarCanal(disparo.canal_id!));

  // O JID canônico é PRÉ-REQUISITO do envio de campanha, não uma
  // otimização — ver resolverJid e o defeito D-03. Um alvo sem JID
  // resolvido não é enviado por número reconstruído: preferimos não
  // mandar a mandar para o vazio contando como sucesso.
  const jid = await resolverJid(canal, cliente);

  if (jid === null) {
    await marcarAlvo(
      alvo.id,
      'sem_whatsapp',
      null,
      'Número não está registrado no WhatsApp (verificado no envio).',
      alvo.tentativas + 1,
    );
    return 'sem_whatsapp';
  }

  if (jid === undefined) {
    // NÃO SEI ≠ NÃO TEM. Devolve para a fila e tenta na próxima passada:
    // marcar como sem_whatsapp aqui excluiria da campanha, para sempre,
    // alguém que só teve o azar de uma falha de rede.
    await supabaseAdmin
      .from('disparo_alvos')
      .update({ status: 'pendente', reservado_em: null })
      .eq('id', alvo.id);
    return 'jid_nao_verificado';
  }

  // "Digitando…" antes de mandar. O ChannelPort expõe isso como opcional —
  // transporte que não tem o conceito simplesmente não implementa.
  if (canal.sinalizarDigitando) {
    try {
      await canal.sinalizarDigitando(cliente.telefone, tempoDigitandoMs(texto), jid);
    } catch {
      // Presença é cosmética. Falhar aqui não pode impedir a mensagem.
    }
  }

  const envio = await canal.enviar({
    conversaId: '',
    telefone: cliente.telefone,
    texto,
    waJidDestino: jid,
  });

  const conversaId = await garantirConversa(disparo, cliente, agora);

  await supabaseAdmin.from('mensagens').insert({
    conversa_id: conversaId,
    wa_message_id: envio.waMessageId || null,
    autor: 'atendente',
    direcao: 'saida',
    texto,
    status_entrega: envio.status === 'enviada' ? 'enviada' : 'falhou',
    erro: envio.erro ?? null,
    criada_em: agora.toISOString(),
  });

  await marcarAlvo(
    alvo.id,
    envio.status === 'enviada' ? 'enviado' : 'falhou',
    envio.waMessageId || null,
    envio.erro ?? null,
    alvo.tentativas + 1,
  );

  return envio.status === 'enviada' ? 'enviado' : 'falha_de_envio';
}

async function marcarAlvo(
  alvoId: string,
  status: string,
  waMessageId: string | null,
  erro: string | null,
  tentativas?: number,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    wa_message_id: waMessageId,
    erro,
    enviado_em: new Date().toISOString(),
  };
  if (tentativas !== undefined) patch.tentativas = tentativas;
  await supabaseAdmin.from('disparo_alvos').update(patch).eq('id', alvoId);
}

/**
 * A conversa do disparo é a MESMA conversa da Caixa.
 *
 * Quem responder a uma mensagem de campanha cai no fio que a equipe já
 * usa, com o histórico do que foi mandado. Criar um fio separado para
 * disparo faria a resposta chegar num lugar que ninguém abre.
 */
async function garantirConversa(disparo: DisparoRow, cliente: ClienteRow, agora: Date): Promise<string> {
  const { data: existente } = await supabaseAdmin
    .from('conversas')
    .select('id')
    .eq('cliente_id', cliente.id)
    .eq('canal_id', disparo.canal_id!)
    .neq('status', 'fechado')
    .order('aberta_em', { ascending: false })
    .limit(1);

  const achada = (existente ?? [])[0] as { id: string } | undefined;
  if (achada) {
    await supabaseAdmin
      .from('conversas')
      .update({ atualizado_em: agora.toISOString() })
      .eq('id', achada.id);
    return achada.id;
  }

  const { data: nova, error } = await supabaseAdmin
    .from('conversas')
    .insert({
      cliente_id: cliente.id,
      canal_id: disparo.canal_id,
      status: 'novo',
      aberta_em: agora.toISOString(),
      atualizado_em: agora.toISOString(),
    })
    .select('id')
    .single<{ id: string }>();

  if (error || !nova) throw new Error(`falha ao abrir conversa: ${error?.message ?? 'sem id'}`);
  return nova.id;
}

let timer: NodeJS.Timeout | null = null;

export function iniciarDisparador(): void {
  if (timer) return;
  timer = setInterval(() => {
    void passadaDoDisparador();
  }, TICK_MS);
  timer.unref();
  logger.info(
    { tickMs: TICK_MS, habilitado: interruptorGeral, dia: diaNaCampanha(new Date()) },
    'disparador iniciado',
  );
}

export function pararDisparador(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** Só para teste: limpa o agendamento em memória entre casos. */
export function limparAgendamentos(): void {
  proximoEnvioEm.clear();
}
