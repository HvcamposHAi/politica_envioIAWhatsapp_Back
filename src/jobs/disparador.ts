// O worker de disparo — Fase 3 do PLANO_CAMPANHA_INDIARA.md.
//
// POR QUE FILA EM PROCESSO, e não worker separado: este serviço já roda em
// UMA instância permanente com CPU alocada (deploy.sh força
// --min-instances=1 --max-instances=1 --no-cpu-throttling), porque ele
// segura os WebSockets do WhatsApp. É exatamente o ambiente que uma fila
// precisa, e é o mesmo processo que tem o socket na mão — mandar por outro
// processo exigiria um protocolo entre os dois para nada.
//
// A contrapartida é que `--max-instances=1` deixa de ser só anti-duelo-de-
// sessão e passa a ser anti-envio-duplicado. O índice único
// (disparo_id, telefone) e o trigger de teto no banco são a segunda camada,
// para o dia em que alguém mexer nessa flag.
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
import {
  aplicarCampos,
  avaliarPausaAutomatica,
  decidir,
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
let interruptorGeral = String(process.env.DISPARO_ATIVO ?? 'true') !== 'false';

export function disparoHabilitado(): boolean {
  return interruptorGeral;
}

export function religarDisparos(): void {
  interruptorGeral = true;
}

/**
 * Para tudo: interrompe o worker E pausa no banco todos os disparos que
 * estavam enviando. Os dois, de propósito — só o flag em memória voltaria
 * a enviar no próximo deploy, e só o banco não impediria a passada que já
 * está em andamento.
 */
export async function pararTudo(motivo: string): Promise<number> {
  interruptorGeral = false;
  const { data, error } = await supabaseAdmin
    .from('disparos')
    .update({ pausado_em: new Date().toISOString(), pausa_motivo: motivo })
    .eq('status', 'enviando')
    .is('pausado_em', null)
    .select('id');
  if (error) {
    logger.error({ err: error.message }, 'pararTudo: falha ao pausar no banco — o worker já está parado');
    return 0;
  }
  logger.warn({ motivo, pausados: data?.length ?? 0 }, 'PARAR TUDO acionado');
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
  if (!interruptorGeral) return resultado;

  try {
    const { data: disparos, error } = await supabaseAdmin
      .from('disparos')
      .select(
        'id, empresa_id, canal_id, status, pausado_em, texto_base, janela_inicio, janela_fim, ' +
          'intervalo_min_seg, intervalo_max_seg, teto_diario, enviados_hoje, contador_dia, ' +
          'amostra_aprovada_em',
      )
      .eq('status', 'enviando')
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

async function processarUmDisparo(disparo: DisparoRow, agora: Date): Promise<string> {
  const agendado = proximoEnvioEm.get(disparo.id);
  if (agendado !== undefined && agora.getTime() < agendado) return 'aguardando_intervalo';

  if (!disparo.canal_id) {
    await pausar(disparo.id, 'Disparo sem canal escolhido.');
    return 'pausado';
  }

  // Freio automático ANTES de decidir enviar: se a campanha está fazendo
  // gente pedir descadastro, a próxima mensagem é a que não deveria sair.
  const janela = await medirJanelaRecente(disparo.id, agora);
  const motivoPausa = avaliarPausaAutomatica(janela, limiares());
  if (motivoPausa) {
    await pausar(
      disparo.id,
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
      // e ninguém sabe por quê. O vigia de canais reconecta; quem religa o
      // disparo é gente.
      await pausar(disparo.id, 'Pausado automaticamente: a linha de WhatsApp caiu.');
      return 'pausado';
    }
    return decisao.motivo;
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
    .eq('status', 'pendente');
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

async function medirJanelaRecente(
  disparoId: string,
  agora: Date,
): Promise<{ enviados: number; falhas: number; optOuts: number }> {
  const desde = new Date(agora.getTime() - JANELA_PAUSA_MIN * 60_000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('disparo_alvos')
    .select('status, cliente_id, clientes(opt_out_em)')
    .eq('disparo_id', disparoId)
    .gte('enviado_em', desde);
  if (error) throw new Error(`falha ao medir a janela: ${error.message}`);

  type Linha = { status: string; clientes: { opt_out_em: string | null } | null };
  const linhas = (data ?? []) as unknown as Linha[];

  return {
    enviados: linhas.length,
    falhas: linhas.filter((l) => l.status === 'falhou').length,
    optOuts: linhas.filter((l) => l.clientes?.opt_out_em && l.clientes.opt_out_em >= desde).length,
  };
}

async function pausar(disparoId: string, motivo: string): Promise<void> {
  await supabaseAdmin
    .from('disparos')
    .update({ pausado_em: new Date().toISOString(), pausa_motivo: motivo })
    .eq('id', disparoId);
  proximoEnvioEm.delete(disparoId);
  logger.warn({ disparoId, motivo }, 'disparo pausado automaticamente');
}

/** Primeiro nome, para o texto soar como gente. "MARIA DAS GRAÇAS SILVA"
 *  vira "Maria" — planilha de campanha vem em caixa alta com frequência. */
export function primeiroNome(nomeCompleto: string): string {
  const primeiro = nomeCompleto.trim().split(/\s+/)[0] ?? '';
  if (!primeiro) return '';
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

async function enviarProximo(disparo: DisparoRow, agora: Date): Promise<string> {
  const { data: alvos, error: erroAlvo } = await supabaseAdmin
    .from('disparo_alvos')
    .select('id, telefone, cliente_id, texto_gerado, tentativas')
    .eq('disparo_id', disparo.id)
    .eq('status', 'pendente')
    .order('agendado_para', { ascending: true, nullsFirst: true })
    .limit(1);
  if (erroAlvo) throw new Error(`falha ao pegar o próximo alvo: ${erroAlvo.message}`);

  const alvo = (alvos ?? [])[0] as AlvoRow | undefined;
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

  // "Digitando…" antes de mandar. O ChannelPort expõe isso como opcional —
  // transporte que não tem o conceito simplesmente não implementa.
  if (canal.sinalizarDigitando) {
    try {
      await canal.sinalizarDigitando(cliente.telefone, tempoDigitandoMs(texto), cliente.wa_jid ?? undefined);
    } catch {
      // Presença é cosmética. Falhar aqui não pode impedir a mensagem.
    }
  }

  const envio = await canal.enviar({
    conversaId: '',
    telefone: cliente.telefone,
    texto,
    waJidDestino: cliente.wa_jid ?? undefined,
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
