// Testes do webhook Twilio (plano de implementação Twilio):
//   F1 — validação de assinatura X-Twilio-Signature (assinatura calculada
//        de forma independente via node:crypto, não reaproveitando
//        internals do pacote `twilio`, pra não virar teste tautológico).
//   F3 — E2E de verdade contra hub.mensagens. Gated por RUN_DB_TESTS=1
//        porque grava/apaga linhas num projeto Supabase real (não há
//        projeto de staging separado neste repo hoje — ver plano seção F).
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_URL = 'https://hub-api-teste.example.com';
const AUTH_TOKEN = 'test-auth-token-1234567890';

// GCP_PROJECT_ID fica ausente de propósito — obterCredenciaisTwilio() cai
// no modo dev/env var (services/twilioCredenciais.ts), sem precisar mockar
// o Secret Manager aqui. Precisa das DUAS vars: o par é buscado junto,
// mesmo que só o Auth Token seja usado na validação de assinatura.
process.env.TWILIO_ACCOUNT_SID = 'ACfake0000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_WEBHOOK_BASE_URL = BASE_URL;

const processarEventoRecebidoMock = vi.fn().mockResolvedValue(undefined);
const atualizarStatusEntregaMock = vi.fn().mockResolvedValue(true);

vi.mock('../services/mensagens.js', () => ({
  processarEventoRecebido: processarEventoRecebidoMock,
  atualizarStatusEntregaPorWaMessageId: atualizarStatusEntregaMock,
}));

const { twilioWebhookRouter } = await import('./twilio.js');

function montarApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // Mesmo prefixo de server.ts — rotas do router são relativas
  // (/:canalId/inbound), o prefixo é quem faz o caminho público bater
  // (ver comentário em server.ts sobre o incidente hub-api-00003-26z).
  app.use('/webhooks/twilio', twilioWebhookRouter);
  return app;
}

/** Algoritmo oficial da Twilio: HMAC-SHA1(authToken, url + params ordenados
 *  por chave, concatenados sem separador), base64. Implementado aqui do
 *  zero — não usa twilio.getExpectedTwilioSignature — pra o teste ser uma
 *  checagem independente do código de produção, não um espelho dele. */
function assinar(authToken: string, url: string, params: Record<string, string>): string {
  const chavesOrdenadas = Object.keys(params).sort();
  let dados = url;
  for (const chave of chavesOrdenadas) dados += chave + params[chave];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(dados, 'utf-8')).digest('base64');
}

describe('validação de assinatura X-Twilio-Signature', () => {
  const canalId = 'canal-teste-123';
  const path = `/webhooks/twilio/${canalId}/inbound`;
  const url = `${BASE_URL}${path}`;
  const params = { MessageSid: 'SM123', From: 'whatsapp:+5541999998888', Body: 'oi' };

  beforeEach(() => {
    processarEventoRecebidoMock.mockClear();
  });

  it('assinatura correta -> 200 e processarEventoRecebido chamado', async () => {
    const assinatura = assinar(AUTH_TOKEN, url, params);

    const res = await request(montarApp())
      .post(path)
      .set('X-Twilio-Signature', assinatura)
      .type('form')
      .send(params);

    expect(res.status).toBe(200);
    expect(processarEventoRecebidoMock).toHaveBeenCalledWith(canalId, {
      waMessageId: 'SM123',
      telefone: '+5541999998888',
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: expect.any(Date),
    });
  });

  it('ProfileName presente -> repassado como nomeContato (ver PLANO_CORRECAO_NOME_CONTATO.md §9.8)', async () => {
    const paramsComNome = { ...params, ProfileName: 'Cliente Twilio' };
    const assinatura = assinar(AUTH_TOKEN, url, paramsComNome);

    const res = await request(montarApp())
      .post(path)
      .set('X-Twilio-Signature', assinatura)
      .type('form')
      .send(paramsComNome);

    expect(res.status).toBe(200);
    expect(processarEventoRecebidoMock).toHaveBeenCalledWith(canalId, {
      waMessageId: 'SM123',
      telefone: '+5541999998888',
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: expect.any(Date),
      nomeContato: 'Cliente Twilio',
    });
  });

  it('assinatura errada (1 caractere trocado) -> 403 e processarEventoRecebido NÃO chamado', async () => {
    const assinaturaCorreta = assinar(AUTH_TOKEN, url, params);
    const assinaturaAdulterada =
      assinaturaCorreta.slice(0, -1) + (assinaturaCorreta.at(-1) === 'A' ? 'B' : 'A');

    const res = await request(montarApp())
      .post(path)
      .set('X-Twilio-Signature', assinaturaAdulterada)
      .type('form')
      .send(params);

    expect(res.status).toBe(403);
    expect(processarEventoRecebidoMock).not.toHaveBeenCalled();
  });

  it('sem header de assinatura -> 403', async () => {
    const res = await request(montarApp()).post(path).type('form').send(params);

    expect(res.status).toBe(403);
    expect(processarEventoRecebidoMock).not.toHaveBeenCalled();
  });

  it('callback de status assinado corretamente -> 200 e atualizarStatusEntregaPorWaMessageId chamado com o mapeamento certo', async () => {
    const statusPath = `/webhooks/twilio/${canalId}/status`;
    const statusUrl = `${BASE_URL}${statusPath}`;
    const statusParams = { MessageSid: 'SM123', MessageStatus: 'delivered' };
    const assinatura = assinar(AUTH_TOKEN, statusUrl, statusParams);

    const res = await request(montarApp())
      .post(statusPath)
      .set('X-Twilio-Signature', assinatura)
      .type('form')
      .send(statusParams);

    expect(res.status).toBe(200);
    expect(atualizarStatusEntregaMock).toHaveBeenCalledWith('SM123', 'entregue', null);
  });
});
