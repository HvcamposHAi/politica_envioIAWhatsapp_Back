// Fila de download de mídia do WhatsApp — o coração da decisão D1 do plano.
//
// POR QUE ISTO EXISTE, E NÃO UM `await` DENTRO DO ADAPTER: o handler de
// `messages.upsert` do Baileys é SERIAL (um for..of com await, ver
// baileys.adapter.ts). Baixar um vídeo de 16 MB ali dentro travaria a fila de
// mensagens de TODAS as conversas daquela linha — o cliente que só mandou
// "bom dia" ficaria esperando o download do vídeo de outro cliente.
//
// Fluxo: a mensagem é GRAVADA primeiro (midia_status='pendente') e a bolha já
// aparece na tela por Realtime. O binário chega depois e a bolha vira imagem
// por um UPDATE — que o front PRECISA estar assinando (a Caixa só assinava
// INSERT até esta feature; sem o listener de UPDATE a mídia trava em
// "carregando" até um F5).
//
// DURABILIDADE: a fila é em memória, então um restart do Cloud Run (todo
// deploy é um) perderia o trabalho pendente. Por isso a referência técnica de
// download é persistida em hub.mensagens.midia_ref e a varredura periódica
// reenfileira o que ficou para trás — o proto original do Baileys morre com o
// processo, mas os campos de download não.

import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import type { Readable } from 'node:stream';
import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';
import {
  extensaoDe,
  TIPOS_DE_AUDIO,
  type MidiaDescritor,
  type RefDownload,
  type TipoMensagem,
} from '../channels/mensagemWhatsApp.js';
import { midiaConfigurada, montarCaminho, subirBuffer, subirStream } from './midiaStorage.js';
import { transcreverMensagem } from './transcricaoAudio.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/** Concorrência baixa DE PROPÓSITO. Este processo é a instância única que
 *  segura os sockets do WhatsApp (registry.ts); download é trabalho de fundo e
 *  não pode competir por CPU/rede com a entrega de mensagem. */
const CONCORRENCIA = Number(process.env.MIDIA_CONCORRENCIA ?? 2);
const MAX_TENTATIVAS = 3;
const VARREDURA_INTERVALO_MS = 10 * 60_000;
/** Idade a partir da qual uma mídia ainda 'pendente' é considerada órfã de um
 *  processo que morreu. Folgado o bastante para não brigar com um download
 *  legítimo de arquivo grande em rede ruim. */
const VARREDURA_IDADE_MS = 15 * 60_000;

export interface ItemMidia {
  mensagemId: string;
  empresaId: string;
  conversaId: string;
  waMessageId: string;
  tipo: TipoMensagem;
  midia: MidiaDescritor;
  ref: RefDownload;
  /** Só existe na primeira passada, enquanto o proto ainda está em memória:
   *  pede ao WhatsApp que REENVIE a mídia (sock.updateMediaMessage) quando a
   *  URL original já expirou. Depois de um restart não há como reconstruir
   *  isto — daí o estado final 'expirada' ser honesto e não um erro nosso. */
  reobterRef?: () => Promise<RefDownload | null>;
  tentativa?: number;
}

type TipoBaileys = 'image' | 'video' | 'audio' | 'document' | 'sticker';

function tipoBaileys(tipo: TipoMensagem): TipoBaileys | null {
  switch (tipo) {
    case 'imagem':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
    case 'voz':
      return 'audio';
    case 'documento':
      return 'document';
    case 'figurinha':
      return 'sticker';
    default:
      return null;
  }
}

function paraNoDeDownload(ref: RefDownload) {
  return {
    url: ref.url ?? undefined,
    directPath: ref.directPath ?? undefined,
    mediaKey: ref.mediaKey ? Buffer.from(ref.mediaKey, 'base64') : undefined,
    fileEncSha256: ref.fileEncSha256 ? Buffer.from(ref.fileEncSha256, 'base64') : undefined,
    fileSha256: ref.fileSha256 ? Buffer.from(ref.fileSha256, 'base64') : undefined,
    mediaKeyTimestamp: ref.mediaKeyTimestamp ?? undefined,
  };
}

async function gravar(mensagemId: string, campos: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from('mensagens').update(campos).eq('id', mensagemId);
  if (error) {
    logger.error({ mensagemId, err: error.message }, 'falha ao atualizar mídia em hub.mensagens');
  }
}

// ---------------------------------------------------------------------
// Semáforo simples. Sem lib: a alternativa (p-limit) traria uma dependência
// para 15 linhas, e este é o único ponto do repo que precisa de concorrência
// limitada.
// ---------------------------------------------------------------------
const pendentes: ItemMidia[] = [];
const naFila = new Set<string>();
let emExecucao = 0;

export function tamanhoDaFila(): { aguardando: number; executando: number } {
  return { aguardando: pendentes.length, executando: emExecucao };
}

function bombear(): void {
  while (emExecucao < CONCORRENCIA && pendentes.length > 0) {
    const item = pendentes.shift()!;
    emExecucao += 1;
    void processar(item)
      .catch((err) => {
        // Backstop: processar() já trata tudo. Se ainda assim escapar, um
        // unhandledRejection aqui derrubaria o processo inteiro e com ele
        // TODAS as linhas de WhatsApp (Node 15+).
        logger.error(
          { mensagemId: item.mensagemId, err: err instanceof Error ? err.message : String(err) },
          'exceção inesperada na fila de mídia',
        );
      })
      .finally(() => {
        emExecucao -= 1;
        naFila.delete(item.mensagemId);
        bombear();
      });
  }
}

/**
 * Enfileira o download de uma mídia. Fire-and-forget: NUNCA aguardar isto no
 * caminho de gravação da mensagem.
 */
export function enfileirarMidia(item: ItemMidia): void {
  if (naFila.has(item.mensagemId)) return;
  naFila.add(item.mensagemId);
  pendentes.push({ ...item, tentativa: item.tentativa ?? 0 });
  bombear();
}

async function processar(item: ItemMidia): Promise<void> {
  const tipo = tipoBaileys(item.tipo);
  if (!tipo) return;

  if (!midiaConfigurada()) {
    // Dev local sem bucket: a conversa continua funcionando, a mídia fica
    // marcada como não baixada. Melhor do que fingir que a mensagem era só
    // texto — que é exatamente o defeito que esta feature veio corrigir.
    await gravar(item.mensagemId, {
      midia_status: 'ignorada',
      midia_erro: 'Armazenamento de mídia não configurado nesta instalação (GCS_BUCKET_MIDIA).',
    });
    return;
  }

  const tentativa = (item.tentativa ?? 0) + 1;
  await gravar(item.mensagemId, { midia_status: 'baixando' });

  try {
    let ref = item.ref;
    // A partir da 2ª tentativa, pede ao WhatsApp que reenvie: o caso comum de
    // falha é mídia recebida depois de dias offline, cuja URL o servidor do
    // WhatsApp já reciclou.
    if (tentativa > 1 && item.reobterRef) {
      const nova = await item.reobterRef().catch(() => null);
      if (nova) ref = nova;
    }

    const stream = (await downloadContentFromMessage(
      paraNoDeDownload(ref) as never,
      tipo,
      {},
    )) as unknown as Readable;

    const extensao = extensaoDe(item.midia.tipoMime, item.midia.nome);
    const caminho = montarCaminho({
      empresaId: item.empresaId,
      conversaId: item.conversaId,
      waMessageId: item.waMessageId,
      extensao,
    });

    const tamanho = await subirStream(caminho, stream, {
      tipoMime: item.midia.tipoMime,
      nomeArquivo: item.midia.nome,
    });

    // Miniatura: o WhatsApp manda um JPEG pequeno embutido no stanza. Subir
    // isso separado é o que faz a lista renderizar sem baixar o arquivo cheio.
    let thumbCaminho: string | null = null;
    if (item.midia.thumbnail?.length) {
      thumbCaminho = montarCaminho({
        empresaId: item.empresaId,
        conversaId: item.conversaId,
        waMessageId: item.waMessageId,
        extensao: 'jpg',
        sufixo: 'thumb',
      });
      await subirBuffer(thumbCaminho, item.midia.thumbnail, { tipoMime: 'image/jpeg' }).catch(
        (err) => {
          // Miniatura é conforto, não conteúdo. Falhar aqui não pode
          // invalidar um download que já deu certo.
          logger.warn({ mensagemId: item.mensagemId, err: String(err) }, 'falha ao subir miniatura');
          thumbCaminho = null;
        },
      );
    }

    await gravar(item.mensagemId, {
      midia_objeto: caminho,
      midia_thumb_objeto: thumbCaminho,
      // O tamanho real do objeto vence o `fileLength` anunciado pelo stanza —
      // é o que o atendente vai baixar de fato.
      midia_tamanho: tamanho || item.midia.tamanho || null,
      midia_status: 'pronta',
      midia_erro: null,
    });

    // Transcrição só DEPOIS de 'pronta': o caminho de áudio longo lê o objeto
    // do bucket por gs://. Fire-and-forget, mesmo contrato do resumo.
    if (TIPOS_DE_AUDIO.has(item.tipo)) {
      void transcreverMensagem(item.mensagemId);
    }
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    if (tentativa < MAX_TENTATIVAS) {
      const espera = 2 ** tentativa * 2_000;
      logger.warn(
        { mensagemId: item.mensagemId, tentativa, err: mensagem },
        'download de mídia falhou — reagendando',
      );
      naFila.delete(item.mensagemId);
      const t = setTimeout(() => enfileirarMidia({ ...item, tentativa }), espera);
      t.unref?.();
      return;
    }

    // Esgotou. "expirada" quando o WhatsApp já não tem o arquivo — é estado
    // final HONESTO, não erro nosso, e a bolha explica isso ao atendente em
    // vez de mostrar um erro genérico ou, pior, sumir.
    const expirou = /404|410|not found|expired|no such/i.test(mensagem);
    logger.error({ mensagemId: item.mensagemId, err: mensagem }, 'download de mídia esgotou tentativas');
    await gravar(item.mensagemId, {
      midia_status: expirou ? 'expirada' : 'falhou',
      midia_erro: expirou
        ? 'O WhatsApp não guarda mais este arquivo (mídia recebida há muito tempo). Peça ao cliente para reenviar.'
        : mensagem.slice(0, 500),
    });
  }
}

// ---------------------------------------------------------------------
// Varredura — rede de segurança para o que a fila em memória perdeu.
// ---------------------------------------------------------------------
interface LinhaPresa {
  id: string;
  conversa_id: string | null;
  wa_message_id: string | null;
  tipo_mensagem: string;
  midia_tipo: string | null;
  midia_nome: string | null;
  midia_tamanho: number | null;
  midia_ref: RefDownload | null;
}

/**
 * Reenfileira mídia que ficou para trás — tipicamente porque o processo caiu
 * (todo deploy do Cloud Run é um restart) no meio do download.
 *
 * Só consegue recuperar quem tem `midia_ref` gravado; sem ele o binário é
 * irrecuperável e a linha vira 'falhou' com mensagem explicando, em vez de
 * ficar "carregando" para sempre.
 */
export async function varrerMidiaPendente(): Promise<number> {
  const corte = new Date(Date.now() - VARREDURA_IDADE_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('mensagens')
    .select('id, conversa_id, wa_message_id, tipo_mensagem, midia_tipo, midia_nome, midia_tamanho, midia_ref')
    .in('midia_status', ['pendente', 'baixando'])
    // `criada_em`, não `enviada_em`: desde a ordenação cronológica,
    // `enviada_em` carrega o relógio do WhatsApp, e num backlog de reconexão
    // ele é passado. Com o filtro na coluna errada, toda foto de backlog
    // nasceria já vencida pelo corte e seria varrida antes de o primeiro
    // download terminar — download duplicado, ou 'falhou' numa mídia que
    // estava chegando bem. O que este corte quer medir é há quanto tempo a
    // LINHA está presa aqui dentro, que é `criada_em`.
    .lt('criada_em', corte)
    .limit(50);

  if (error) {
    logger.error({ err: error.message }, 'falha na varredura de mídia pendente');
    return 0;
  }
  const linhas = (data ?? []) as LinhaPresa[];
  if (!linhas.length) return 0;

  // empresa_id vem do canal da conversa. Consulta separada e simples — sem
  // embed do PostgREST, que já derrubou um serviço fire-and-forget desta base
  // quando uma FK nova tornou o embed ambíguo.
  const conversaIds = [...new Set(linhas.map((l) => l.conversa_id).filter(Boolean))] as string[];
  const empresaPorConversa = new Map<string, string>();
  if (conversaIds.length) {
    const { data: convs } = await supabaseAdmin
      .from('conversas')
      .select('id, canal_id')
      .in('id', conversaIds);
    const canalIds = [...new Set((convs ?? []).map((c: { canal_id: string }) => c.canal_id))];
    const { data: canais } = await supabaseAdmin
      .from('canais')
      .select('id, empresa_id')
      .in('id', canalIds);
    const empresaPorCanal = new Map(
      (canais ?? []).map((c: { id: string; empresa_id: string | null }) => [c.id, c.empresa_id ?? '']),
    );
    for (const c of (convs ?? []) as { id: string; canal_id: string }[]) {
      const emp = empresaPorCanal.get(c.canal_id);
      if (emp) empresaPorConversa.set(c.id, emp);
    }
  }

  let reenfileiradas = 0;
  for (const linha of linhas) {
    const empresaId = linha.conversa_id ? empresaPorConversa.get(linha.conversa_id) : undefined;
    if (!linha.midia_ref?.directPath && !linha.midia_ref?.url) {
      await gravar(linha.id, {
        midia_status: 'falhou',
        midia_erro:
          'O download foi interrompido e não há como retomá-lo. Peça ao cliente para reenviar o arquivo.',
      });
      continue;
    }
    if (!empresaId || !linha.conversa_id || !linha.wa_message_id) continue;

    enfileirarMidia({
      mensagemId: linha.id,
      empresaId,
      conversaId: linha.conversa_id,
      waMessageId: linha.wa_message_id,
      tipo: linha.tipo_mensagem as TipoMensagem,
      midia: {
        tipoMime: linha.midia_tipo ?? 'application/octet-stream',
        nome: linha.midia_nome ?? undefined,
        tamanho: linha.midia_tamanho ?? undefined,
        // A miniatura embutida no stanza morreu com o processo anterior; a
        // mídia cheia é recuperável, a thumb não. Bolha sem prévia é bem
        // melhor que bolha sem arquivo.
        ref: linha.midia_ref,
      },
      ref: linha.midia_ref,
    });
    reenfileiradas += 1;
  }

  if (reenfileiradas) {
    logger.info({ reenfileiradas }, 'varredura reenfileirou mídia pendente');
  }
  return reenfileiradas;
}

let timerVarredura: ReturnType<typeof setInterval> | undefined;

/** Chamado no boot (server.ts). Idempotente. */
export function iniciarVarreduraMidia(): void {
  if (timerVarredura) return;
  // A primeira passada é logo após o boot: é exatamente o momento em que
  // existe trabalho órfão do processo anterior.
  const inicial = setTimeout(() => void varrerMidiaPendente(), 30_000);
  inicial.unref?.();
  timerVarredura = setInterval(() => void varrerMidiaPendente(), VARREDURA_INTERVALO_MS);
  timerVarredura.unref?.();
}

export function pararVarreduraMidia(): void {
  if (timerVarredura) clearInterval(timerVarredura);
  timerVarredura = undefined;
}
