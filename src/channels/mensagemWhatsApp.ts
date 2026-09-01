// Classificador de conteúdo de mensagem do WhatsApp — PURO, sem I/O.
//
// Existe separado do adapter por dois motivos:
//  1. É a única parte da ingestão que dá para testar sem número real, sem
//     socket e sem banco. O adapter em si continua "NÃO TESTADO CONTRA UM
//     NÚMERO REAL" (ver cabeçalho de baileys.adapter.ts); isto aqui não.
//  2. É onde mora a REGRA CENTRAL desta feature: **nenhuma mensagem recebida
//     pode ser descartada em silêncio**. Antes, tudo que não fosse
//     `conversation` ou `extendedTextMessage.text` virava `undefined` e a
//     linha era gravada com texto vazio — a foto que o cliente mandou
//     simplesmente não existia para o atendente. Agora, o pior caso é
//     `tipo: 'desconhecido'` com o payload preservado em `conteudoExtra`.
//
// Tipagem estrutural de propósito (`Record<string, any>` nos nós do proto em
// vez de proto.IWebMessageInfo): o formato do Baileys muda entre releases —
// `senderPn` virou `remoteJidAlt` da 6.x para a 7.x — e este módulo precisa
// degradar para 'desconhecido', nunca quebrar o build a cada bump.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type TipoMensagem =
  | 'texto'
  | 'imagem'
  | 'video'
  | 'audio'
  | 'voz'
  | 'documento'
  | 'figurinha'
  | 'localizacao'
  | 'contato'
  | 'enquete'
  | 'sistema'
  | 'desconhecido';

/** Tipos que têm binário para baixar do WhatsApp. */
export const TIPOS_COM_MIDIA: ReadonlySet<TipoMensagem> = new Set<TipoMensagem>([
  'imagem',
  'video',
  'audio',
  'voz',
  'documento',
  'figurinha',
]);

/** Tipos que passam pela transcrição (services/transcricaoAudio.ts). */
export const TIPOS_DE_AUDIO: ReadonlySet<TipoMensagem> = new Set<TipoMensagem>(['audio', 'voz']);

/**
 * Campos que o Baileys precisa para baixar e decifrar o binário.
 *
 * Serializável de propósito (base64 em vez de Buffer): é gravado em
 * hub.mensagens.midia_ref, porque a fila de download é em memória e um
 * restart do Cloud Run — todo deploy é um — perderia o proto original.
 */
export interface RefDownload {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: string | null;
  fileEncSha256?: string | null;
  fileSha256?: string | null;
  mediaKeyTimestamp?: number | null;
}

export interface MidiaDescritor {
  tipoMime: string;
  nome?: string;
  tamanho?: number;
  duracaoSeg?: number;
  largura?: number;
  altura?: number;
  /** Miniatura embutida no stanza (`jpegThumbnail`), quando o WhatsApp manda.
   *  Vale ouro: é o que faz a bolha mostrar algo ANTES do download terminar. */
  thumbnail?: Buffer;
  /** Como buscar o binário depois. Preenchido pelo classificador a partir do
   *  mesmo nó do proto — quem baixa nunca precisa reabrir a mensagem. */
  ref: RefDownload;
}

/** Mensagem que NÃO cria linha nova — altera uma que já existe, igual ao
 *  WhatsApp faz (reação, edição e "apagar para todos"). */
export interface EfeitoEmMensagem {
  tipo: 'apagar' | 'editar' | 'reagir';
  /** wa_message_id da mensagem ALVO. */
  alvoWaId: string;
  /** texto novo (editar) ou emoji (reagir). Vazio em reagir = reação removida. */
  texto?: string;
}

export interface ConteudoClassificado {
  tipo: TipoMensagem;
  /** Texto da mensagem ou legenda da mídia. Legenda e mídia são a MESMA
   *  mensagem no WhatsApp — nunca virar duas bolhas. */
  texto?: string;
  midia?: MidiaDescritor;
  /** Payload que não virou coluna: coordenadas, vCard, opções de enquete,
   *  ou a chave do tipo que não reconhecemos. */
  conteudoExtra?: Record<string, unknown>;
  /** `stanzaId` da mensagem citada (resposta). Resolvido para o id local em
   *  services/mensagens.ts — aqui só o identificador do WhatsApp. */
  citandoWaId?: string;
  /** Preenchido em vez de `tipo` quando a mensagem é um efeito. Quem chama
   *  DEVE tratar antes de inserir: inserir um efeito como linha nova polui a
   *  thread com uma bolha que o WhatsApp não mostra. */
  efeito?: EfeitoEmMensagem;
  /** Ruído de protocolo (distribuição de chave, contexto puro). Não é erro e
   *  não vira linha — é o único descarte legítimo. */
  ignorar?: boolean;
}

/** Chaves que o WhatsApp usa só para transporte/criptografia. */
const CHAVES_DE_RUIDO = new Set([
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'deviceSentMessage',
  'protocolMessage',
]);

/** Envelopes que embrulham a mensagem de verdade. */
const CHAVES_ENVELOPE = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
] as const;

/**
 * Descasca os envelopes até chegar no conteúdo real.
 *
 * Mensagem temporária ("desaparece em 24h") e "ver uma vez" chegam embrulhadas
 * — sem isto, uma foto enviada com a opção de mensagem temporária ligada (o
 * padrão em muitos celulares hoje) seria classificada como desconhecida.
 *
 * `limite` protege contra envelope recursivo malformado.
 */
export function desembrulhar(message: any, limite = 5): any {
  let atual = message;
  for (let i = 0; i < limite && atual; i += 1) {
    const envelope = CHAVES_ENVELOPE.find((k) => atual?.[k]?.message);
    if (!envelope) return atual;
    atual = atual[envelope].message;
  }
  return atual;
}

function texto(valor: unknown): string | undefined {
  const s = typeof valor === 'string' ? valor.trim() : '';
  return s || undefined;
}

function numero(valor: unknown): number | undefined {
  // fileLength/seconds vêm como Long do protobufjs em alguns caminhos —
  // Number(objeto) devolveria NaN sem o toNumber().
  if (valor === null || valor === undefined) return undefined;
  const bruto =
    typeof valor === 'object' && valor !== null && typeof (valor as any).toNumber === 'function'
      ? (valor as any).toNumber()
      : valor;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function thumbnail(no: any): Buffer | undefined {
  const bruto = no?.jpegThumbnail;
  if (!bruto) return undefined;
  try {
    const buf = Buffer.isBuffer(bruto) ? bruto : Buffer.from(bruto);
    return buf.length > 0 ? buf : undefined;
  } catch {
    return undefined;
  }
}

function citacao(no: any): string | undefined {
  return texto(no?.contextInfo?.stanzaId);
}

/** Buffer/Uint8Array do proto → base64, para caber num jsonb. */
function base64(valor: unknown): string | null {
  if (!valor) return null;
  if (typeof valor === 'string') return valor;
  try {
    return Buffer.from(valor as Uint8Array).toString('base64');
  } catch {
    return null;
  }
}

/** Extrai a referência de download de um nó de mídia do proto. */
export function refDoNo(no: any): RefDownload {
  return {
    url: typeof no?.url === 'string' ? no.url : null,
    directPath: typeof no?.directPath === 'string' ? no.directPath : null,
    mediaKey: base64(no?.mediaKey),
    fileEncSha256: base64(no?.fileEncSha256),
    fileSha256: base64(no?.fileSha256),
    mediaKeyTimestamp: numero(no?.mediaKeyTimestamp) ?? null,
  };
}

/** Valores de `proto.Message.ProtocolMessage.Type` relevantes. Comparados
 *  como número E como string: o Baileys decodifica o enum como número, mas
 *  payload vindo de mock/teste costuma trazer o nome. */
function ehTipoProtocolo(valor: unknown, numerico: number, nome: string): boolean {
  return valor === numerico || valor === nome;
}

function classificarProtocolo(protocolo: any): ConteudoClassificado {
  const alvoWaId = texto(protocolo?.key?.id);
  const tipo = protocolo?.type;

  if (alvoWaId && ehTipoProtocolo(tipo, 0, 'REVOKE')) {
    return { tipo: 'sistema', efeito: { tipo: 'apagar', alvoWaId } };
  }
  if (alvoWaId && ehTipoProtocolo(tipo, 14, 'MESSAGE_EDIT')) {
    // `editedMessage` é um `Message` direto no proto, mas alguns caminhos
    // (e mocks) o entregam embrulhado em `.message`. Aceitar os dois evita
    // que uma edição vire "sem texto novo" e seja descartada.
    const novo = desembrulhar(protocolo?.editedMessage?.message ?? protocolo?.editedMessage);
    const textoNovo = texto(novo?.conversation) ?? texto(novo?.extendedTextMessage?.text);
    return { tipo: 'sistema', efeito: { tipo: 'editar', alvoWaId, texto: textoNovo } };
  }
  // Ajuste de temporizador de mensagem efêmera, sincronização de app, etc.
  return { tipo: 'sistema', ignorar: true };
}

/**
 * Classifica o conteúdo de uma mensagem já desembrulhada.
 *
 * Nunca lança: entrada malformada devolve `desconhecido` com o que der para
 * preservar. É chamada dentro do laço de `messages.upsert`, que é serial —
 * uma exceção aqui pararia a fila da linha inteira.
 */
export function classificarConteudo(messageBruta: any): ConteudoClassificado {
  try {
    // protocolMessage é lido ANTES de desembrulhar: a edição vem como
    // protocolMessage cujo `editedMessage` é justamente um envelope, e
    // desembrulhar primeiro faria a edição parecer uma mensagem nova.
    if (messageBruta?.protocolMessage) return classificarProtocolo(messageBruta.protocolMessage);

    const m = desembrulhar(messageBruta);
    if (!m || typeof m !== 'object') return { tipo: 'desconhecido', ignorar: true };

    if (m.reactionMessage) {
      const alvoWaId = texto(m.reactionMessage?.key?.id);
      if (!alvoWaId) return { tipo: 'sistema', ignorar: true };
      // texto vazio = o usuário REMOVEU a reação. Não é ruído: a bolha tem
      // que perder o emoji.
      return {
        tipo: 'sistema',
        efeito: { tipo: 'reagir', alvoWaId, texto: texto(m.reactionMessage?.text) ?? '' },
      };
    }

    if (m.conversation) {
      return { tipo: 'texto', texto: texto(m.conversation) };
    }

    if (m.extendedTextMessage) {
      const no = m.extendedTextMessage;
      return { tipo: 'texto', texto: texto(no.text), citandoWaId: citacao(no) };
    }

    if (m.imageMessage) {
      const no = m.imageMessage;
      return {
        tipo: 'imagem',
        texto: texto(no.caption),
        citandoWaId: citacao(no),
        midia: {
          tipoMime: texto(no.mimetype) ?? 'image/jpeg',
          tamanho: numero(no.fileLength),
          largura: numero(no.width),
          altura: numero(no.height),
          thumbnail: thumbnail(no),
          ref: refDoNo(no),
        },
      };
    }

    if (m.videoMessage) {
      const no = m.videoMessage;
      return {
        tipo: 'video',
        texto: texto(no.caption),
        citandoWaId: citacao(no),
        midia: {
          tipoMime: texto(no.mimetype) ?? 'video/mp4',
          tamanho: numero(no.fileLength),
          duracaoSeg: numero(no.seconds),
          largura: numero(no.width),
          altura: numero(no.height),
          thumbnail: thumbnail(no),
          ref: refDoNo(no),
        },
        conteudoExtra: no.gifPlayback ? { gif: true } : undefined,
      };
    }

    if (m.audioMessage) {
      const no = m.audioMessage;
      // `ptt` distingue nota de voz (gravada no microfone, com onda) de um
      // arquivo de áudio anexado. A tela mostra os dois com player, mas o
      // rótulo e o ícone mudam — é a diferença que o atendente enxerga.
      return {
        tipo: no.ptt ? 'voz' : 'audio',
        citandoWaId: citacao(no),
        midia: {
          tipoMime: texto(no.mimetype) ?? 'audio/ogg; codecs=opus',
          tamanho: numero(no.fileLength),
          duracaoSeg: numero(no.seconds),
          ref: refDoNo(no),
        },
      };
    }

    if (m.documentMessage) {
      const no = m.documentMessage;
      return {
        tipo: 'documento',
        texto: texto(no.caption),
        citandoWaId: citacao(no),
        midia: {
          tipoMime: texto(no.mimetype) ?? 'application/octet-stream',
          nome: texto(no.fileName),
          tamanho: numero(no.fileLength),
          thumbnail: thumbnail(no),
          ref: refDoNo(no),
        },
        conteudoExtra: numero(no.pageCount) ? { paginas: numero(no.pageCount) } : undefined,
      };
    }

    if (m.stickerMessage) {
      const no = m.stickerMessage;
      return {
        tipo: 'figurinha',
        midia: {
          tipoMime: texto(no.mimetype) ?? 'image/webp',
          tamanho: numero(no.fileLength),
          largura: numero(no.width),
          altura: numero(no.height),
          ref: refDoNo(no),
        },
        conteudoExtra: no.isAnimated ? { animada: true } : undefined,
      };
    }

    const local = m.locationMessage ?? m.liveLocationMessage;
    if (local) {
      const lat = numero(local.degreesLatitude) ?? Number(local.degreesLatitude);
      const lon = numero(local.degreesLongitude) ?? Number(local.degreesLongitude);
      return {
        tipo: 'localizacao',
        texto: texto(local.name) ?? texto(local.address) ?? texto(local.comment),
        citandoWaId: citacao(local),
        conteudoExtra: {
          latitude: Number.isFinite(lat) ? lat : null,
          longitude: Number.isFinite(lon) ? lon : null,
          endereco: texto(local.address) ?? null,
          aoVivo: !!m.liveLocationMessage,
        },
      };
    }

    if (m.contactMessage || m.contactsArrayMessage) {
      const arr = m.contactsArrayMessage;
      const contatos = arr
        ? (arr.contacts ?? []).map((c: any) => ({
            nome: texto(c?.displayName) ?? null,
            vcard: texto(c?.vcard) ?? null,
          }))
        : [
            {
              nome: texto(m.contactMessage?.displayName) ?? null,
              vcard: texto(m.contactMessage?.vcard) ?? null,
            },
          ];
      return {
        tipo: 'contato',
        texto: contatos.map((c: any) => c.nome).filter(Boolean).join(', ') || undefined,
        conteudoExtra: { contatos },
      };
    }

    const enquete =
      m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
    if (enquete) {
      return {
        tipo: 'enquete',
        texto: texto(enquete.name),
        conteudoExtra: {
          opcoes: (enquete.options ?? [])
            .map((o: any) => texto(o?.optionName))
            .filter(Boolean),
          selecionaveis: numero(enquete.selectableOptionsCount) ?? null,
        },
      };
    }
    if (m.pollUpdateMessage) {
      // O voto vem criptografado e só é legível com a chave da enquete —
      // decifrar está fora do escopo. Ignorar é honesto; inventar "alguém
      // votou" sem saber em quê seria pior.
      return { tipo: 'sistema', ignorar: true };
    }

    // Respostas de botão/lista: o cliente clicou, e o que importa é o rótulo.
    const respostaBotao =
      texto(m.buttonsResponseMessage?.selectedDisplayText) ??
      texto(m.templateButtonReplyMessage?.selectedDisplayText) ??
      texto(m.listResponseMessage?.title) ??
      texto(m.listResponseMessage?.singleSelectReply?.selectedRowId);
    if (respostaBotao) {
      return { tipo: 'texto', texto: respostaBotao };
    }

    const chaves = Object.keys(m).filter((k) => !CHAVES_DE_RUIDO.has(k));
    if (chaves.length === 0) return { tipo: 'sistema', ignorar: true };

    // Fim da linha: tipo que não conhecemos. Grava mesmo assim, com a chave
    // preservada — é o que permite descobrir DEPOIS o que apareceu de novo,
    // em vez de o atendente ver um buraco na conversa.
    return {
      tipo: 'desconhecido',
      conteudoExtra: { chaves },
    };
  } catch (err) {
    return {
      tipo: 'desconhecido',
      conteudoExtra: { erro: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** Extensão de arquivo a partir do MIME, para o nome do objeto no bucket.
 *  Preferir a extensão do nome original quando ele existe (documento). */
export function extensaoDe(tipoMime: string | undefined, nomeOriginal?: string): string {
  const doNome = nomeOriginal?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  if (doNome) return doNome;
  const base = (tipoMime ?? '').split(';')[0].trim().toLowerCase();
  const mapa: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/amr': 'amr',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'text/plain': 'txt',
  };
  if (mapa[base]) return mapa[base];
  const sufixo = base.split('/')[1]?.replace(/[^a-z0-9]/g, '');
  return sufixo && sufixo.length <= 8 ? sufixo : 'bin';
}

/** Rótulo curto para prompt de IA e para a prévia da lista de conversas —
 *  o que aparece no lugar do texto quando a mensagem não tem texto. */
export function rotuloDoTipo(tipo: TipoMensagem): string {
  const mapa: Record<TipoMensagem, string> = {
    texto: 'mensagem',
    imagem: 'imagem',
    video: 'vídeo',
    audio: 'áudio',
    voz: 'áudio (nota de voz)',
    documento: 'documento',
    figurinha: 'figurinha',
    localizacao: 'localização',
    contato: 'contato',
    enquete: 'enquete',
    sistema: 'aviso do sistema',
    desconhecido: 'mensagem não suportada',
  };
  return mapa[tipo] ?? 'mensagem';
}
