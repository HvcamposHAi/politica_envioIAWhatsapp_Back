// Único módulo que conhece o bucket de mídia (GCS). Nada mais no repo deve
// importar @google-cloud/storage — mesma disciplina de gcp/secretManager.ts.
//
// POR QUE GCS E NÃO SUPABASE STORAGE: o Speech-to-Text v2 lê `gs://` direto
// no modo batch (áudio > 60s), então o objeto que já subimos vira a entrada
// da transcrição sem cópia intermediária. Fora isso, a GCP já está
// autenticada por ADC neste processo e o custo por GB é o que a empresa já
// paga.
//
// POR QUE O BANCO GUARDA O CAMINHO, NUNCA A URL: URL assinada expira em
// minutos. Gravada em coluna, ela apodrece e a mídia "some" depois de um dia
// — a URL é gerada sob demanda por GET /mensagens/:id/midia, que revalida o
// escopo do atendente a cada pedido.

import { Storage } from '@google-cloud/storage';
import type { Readable } from 'node:stream';

let _storage: Storage | undefined;

function storage(): Storage {
  if (!_storage) _storage = new Storage();
  return _storage;
}

/** Nome do bucket. Falha explícita e cedo, como o baseUrl() do front — um
 *  upload silenciosamente indo para "undefined" seria pior. */
export function bucketNome(): string {
  const nome = process.env.GCS_BUCKET_MIDIA;
  if (!nome) {
    throw new Error(
      'GCS_BUCKET_MIDIA não configurado — necessário para guardar mídia do WhatsApp. ' +
        'Ver PLANO_MENSAGENS_INTEGRA_WHATSAPP.md, passo 1 da infra.',
    );
  }
  return nome;
}

/** `true` quando o serviço de mídia está configurado. Quem chama decide o que
 *  fazer sem configuração (em dev local, a mensagem é gravada com
 *  midia_status='ignorada' em vez de o processo quebrar). */
export function midiaConfigurada(): boolean {
  return !!process.env.GCS_BUCKET_MIDIA;
}

const TTL_PADRAO_SEG = Number(process.env.MIDIA_URL_TTL_SEGUNDOS ?? 600);

/**
 * Caminho determinístico do objeto.
 *
 * Derivado do `wa_message_id`, que é a chave de idempotência do fluxo de
 * entrada: reentrega do Baileys depois de uma reconexão sobrescreve o MESMO
 * objeto em vez de criar lixo órfão no bucket.
 *
 * `sufixo` separa a miniatura do arquivo cheio.
 */
export function montarCaminho(p: {
  empresaId: string;
  conversaId: string;
  waMessageId: string;
  extensao: string;
  sufixo?: string;
  em?: Date;
}): string {
  const d = p.em ?? new Date();
  const ano = d.getUTCFullYear();
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  // O wa_message_id do WhatsApp é alfanumérico, mas nunca confiar: um "/" ou
  // ".." vindo dali viraria travessia de caminho dentro do bucket.
  const idSeguro = p.waMessageId.replace(/[^A-Za-z0-9_-]/g, '') || 'sem-id';
  const sufixo = p.sufixo ? `_${p.sufixo}` : '';
  return `${p.empresaId}/${ano}/${mes}/${p.conversaId}/${idSeguro}${sufixo}.${p.extensao}`;
}

export interface OpcoesUpload {
  tipoMime: string;
  /** Nome original, usado no Content-Disposition do download. */
  nomeArquivo?: string;
}

/** Sempre `attachment` para o que não é imagem/áudio/vídeo: um HTML ou SVG
 *  servido inline a partir de um domínio de storage é vetor de XSS. */
function disposicao(o: OpcoesUpload): string {
  const base = (o.tipoMime ?? '').split('/')[0];
  const inline = base === 'image' || base === 'audio' || base === 'video';
  const nome = (o.nomeArquivo ?? 'arquivo').replace(/["\\\r\n]/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${nome}"`;
}

/**
 * Sobe um stream direto para o bucket, sem materializar o arquivo em memória.
 *
 * É stream e não buffer de propósito: o hub-api é a instância ÚNICA que segura
 * os sockets do WhatsApp (registry.ts assume 1 instância). Bufferizar vídeos de
 * 16 MB em paralelo é o caminho mais curto para um OOM que mata TODAS as
 * linhas de uma vez, não só o download.
 */
export async function subirStream(
  caminho: string,
  origem: Readable,
  opcoes: OpcoesUpload,
): Promise<number> {
  const arquivo = storage().bucket(bucketNome()).file(caminho);
  await new Promise<void>((resolve, reject) => {
    const destino = arquivo.createWriteStream({
      resumable: false,
      metadata: { contentType: opcoes.tipoMime, contentDisposition: disposicao(opcoes) },
    });
    origem.on('error', reject);
    destino.on('error', reject);
    destino.on('finish', resolve);
    origem.pipe(destino);
  });
  const [meta] = await arquivo.getMetadata();
  return Number(meta.size ?? 0);
}

export async function subirBuffer(
  caminho: string,
  dados: Buffer,
  opcoes: OpcoesUpload,
): Promise<number> {
  await storage()
    .bucket(bucketNome())
    .file(caminho)
    .save(dados, {
      resumable: false,
      contentType: opcoes.tipoMime,
      metadata: { contentDisposition: disposicao(opcoes) },
    });
  return dados.length;
}

/**
 * URL assinada V4 de leitura.
 *
 * No Cloud Run a service account não tem chave privada local — a assinatura
 * passa pela API IAM SignBlob, e por isso a SA precisa de
 * `roles/iam.serviceAccountTokenCreator` SOBRE SI MESMA (passo 3 da infra).
 * Sem esse binding o erro é `Cannot sign data without client_email`, e ele só
 * aparece na primeira mídia que alguém tenta abrir em produção — daí o smoke
 * test específico no plano.
 */
export async function urlAssinada(
  caminho: string,
  opcoes?: { ttlSeg?: number; nomeDownload?: string },
): Promise<{ url: string; expiraEm: string }> {
  const ttl = Math.max(60, opcoes?.ttlSeg ?? TTL_PADRAO_SEG);
  const expiraEm = new Date(Date.now() + ttl * 1000);
  const [url] = await storage()
    .bucket(bucketNome())
    .file(caminho)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiraEm,
      ...(opcoes?.nomeDownload
        ? { responseDisposition: `attachment; filename="${opcoes.nomeDownload.replace(/["\\\r\n]/g, '')}"` }
        : {}),
    });
  return { url, expiraEm: expiraEm.toISOString() };
}

/** Lê o objeto de volta para memória. Usado só pela transcrição de áudio
 *  CURTO (o `recognize` inline do Speech-to-Text precisa dos bytes, e nota de
 *  voz de 60s em opus tem ~120 KB). Não usar para vídeo — ver a nota de
 *  memória em subirStream(). */
export async function baixarBuffer(caminho: string): Promise<Buffer> {
  const [dados] = await storage().bucket(bucketNome()).file(caminho).download();
  return dados;
}

/** URI `gs://` do objeto — entrada do batchRecognize do Speech-to-Text. */
export function uriGs(caminho: string): string {
  return `gs://${bucketNome()}/${caminho}`;
}

export async function apagar(caminho: string): Promise<void> {
  await storage().bucket(bucketNome()).file(caminho).delete({ ignoreNotFound: true });
}
