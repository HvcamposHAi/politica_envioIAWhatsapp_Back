// Único módulo que conhece o bucket de mídia. Nada mais no repo deve falar
// com o armazenamento direto.
//
// HISTÓRICO: até 01/09/2026 este arquivo usava Google Cloud Storage. A troca
// de infraestrutura (Cloudflare + Render + Supabase) tirou a GCP da jogada, e
// o Supabase Storage passou a ser o destino — mesmo projeto que já guarda o
// banco, mesma credencial `service_role` que o backend já carrega, sem
// nenhuma conta de nuvem a mais.
//
// A ASSINATURA PÚBLICA NÃO MUDOU. As sete funções exportadas continuam as
// mesmas, com os mesmos parâmetros e retornos, porque seis lugares do código
// dependem delas (routes/mensagens.ts, services/filaMidia.ts,
// services/mensagens.ts, channels/twilio.adapter.ts). A troca é interna.
//
// POR QUE O BANCO GUARDA O CAMINHO, NUNCA A URL: URL assinada expira em
// minutos. Gravada em coluna, ela apodrece e a mídia "some" depois de um dia
// — a URL é gerada sob demanda por GET /mensagens/:id/midia, que revalida o
// escopo do atendente a cada pedido. Isso vale igual no Supabase.

import { supabaseAdmin } from '../db/client.server.js';
import type { Readable } from 'node:stream';

/** Nome do bucket. Falha explícita e cedo, como o baseUrl() do front — um
 *  upload silenciosamente indo para "undefined" seria pior. */
export function bucketNome(): string {
  const nome = process.env.SUPABASE_BUCKET_MIDIA;
  if (!nome) {
    throw new Error(
      'SUPABASE_BUCKET_MIDIA não configurado — necessário para guardar mídia do WhatsApp. ' +
        'Criar um bucket PRIVADO no Supabase Storage e apontar aqui. ' +
        'Ver docs/DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md §1.4.',
    );
  }
  return nome;
}

/** `true` quando o serviço de mídia está configurado. Quem chama decide o que
 *  fazer sem configuração (em dev local, a mensagem é gravada com
 *  midia_status='ignorada' em vez de o processo quebrar). */
export function midiaConfigurada(): boolean {
  return !!process.env.SUPABASE_BUCKET_MIDIA;
}

const TTL_PADRAO_SEG = Number(process.env.MIDIA_URL_TTL_SEGUNDOS ?? 600);

/** Teto de bytes que aceitamos ler para a memória de uma vez. Mesmo valor que
 *  o front e a rota de upload já batem. Ver a nota de memória em
 *  subirStream(). */
function tetoBytes(): number {
  return Number(process.env.MIDIA_TAMANHO_MAX_MB ?? 16) * 1024 * 1024;
}

function bucket() {
  return supabaseAdmin.storage.from(bucketNome());
}

/**
 * Caminho determinístico do objeto.
 *
 * Derivado do `wa_message_id`, que é a chave de idempotência do fluxo de
 * entrada: reentrega do Baileys depois de uma reconexão sobrescreve o MESMO
 * objeto em vez de criar lixo órfão no bucket. (Daí `upsert: true` nos
 * uploads — sem ele o Supabase recusaria a segunda gravação com 409.)
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

/**
 * Este tipo pode ser servido INLINE pelo navegador com segurança?
 *
 * No GCS a decisão ia no `contentDisposition` do objeto, gravado no upload.
 * O Supabase não deixa definir Content-Disposition por objeto — então a
 * decisão migrou para a hora de gerar a URL (`download` em urlAssinada).
 * Mesma regra, outro ponto de aplicação.
 *
 * SVG é imagem e NÃO entra: um SVG é um documento que executa script, e
 * servi-lo inline a partir do domínio do storage é XSS. A versão anterior
 * deste arquivo deixava passar, porque olhava só o `image/` do começo.
 */
function podeServirInline(tipoMime: string | undefined): boolean {
  const mime = (tipoMime ?? '').toLowerCase();
  if (mime === 'image/svg+xml' || mime.includes('svg')) return false;
  const base = mime.split('/')[0];
  return base === 'image' || base === 'audio' || base === 'video';
}

function limparNome(nome: string): string {
  return nome.replace(/["\\\r\n]/g, '');
}

/**
 * Sobe um stream para o bucket.
 *
 * ATENÇÃO — REGRESSÃO CONSCIENTE EM RELAÇÃO AO GCS. O cliente do GCS aceitava
 * um `Readable` e escrevia direto, sem materializar o arquivo. O cliente de
 * storage do Supabase não tem esse caminho: o corpo precisa ser um buffer.
 *
 * Então o stream é lido para a memória COM TETO. O teto é o mesmo
 * `MIDIA_TAMANHO_MAX_MB` que a rota de upload e o front já aplicam (16 MB por
 * padrão), e a fila roda com `MIDIA_CONCORRENCIA` 2 — o pior caso é ~32 MB
 * transitórios, não um OOM. Estourar o teto aborta o download com erro
 * explícito, que a fila registra como falha da mídia; a conversa segue.
 *
 * O motivo do cuidado continua o mesmo do texto original: este processo é a
 * instância ÚNICA que segura os sockets do WhatsApp, e um OOM aqui mata TODAS
 * as linhas de uma vez, não só o download.
 */
export async function subirStream(
  caminho: string,
  origem: Readable,
  opcoes: OpcoesUpload,
): Promise<number> {
  const teto = tetoBytes();
  const partes: Buffer[] = [];
  let total = 0;

  await new Promise<void>((resolve, reject) => {
    origem.on('data', (pedaco: Buffer | string) => {
      const b = Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(pedaco);
      total += b.length;
      if (total > teto) {
        origem.destroy();
        reject(
          new Error(
            `mídia acima do teto de ${Math.round(teto / 1024 / 1024)} MB — download abortado ` +
              '(MIDIA_TAMANHO_MAX_MB)',
          ),
        );
        return;
      }
      partes.push(b);
    });
    origem.on('error', reject);
    origem.on('end', resolve);
  });

  return subirBuffer(caminho, Buffer.concat(partes), opcoes);
}

export async function subirBuffer(
  caminho: string,
  dados: Buffer,
  opcoes: OpcoesUpload,
): Promise<number> {
  const { error } = await bucket().upload(caminho, dados, {
    contentType: opcoes.tipoMime,
    // Reentrega do Baileys grava o MESMO caminho (ver montarCaminho). Sem
    // upsert, a segunda tentativa falharia com "Duplicate" e a mídia ficaria
    // presa em 'pendente' para sempre.
    upsert: true,
  });
  if (error) throw new Error(`falha ao subir mídia (${caminho}): ${error.message}`);
  return dados.length;
}

/**
 * URL assinada de leitura.
 *
 * Diferença em relação ao GCS, e é uma boa: não existe mais assinatura por
 * IAM SignBlob, então some a exigência de a service account ter
 * `roles/iam.serviceAccountTokenCreator` SOBRE SI MESMA — a pegadinha que
 * quebrava a primeira mídia aberta em produção com "Cannot sign data without
 * client_email". O Supabase assina com a própria service_role.
 *
 * `download` força Content-Disposition: attachment. É onde a proteção contra
 * HTML/SVG servido inline passou a morar (ver podeServirInline).
 */
export async function urlAssinada(
  caminho: string,
  opcoes?: { ttlSeg?: number; nomeDownload?: string; tipoMime?: string },
): Promise<{ url: string; expiraEm: string }> {
  const ttl = Math.max(60, opcoes?.ttlSeg ?? TTL_PADRAO_SEG);
  const expiraEm = new Date(Date.now() + ttl * 1000);

  // Sem tipo informado, o caminho seguro é forçar download. Quem sabe o tipo
  // (routes/mensagens.ts lê midia_tipo da linha) passa e ganha o inline.
  const forcarDownload = opcoes?.nomeDownload
    ? limparNome(opcoes.nomeDownload)
    : !podeServirInline(opcoes?.tipoMime)
      ? true
      : undefined;

  const { data, error } = await bucket().createSignedUrl(
    caminho,
    ttl,
    forcarDownload === undefined ? undefined : { download: forcarDownload },
  );

  if (error || !data?.signedUrl) {
    throw new Error(`falha ao assinar URL de mídia (${caminho}): ${error?.message ?? 'sem URL'}`);
  }
  return { url: data.signedUrl, expiraEm: expiraEm.toISOString() };
}

/** Lê o objeto de volta para memória. Não usar para vídeo — ver a nota de
 *  memória em subirStream(). */
export async function baixarBuffer(caminho: string): Promise<Buffer> {
  const { data, error } = await bucket().download(caminho);
  if (error || !data) {
    throw new Error(`falha ao baixar mídia (${caminho}): ${error?.message ?? 'sem dados'}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Existia para dar ao Speech-to-Text a URI `gs://` do objeto.
 *
 * Não há mais objeto no GCS. A transcrição em lote dependia disso e está
 * desligada nesta infraestrutura — `transcricaoAtiva()` exige tanto
 * `GCP_PROJECT_ID` quanto `GCS_BUCKET_MIDIA`, e nenhum dos dois existe aqui.
 * A função continua exportada para o módulo de transcrição compilar; se ela
 * for chamada de verdade, é bug de configuração e o erro diz qual.
 */
export function uriGs(caminho: string): string {
  throw new Error(
    `transcrição por URI gs:// não existe nesta infraestrutura (caminho: ${caminho}). ` +
      'A mídia vive no Supabase Storage desde 01/09/2026. Se você chegou aqui, ' +
      'GCP_PROJECT_ID e GCS_BUCKET_MIDIA foram definidos num ambiente sem GCS — ' +
      'ver docs/DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md §0.4.',
  );
}

/** Remover objeto inexistente NÃO é erro: a limpeza roda depois de falha
 *  parcial, onde metade dos caminhos pode nunca ter chegado ao bucket. */
export async function apagar(caminho: string): Promise<void> {
  const { error } = await bucket().remove([caminho]);
  if (error && !/not.?found/i.test(error.message)) {
    throw new Error(`falha ao apagar mídia (${caminho}): ${error.message}`);
  }
}
