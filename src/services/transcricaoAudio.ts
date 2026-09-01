// Transcrição de áudio recebido (nota de voz e arquivo de áudio) com Google
// Cloud Speech-to-Text v2, modelo `chirp_2`, pt-BR.
//
// POR QUE NÃO A ANTHROPIC: Claude não recebe áudio. E introduzir um vendor
// novo (Whisper/OpenAI) por causa de uma feature traria mais uma chave para
// guardar e girar — a GCP já está autenticada por ADC neste processo, sem
// secret nenhum.
//
// CONTRATO DE FIRE-AND-FORGET, igual ao de services/resumoIA.ts: esta função
// NUNCA relança. Quem a aciona está no fim do caminho que já gravou a
// mensagem; uma falha do Speech-to-Text não pode derrubar nada. Falha vira
// transcricao_status='erro', não exceção.
//
// ORDEM IMPORTA: só roda depois de midia_status='pronta'. O caminho de áudio
// longo lê o `gs://` do objeto que a fila de mídia acabou de subir.

import { v2 } from '@google-cloud/speech';
import { supabaseAdmin } from '../db/client.server.js';
import { baixarBuffer, uriGs } from './midiaStorage.js';

const IDIOMA = 'pt-BR';
const MODELO = 'chirp_2';

/** Acima disto o `recognize` inline do Speech-to-Text v2 recusa (limite de
 *  60s da API) e passamos para o batch, que lê do bucket. */
const LIMITE_INLINE_SEG = 55;

function localizacao(): string {
  // chirp_2 não existe em southamerica-east1. us-central1 é a região com o
  // modelo, e o áudio já está num bucket que a SA lê — a alternativa seria
  // um modelo pior mais perto.
  return process.env.TRANSCRICAO_LOCAL ?? 'us-central1';
}

function maximoSegundos(): number {
  return Number(process.env.TRANSCRICAO_MAX_MINUTOS ?? 15) * 60;
}

/** Desligável por env var, sem redeploy de código: é a válvula de escape se o
 *  custo por minuto de áudio surpreender (FA-10 do plano). */
export function transcricaoAtiva(): boolean {
  return process.env.TRANSCRICAO_ATIVA !== 'false' && !!process.env.GCP_PROJECT_ID;
}

let _cliente: v2.SpeechClient | undefined;

function cliente(): v2.SpeechClient {
  if (!_cliente) {
    _cliente = new v2.SpeechClient({ apiEndpoint: `${localizacao()}-speech.googleapis.com` });
  }
  return _cliente;
}

function recognizer(): string {
  const projeto = process.env.GCP_PROJECT_ID;
  if (!projeto) throw new Error('GCP_PROJECT_ID não configurado — necessário para a transcrição.');
  // `_` é o recognizer implícito: configuração vai inteira na requisição, sem
  // precisar criar e versionar um recurso à parte.
  return `projects/${projeto}/locations/${localizacao()}/recognizers/_`;
}

function configuracao() {
  return {
    // autoDecodingConfig: deixa a API detectar o container/codec. O WhatsApp
    // manda opus em ogg, mas áudio ANEXADO pelo cliente pode vir em m4a, mp3
    // ou amr — declarar o codec na mão quebraria nesses casos.
    autoDecodingConfig: {},
    model: MODELO,
    languageCodes: [IDIOMA],
    features: { enableAutomaticPunctuation: true },
  };
}

function juntarResultados(resultados: unknown): string {
  const lista = (resultados ?? []) as Array<{ alternatives?: Array<{ transcript?: string | null }> }>;
  return lista
    .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function transcreverInline(caminhoObjeto: string): Promise<string> {
  const [resposta] = await cliente().recognize({
    recognizer: recognizer(),
    config: configuracao(),
    content: await baixarBuffer(caminhoObjeto),
  });
  return juntarResultados(resposta.results);
}

async function transcreverDoBucket(caminhoObjeto: string): Promise<string> {
  const uri = uriGs(caminhoObjeto);
  const [operacao] = await cliente().batchRecognize({
    recognizer: recognizer(),
    config: configuracao(),
    files: [{ uri }],
    // inlineResponseConfig: o resultado volta na própria resposta da operação,
    // sem escrever um JSON de saída em outro caminho do bucket que depois
    // ninguém limparia.
    recognitionOutputConfig: { inlineResponseConfig: {} },
  });
  const [resultado] = await operacao.promise();
  const porArquivo = (resultado.results ?? {}) as Record<
    string,
    { transcript?: { results?: unknown }; error?: { message?: string } }
  >;
  const alvo = porArquivo[uri];
  if (alvo?.error?.message) throw new Error(alvo.error.message);
  return juntarResultados(alvo?.transcript?.results);
}

interface LinhaAudio {
  id: string;
  tipo_mensagem: string;
  midia_objeto: string | null;
  midia_status: string;
  midia_duracao_seg: number | null;
  transcricao_status: string;
}

async function gravar(mensagemId: string, campos: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from('mensagens').update(campos).eq('id', mensagemId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao gravar transcrição em hub.mensagens (${mensagemId}):`, error.message);
  }
}

/**
 * Transcreve o áudio de UMA mensagem. Sempre resolve.
 *
 * Estados finais possíveis:
 *   · 'pronta'   — há texto (a constraint mensagens_transcricao_carimbo garante
 *                  que 'pronta' nunca fica sem texto e sem carimbo)
 *   · 'ignorada' — áudio longo demais, transcrição desligada, ou o modelo não
 *                  ouviu nada (áudio mudo). NÃO é erro: é resposta honesta.
 *   · 'erro'     — falha real, com a mensagem no `transcricao_erro`.
 */
export async function transcreverMensagem(mensagemId: string): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      // Colunas simples, sem embed: este é um select de serviço fire-and-forget,
      // e um embed ambíguo por causa de FK futura já parou a IA inteira uma vez
      // (ver services/analiseIA.ts).
      .from('mensagens')
      .select('id, tipo_mensagem, midia_objeto, midia_status, midia_duracao_seg, transcricao_status')
      .eq('id', mensagemId)
      .maybeSingle<LinhaAudio>();
    if (error) throw new Error(error.message);
    if (!data) return;

    if (data.tipo_mensagem !== 'audio' && data.tipo_mensagem !== 'voz') return;
    if (data.midia_status !== 'pronta' || !data.midia_objeto) return;
    // Já transcrita (reentrega do Baileys, ou uma segunda passada da fila):
    // não gastar outra chamada nem sobrescrever um texto bom.
    if (data.transcricao_status === 'pronta') return;

    if (!transcricaoAtiva()) {
      await gravar(mensagemId, {
        transcricao_status: 'ignorada',
        transcricao_erro: 'Transcrição automática está desligada nesta instalação.',
      });
      return;
    }

    const duracao = data.midia_duracao_seg ?? 0;
    if (duracao > maximoSegundos()) {
      await gravar(mensagemId, {
        transcricao_status: 'ignorada',
        transcricao_erro: `Áudio de ${Math.round(duracao / 60)} min — acima do limite de ${maximoSegundos() / 60} min para transcrição automática.`,
      });
      return;
    }

    await gravar(mensagemId, { transcricao_status: 'processando', transcricao_erro: null });

    const texto =
      duracao > 0 && duracao <= LIMITE_INLINE_SEG
        ? await transcreverInline(data.midia_objeto)
        : await transcreverDoBucket(data.midia_objeto);

    if (!texto) {
      // Áudio mudo, ruído, ou fala fora do idioma. Marcar 'erro' aqui faria a
      // tela sugerir que algo quebrou quando nada quebrou.
      await gravar(mensagemId, {
        transcricao_status: 'ignorada',
        transcricao_erro: 'Não foi possível identificar fala neste áudio.',
      });
      return;
    }

    await gravar(mensagemId, {
      transcricao: texto,
      transcricao_status: 'pronta',
      transcricao_gerada_em: new Date().toISOString(),
      transcricao_erro: null,
    });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`falha ao transcrever áudio (mensagem=${mensagemId}):`, mensagem);
    await gravar(mensagemId, {
      transcricao_status: 'erro',
      transcricao_erro: mensagem.slice(0, 500),
    });
  }
}
