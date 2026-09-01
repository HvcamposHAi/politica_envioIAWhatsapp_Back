// ChannelPort — a abstração da especificação (plano-base §5).
//
// "ChannelPort implementado ANTES dos adapters" é ordem obrigatória, não
// sugestão: escrever o adapter Baileys primeiro tende a vazar detalhe do
// Baileys (formato de JID, shape de evento) para cima, e todo canal
// subsequente (Twilio, Fase 8) herda o vazamento. Este arquivo existe
// para ser a única coisa que `routes/` e `jobs/` conhecem — nem
// `baileys.adapter.ts` nem `twilio.adapter.ts` deveriam ser importados
// fora de `registry.ts`.
//
// STATUS: interface definida (Fase 3.9). Implementação dos adapters é
// Fase 5 (Baileys) e Fase 8 (Twilio) — não iniciada nesta passada.

import type {
  EfeitoEmMensagem,
  MidiaDescritor,
  RefDownload,
  TipoMensagem,
} from './mensagemWhatsApp.js';

export type StatusConexao =
  | 'desconectado'
  | 'lendo_qr'
  | 'conectando'
  | 'conectado'
  | 'instavel'
  | 'caido';

export interface EnvioMensagem {
  conversaId: string;
  telefone: string;
  texto?: string;
  midiaUrl?: string;
  midiaTipo?: string;
  /** Binário a enviar (anexo do atendente). O adapter decide o formato do
   *  stanza a partir de `midiaTipo`/`midiaClasse` — imagem, vídeo, áudio ou
   *  documento não são o mesmo tipo de mensagem no WhatsApp, e mandar tudo
   *  como documento tira a prévia, o player e a onda do áudio. */
  midiaBuffer?: Buffer;
  /** Caminho do objeto no bucket. O Baileys manda o binário (midiaBuffer); a
   *  Twilio é REST e exige uma URL que ELA consiga buscar — daí este campo,
   *  que o adapter Twilio converte numa URL assinada de curta duração. */
  midiaObjeto?: string;
  /** Classe já resolvida pela rota (imagem|video|audio|voz|documento). Evita
   *  o adapter reinterpretar MIME por conta própria e divergir da validação
   *  por magic bytes que a rota já fez. */
  midiaClasse?: 'imagem' | 'video' | 'audio' | 'voz' | 'documento';
  /** Nome original do arquivo — é o que o cliente vê ao receber um documento. */
  midiaNome?: string;
  /** Duração em segundos, quando conhecida (nota de voz). */
  midiaDuracaoSeg?: number;
  /** wa_message_id da mensagem sendo respondida, se houver. */
  respondendoA?: string;
  /** JID técnico completo do destinatário (hub.clientes.wa_jid), quando
   *  conhecido. Quando presente, o adapter deve enviar para ESTE JID em vez
   *  de reconstruir "${telefone}@s.whatsapp.net" — obrigatório para chegar
   *  em contatos roteados por `@lid` (ver PLANO_CORRECAO_IDENTIFICACAO_LID_
   *  WHATSAPP.md §1). Ignorado por transportes sem esse conceito (Twilio). */
  waJidDestino?: string;
}

export interface ResultadoEnvio {
  /** id da mensagem no provedor (wa_message_id). Chave de idempotência. */
  waMessageId: string;
  status: 'enviada' | 'falhou';
  erro?: string;
}

export interface EventoRecebido {
  waMessageId: string;
  telefone: string;
  texto?: string;
  midiaUrl?: string;
  midiaTipo?: string;
  recebidoEm: Date;
  /** Tipo do conteúdo (imagem, vídeo, áudio, documento, localização…).
   *  Ausente = 'texto', que é como todo evento se comportava antes desta
   *  feature — é o que mantém o webhook da Twilio funcionando sem mudança. */
  tipo?: TipoMensagem;
  /** Descritor da mídia, com a referência de download. Quem grava a mensagem
   *  enfileira o binário DEPOIS do insert (a fila é assíncrona de propósito —
   *  ver services/filaMidia.ts). */
  midia?: MidiaDescritor;
  /** Pede ao WhatsApp que reenvie a mídia quando a URL original expirou.
   *  Só existe enquanto o proto está em memória; some no restart. */
  reobterRefMidia?: () => Promise<RefDownload | null>;
  /** Coordenadas, vCard, opções de enquete — o que não virou coluna. */
  conteudoExtra?: Record<string, unknown>;
  /** `stanzaId` da mensagem citada (resposta), resolvido depois para o id local. */
  citandoWaId?: string;
  /** Mensagem que ALTERA outra em vez de criar linha nova (reação, edição,
   *  "apagar para todos"). Quem processa deve tratar antes de inserir. */
  efeito?: EfeitoEmMensagem;
  /** Conversa de GRUPO. Muda tudo o que vem depois: o "cliente" é o grupo, o
   *  autor real vai em autorWaJid/autorNome, e CSAT e IA não rodam. */
  ehGrupo?: boolean;
  /** Assunto do grupo, quando o adapter conseguiu resolver. */
  nomeGrupo?: string;
  /** JID de quem escreveu DENTRO do grupo (o participante, não o grupo). */
  autorWaJid?: string;
  /** Nome de exibição de quem escreveu dentro do grupo. */
  autorNome?: string;
  /** 'atendente' quando a mensagem veio do próprio celular pareado (eco de
   *  `fromMe` no Baileys) — precisa entrar na thread do mesmo jeito que uma
   *  mensagem de cliente, só que como saída. 'cliente' no caso normal. */
  origem: 'cliente' | 'atendente';
  /** Nome de exibição do contato no canal (pushName do Baileys, ProfileName
   *  do Twilio), quando o provedor o envia. Quem decide se isto atualiza
   *  hub.clientes.nome é services/mensagens.ts — nunca usar quando
   *  origem === 'atendente' (nesse caso é o nome do próprio atendente/
   *  celular pareado, não do cliente). */
  nomeContato?: string;
  /** JID completo normalizado de quem mandou a mensagem (ex.:
   *  "5541999998888@s.whatsapp.net" ou "120363...@lid"). Fonte de verdade
   *  para roteamento de resposta — nunca reconstruir a partir de `telefone`
   *  quando este campo existir (ver PLANO_CORRECAO_IDENTIFICACAO_LID_
   *  WHATSAPP.md §4.3). Sempre repassado, independente de `origem`: é só um
   *  identificador de roteamento, não carrega dado pessoal do atendente. */
  waJidOrigem?: string;
}

/**
 * Um canal (linha de WhatsApp) fala este contrato, independente de ser
 * uma sessão Baileys (conversacional, `hub.canal_sessoes`) ou um sender
 * Twilio (campanha, sem estado de sessão local).
 */
export interface ChannelPort {
  readonly canalId: string;
  readonly transporte: 'baileys' | 'twilio';

  /** Inicia a sessão. Para Baileys, emite QR via hub.eventos_canal /
   *  Realtime. Para Twilio, é no-op ou valida credencial. */
  conectar(): Promise<void>;

  /** Encerra a sessão. Idempotente.
   *
   *  Sem `opcoes`, ou `preservarSessao: false` (default): logout de
   *  verdade — desvincula o aparelho no WhatsApp. É o que o usuário espera
   *  ao clicar em "Desconectar linha" (routes/canais.ts, DELETE
   *  /canais/:id/sessao).
   *
   *  `preservarSessao: true`: fecha o socket local sem desvincular —
   *  as credenciais em hub.canal_sessoes continuam válidas para
   *  reconectar sem novo QR. Único uso correto: desligamento gracioso do
   *  PROCESSO (registry.ts:desconectarTodosOsCanais, chamado do SIGTERM em
   *  server.ts), nunca de uma ação do usuário. Antes desta distinção,
   *  todo restart do Cloud Run chamava logout() de verdade — causa raiz do
   *  incidente 2026-08-07 ("mensagens recebidas não aparecem": 10 restarts
   *  em ~18h desvincularam o aparelho 10 vezes, e nada reconectava
   *  sozinho). Ignorado por transportes sem sessão local persistente
   *  (Twilio). */
  desconectar(opcoes?: { preservarSessao?: boolean }): Promise<void>;

  status(): Promise<StatusConexao>;

  enviar(msg: EnvioMensagem): Promise<ResultadoEnvio>;

  /** Registra o handler de mensagens recebidas. Um canal, um handler. */
  aoReceber(handler: (evento: EventoRecebido) => Promise<void>): void;
}

/** Erro específico: transporte não suporta a operação pedida (ex.: disparo
 *  em massa em canal Baileys). Ver também o trigger de banco
 *  `hub.impede_disparo_baileys` — o bloqueio existe nas DUAS camadas. */
// Duplicado de propósito do rótulo do front (src/lib/transporte.ts) — os
// dois repos não compartilham types (ver api.ts do front). Mantém a mesma
// linguagem de negócio na mensagem de erro que chega ao toast do usuário.
// Twilio ganhou adapter real para conversas 1:1 (twilio.adapter.ts) — não é
// mais exclusivo de disparo em massa. Mantém sincronizado com o rótulo do
// front (src/lib/transporte.ts).
const ROTULO_TRANSPORTE: Record<string, string> = {
  baileys: 'Baileys (mensagens individuais)',
  twilio: 'Twilio (linha oficial, mensagens individuais)',
};

export class OperacaoNaoSuportadaError extends Error {
  constructor(transporte: string, operacao: string) {
    const rotulo = ROTULO_TRANSPORTE[transporte] ?? transporte;
    super(`Canal ${rotulo} não suporta: ${operacao}`);
    this.name = 'OperacaoNaoSuportadaError';
  }
}
