// Webhooks públicos da Twilio (plano de implementação Twilio) — a Twilio
// não tem JWT do Supabase, então NADA aqui passa por requireSupabaseAuth().
// A barreira de segurança é a assinatura X-Twilio-Signature, validada com
// o mesmo TWILIO_AUTH_TOKEN usado para enviar.
//
// Duas rotas, uma por número (cadastradas manualmente no Console da
// Twilio, por canalId — não por número, ver plano seção A2):
//   · POST /webhooks/twilio/:canalId/inbound — mensagem do cliente.
//   · POST /webhooks/twilio/:canalId/status  — callback de entrega.
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import twilio from 'twilio';
import { processarEventoRecebido, atualizarStatusEntregaPorWaMessageId } from '../services/mensagens.js';
import type { TipoMensagem } from '../channels/mensagemWhatsApp.js';
import { obterCredenciaisTwilio } from '../services/twilioCredenciais.js';

export const twilioWebhookRouter = Router();

// Cota própria, separada da API principal — tráfego de webhook não deve
// competir com nem ser limitado pelos 300/min do app (server.ts).
twilioWebhookRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Assinatura calculada sobre a URL PÚBLICA completa — a mesma cadastrada
// no Console da Twilio. Propositalmente NÃO usa req.protocol/req.get('host')
// (Cloud Run termina TLS antes do container; sem `trust proxy` bem
// configurado, req.protocol reporta 'http' e a assinatura nunca bate,
// mesmo pra request legítima). Erro de configuração aqui falha FECHADO
// (rejeita tudo, visível na hora), nunca aberto.
async function validarAssinatura(req: Request, res: Response, next: NextFunction): Promise<void> {
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  const assinatura = req.headers['x-twilio-signature'];

  if (!baseUrl) {
    res.status(500).json({ error: 'TWILIO_WEBHOOK_BASE_URL não configurado.' });
    return;
  }
  if (typeof assinatura !== 'string') {
    res.status(403).send('assinatura Twilio ausente');
    return;
  }

  let authToken: string;
  try {
    authToken = (await obterCredenciaisTwilio()).authToken;
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const url = `${baseUrl}${req.originalUrl}`;
  const valida = twilio.validateRequest(authToken, assinatura, url, req.body ?? {});
  if (!valida) {
    res.status(403).send('assinatura Twilio inválida');
    return;
  }
  next();
}

twilioWebhookRouter.use(validarAssinatura);

interface TwilioInboundBody {
  MessageSid?: string;
  From?: string;
  Body?: string;
  ProfileName?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
}

/** Classe do conteúdo a partir do MIME que a Twilio anuncia. Mesma tabela de
 *  tipos de channels/mensagemWhatsApp.ts, sem o proto do WhatsApp. */
function tipoDoMime(mime: string | undefined): TipoMensagem {
  const base = (mime ?? '').split('/')[0]?.toLowerCase();
  if (base === 'image') return 'imagem';
  if (base === 'video') return 'video';
  if (base === 'audio') return 'audio';
  if (mime) return 'documento';
  return 'texto';
}

twilioWebhookRouter.post('/:canalId/inbound', async (req, res) => {
  const { MessageSid, From, Body, ProfileName, NumMedia, MediaUrl0, MediaContentType0 } = (req.body ??
    {}) as TwilioInboundBody;
  const telefone = From?.replace(/^whatsapp:/i, '');

  if (!MessageSid || !telefone) {
    res.status(400).send('payload incompleto');
    return;
  }

  // A Twilio não empurra o binário: ela dá uma URL que exige autenticação
  // básica com a credencial da conta. Baixá-la é trabalho de uma passada
  // futura — mas a mensagem NÃO pode entrar como se fosse texto vazio, que é
  // exatamente o defeito que esta feature veio corrigir no lado do Baileys.
  // Grava com o tipo certo e o motivo explícito, para o atendente ver que
  // chegou um arquivo e saber por que ele não está aqui.
  const temMidia = Number(NumMedia ?? 0) > 0 && !!MediaUrl0;

  try {
    await processarEventoRecebido(req.params.canalId, {
      waMessageId: MessageSid,
      telefone,
      texto: Body,
      origem: 'cliente', // Twilio não tem eco fromMe — resposta do atendente entra por /conversas/:id/mensagens
      recebidoEm: new Date(),
      nomeContato: ProfileName?.trim() || undefined,
      // Campos de mídia entram SÓ quando há mídia. Mensagem de texto pela
      // Twilio continua produzindo exatamente o mesmo evento de antes desta
      // feature — não-regressão verificável, e é o que mantém
      // webhooks/twilio.test.ts passando sem edição.
      ...(temMidia
        ? {
            tipo: tipoDoMime(MediaContentType0),
            midiaUrl: MediaUrl0,
            midiaTipo: MediaContentType0 ?? 'application/octet-stream',
            conteudoExtra: {
              origemMidia: 'twilio',
              aviso: 'Arquivo recebido pela linha oficial — download ainda não disponível no Hub.',
            },
          }
        : {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`falha ao processar webhook Twilio inbound (canal=${req.params.canalId}, sid=${MessageSid}):`, err instanceof Error ? err.message : err);
    // 500 propositalmente: processarEventoRecebido já é idempotente em
    // wa_message_id, então um retry da Twilio é seguro e é o comportamento
    // desejado para falha genuinamente inesperada.
    res.status(500).send('falha ao processar');
    return;
  }

  res.type('text/xml').status(200).send('<Response></Response>');
});

interface TwilioStatusBody {
  MessageSid?: string;
  MessageStatus?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

const MAPA_STATUS_TWILIO: Record<string, string> = {
  queued: 'pendente',
  accepted: 'pendente',
  sent: 'enviada',
  delivered: 'entregue',
  read: 'lida',
  failed: 'falhou',
  undelivered: 'falhou',
};

twilioWebhookRouter.post('/:canalId/status', async (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = (req.body ?? {}) as TwilioStatusBody;

  if (!MessageSid || !MessageStatus) {
    res.status(400).send('payload incompleto');
    return;
  }

  const novoStatus = MAPA_STATUS_TWILIO[MessageStatus];
  if (!novoStatus) {
    // MessageStatus fora do mapa conhecido: log e 200 (não é motivo pra
    // Twilio ficar retentando).
    // eslint-disable-next-line no-console
    console.error(`MessageStatus Twilio desconhecido: ${MessageStatus} (sid=${MessageSid})`);
    res.sendStatus(200);
    return;
  }

  const detalheErro = ErrorCode ? `Twilio ${ErrorCode}: ${ErrorMessage ?? ''}`.trim() : null;

  try {
    await atualizarStatusEntregaPorWaMessageId(MessageSid, novoStatus, detalheErro);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`falha ao processar webhook Twilio status (canal=${req.params.canalId}, sid=${MessageSid}):`, err instanceof Error ? err.message : err);
  }

  res.sendStatus(200);
});
