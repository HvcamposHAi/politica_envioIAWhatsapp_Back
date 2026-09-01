// Teste pontual (F2 do plano de implementação Twilio): TwilioChannel.enviar().
// Mocka o pacote `twilio` inteiro — não toca rede nem hub.canais/hub.mensagens.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagesCreateMock = vi.fn();

vi.mock('twilio', () => {
  const twilioFactory = vi.fn(() => ({
    accountSid: 'ACfake0000000000000000000000000',
    messages: { create: messagesCreateMock },
    api: { v2010: { accounts: () => ({ fetch: vi.fn() }) } },
  }));
  return { default: Object.assign(twilioFactory, { validateRequest: vi.fn() }) };
});

const { TwilioChannel } = await import('./twilio.adapter.js');

// Credenciais passadas direto ao construtor (quem resolve é registry.ts,
// via services/twilioCredenciais.ts — fora do escopo deste teste). Não lê
// mais process.env.TWILIO_ACCOUNT_SID/AUTH_TOKEN.
const CREDENCIAIS = { accountSid: 'ACfake0000000000000000000000000', authToken: 'fake-auth-token' };

describe('TwilioChannel.enviar()', () => {
  beforeEach(() => {
    // desconectar() grava em hub.canais/hub.eventos_canal via supabaseAdmin
    // (só falha de config, não de rede, precisa ser evitada aqui) — o teste
    // de "recusa enviar quando desconectado" não valida esse write.
    process.env.SUPABASE_URL ??= 'http://localhost:0';
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'fake-service-role-key';
    messagesCreateMock.mockReset();
  });

  it('nasce com statusAtual = conectado (não desconectado, diferente do Baileys)', async () => {
    messagesCreateMock.mockResolvedValue({ sid: 'SMxxx' });
    const canal = new TwilioChannel('canal-1', '+55 41 3333-1010', CREDENCIAIS);
    expect(await canal.status()).toBe('conectado');
  });

  it('envia com to/from prefixados whatsapp:+E164, normalizando espaço/traço do número', async () => {
    messagesCreateMock.mockResolvedValue({ sid: 'SM123' });
    const canal = new TwilioChannel('canal-1', '+55 41 3333-1010', CREDENCIAIS);

    const resultado = await canal.enviar({ conversaId: 'conv-1', telefone: '(41) 99999-8888', texto: 'oi' });

    expect(messagesCreateMock).toHaveBeenCalledWith({
      to: 'whatsapp:+5541999998888',
      from: 'whatsapp:+554133331010',
      body: 'oi',
    });
    expect(resultado).toEqual({ waMessageId: 'SM123', status: 'enviada' });
  });

  it('retorna falhou (sem propagar exceção) quando a Twilio rejeita o envio', async () => {
    messagesCreateMock.mockRejectedValue(new Error('Twilio: 21211 número inválido'));
    const canal = new TwilioChannel('canal-1', '+55 41 3333-1010', CREDENCIAIS);

    const resultado = await canal.enviar({ conversaId: 'conv-1', telefone: '5541999998888', texto: 'oi' });

    expect(resultado.status).toBe('falhou');
    expect(resultado.waMessageId).toBe('');
    expect(resultado.erro).toContain('21211');
  });

  it('recusa enviar quando o canal não está conectado (desconectar() foi chamado)', async () => {
    const canal = new TwilioChannel('canal-1', '+55 41 3333-1010', CREDENCIAIS);
    // desconectar() grava em hub.eventos_canal/hub.canais — não é o foco
    // deste teste, então só forçamos o estado interno via desconectar().
    await canal.desconectar().catch(() => undefined);

    const resultado = await canal.enviar({ conversaId: 'conv-1', telefone: '5541999998888', texto: 'oi' });

    expect(resultado).toEqual({ waMessageId: '', status: 'falhou', erro: 'canal não conectado' });
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });
});
