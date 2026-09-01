// Teste E2E (F3 do plano de implementação Twilio): webhook Twilio inbound
// real -> hub.mensagens, sem mock de services/mensagens.js nem de
// supabaseAdmin. Prova que INSERT/SELECT/constraint reais funcionam, não só
// que a função certa foi chamada (isso já é coberto por twilio.test.ts).
//
// DESLIGADO POR PADRÃO: precisa de SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// configurados (mesmo projeto usado em dev, `zfbjwhaltqewbluqfmtt` — não há
// staging separado neste repo hoje) e grava/apaga uma empresa/canal
// marcados com nome `__teste_e2e_twilio__...`, sempre limpos no `finally`.
// Rodar com:
//   RUN_DB_TESTS=1 npm test -- twilio.e2e
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

const rodar = process.env.RUN_DB_TESTS ? describe : describe.skip;

const BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL ?? 'https://hub-api-teste.example.com';

function assinar(authToken: string, url: string, params: Record<string, string>): string {
  const chavesOrdenadas = Object.keys(params).sort();
  let dados = url;
  for (const chave of chavesOrdenadas) dados += chave + params[chave];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(dados, 'utf-8')).digest('base64');
}

rodar('E2E — webhook Twilio inbound até hub.mensagens (banco real)', () => {
  it('grava uma linha em hub.mensagens e é idempotente ao mesmo payload repetido', async () => {
    // obterCredenciaisTwilio() busca o par junto — precisa dos dois (ou de
    // GCP_PROJECT_ID + secrets reais, se rodando em modo Secret Manager).
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken || !process.env.TWILIO_ACCOUNT_SID) {
      throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN precisam estar setados pra rodar este teste (RUN_DB_TESTS=1).');
    }

    const { supabaseAdmin } = await import('../db/client.server.js');
    const { twilioWebhookRouter } = await import('./twilio.js');

    const nomeTeste = `__teste_e2e_twilio__${Date.now()}`;
    const { data: empresa, error: erroEmpresa } = await supabaseAdmin
      .from('empresas')
      .insert({ nome: nomeTeste, tipo: 'teste' })
      .select('id')
      .single();
    if (erroEmpresa || !empresa) throw new Error(`setup: falha ao criar empresa de teste: ${erroEmpresa?.message}`);

    const { data: canal, error: erroCanal } = await supabaseAdmin
      .from('canais')
      .insert({ empresa_id: empresa.id, nome: nomeTeste, numero: '+15550001111', transporte: 'twilio' })
      .select('id')
      .single();
    if (erroCanal || !canal) {
      await supabaseAdmin.from('empresas').delete().eq('id', empresa.id);
      throw new Error(`setup: falha ao criar canal de teste: ${erroCanal?.message}`);
    }

    try {
      const app = express();
      app.use(express.urlencoded({ extended: false }));
      app.use('/webhooks/twilio', twilioWebhookRouter);

      const path = `/webhooks/twilio/${canal.id}/inbound`;
      const url = `${BASE_URL}${path}`;
      const params = { MessageSid: `SM_e2e_${Date.now()}`, From: 'whatsapp:+5541988887777', Body: 'oi, teste e2e' };
      const assinatura = assinar(authToken, url, params);

      // Envia o mesmo payload assinado duas vezes — prova de idempotência
      // (mesmo mecanismo de UNIQUE_VIOLATION em wa_message_id do Baileys).
      await request(app).post(path).set('X-Twilio-Signature', assinatura).type('form').send(params);
      await request(app).post(path).set('X-Twilio-Signature', assinatura).type('form').send(params);

      const { data: mensagens, error: erroMensagens } = await supabaseAdmin
        .from('mensagens')
        .select('id, direcao, status_entrega, texto, wa_message_id')
        .eq('wa_message_id', params.MessageSid);

      if (erroMensagens) throw new Error(`falha ao ler hub.mensagens: ${erroMensagens.message}`);
      expect(mensagens).toHaveLength(1);
      expect(mensagens![0]).toMatchObject({
        direcao: 'entrada',
        status_entrega: 'entregue',
        texto: 'oi, teste e2e',
        wa_message_id: params.MessageSid,
      });
    } finally {
      // Limpeza explícita, em ordem de dependência — não confia em cascade.
      const { data: conversas } = await supabaseAdmin.from('conversas').select('id').eq('canal_id', canal.id);
      const conversaIds = (conversas ?? []).map((c: { id: string }) => c.id);
      if (conversaIds.length) await supabaseAdmin.from('mensagens').delete().in('conversa_id', conversaIds);
      await supabaseAdmin.from('conversas').delete().eq('canal_id', canal.id);
      await supabaseAdmin.from('clientes').delete().eq('empresa_id', empresa.id);
      await supabaseAdmin.from('canais').delete().eq('id', canal.id);
      await supabaseAdmin.from('empresas').delete().eq('id', empresa.id);
    }
  });
});
