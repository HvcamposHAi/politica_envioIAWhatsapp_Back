// Teste pontual: GET/POST /configuracoes/twilio — guarda de admin,
// validação de formato/credencial ao vivo, e que o save só grava depois
// da validação passar. Mocka auth/db/Twilio/Secret Manager — não toca
// rede nem GCP real.
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_USER_ID = 'user-admin-1';
const OPERADOR_USER_ID = 'user-operador-1';

let perfilPorUserId: Record<string, { id: string; perfil: string } | null>;

vi.mock('../auth/middleware.js', () => ({
  requireSupabaseAuth: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const userId = req.headers['x-teste-user-id'] as string;
    req.auth = { userId, claims: {} };
    next();
  },
}));

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: perfilPorUserId[currentUserId] ?? null, error: null }),
          }),
        }),
      }),
    }),
  },
}));

let currentUserId = '';

const accountsFetchMock = vi.fn();
vi.mock('../channels/twilio.adapter.js', () => ({
  criarClienteTwilio: vi.fn(() => ({ api: { v2010: { accounts: () => ({ fetch: accountsFetchMock }) } } })),
}));

const adicionarVersaoSecretMock = vi.fn();
vi.mock('../gcp/secretManager.js', () => ({
  adicionarVersaoSecret: adicionarVersaoSecretMock,
}));

const obterCredenciaisTwilioMock = vi.fn();
const invalidarCacheMock = vi.fn();
vi.mock('../services/twilioCredenciais.js', () => ({
  obterCredenciaisTwilio: obterCredenciaisTwilioMock,
  invalidarCacheCredenciaisTwilio: invalidarCacheMock,
}));

const { configuracoesRouter } = await import('./configuracoes.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(configuracoesRouter);
  return app;
}

const ACCOUNT_SID_VALIDO = 'AC' + 'a'.repeat(32);
const AUTH_TOKEN_VALIDO = 'b'.repeat(32);

describe('/configuracoes/twilio', () => {
  beforeEach(() => {
    process.env.GCP_PROJECT_ID = 'projeto-teste';
    perfilPorUserId = {
      [ADMIN_USER_ID]: { id: 'atendente-admin', perfil: 'admin' },
      [OPERADOR_USER_ID]: { id: 'atendente-operador', perfil: 'operador' },
    };
    accountsFetchMock.mockReset().mockResolvedValue({ sid: ACCOUNT_SID_VALIDO });
    obterCredenciaisTwilioMock.mockReset();
    adicionarVersaoSecretMock.mockReset().mockResolvedValue(undefined);
    invalidarCacheMock.mockReset();
  });

  // process.env é global do processo — não isolado por arquivo de teste.
  afterEach(() => {
    delete process.env.GCP_PROJECT_ID;
  });

  describe('GET', () => {
    it('não-admin -> 403', async () => {
      currentUserId = OPERADOR_USER_ID;
      const res = await request(montarApp()).get('/configuracoes/twilio').set('X-Teste-User-Id', OPERADOR_USER_ID);
      expect(res.status).toBe(403);
    });

    it('admin, credenciais configuradas -> configurado=true com SID mascarado, sem expor authToken', async () => {
      currentUserId = ADMIN_USER_ID;
      obterCredenciaisTwilioMock.mockResolvedValue({ accountSid: ACCOUNT_SID_VALIDO, authToken: 'algum-token' });

      const res = await request(montarApp()).get('/configuracoes/twilio').set('X-Teste-User-Id', ADMIN_USER_ID);

      expect(res.status).toBe(200);
      expect(res.body.configurado).toBe(true);
      expect(res.body.accountSidMascarado).toBe(`${ACCOUNT_SID_VALIDO.slice(0, 6)}…${ACCOUNT_SID_VALIDO.slice(-4)}`);
      expect(JSON.stringify(res.body)).not.toContain('algum-token');
    });

    it('admin, nada configurado -> configurado=false (mesmo erro que obterCredenciaisTwilio lança quando falta secret)', async () => {
      currentUserId = ADMIN_USER_ID;
      obterCredenciaisTwilioMock.mockRejectedValue(new Error('Credenciais Twilio não configuradas.'));

      const res = await request(montarApp()).get('/configuracoes/twilio').set('X-Teste-User-Id', ADMIN_USER_ID);

      expect(res.status).toBe(200);
      expect(res.body.configurado).toBe(false);
    });
  });

  describe('POST', () => {
    it('não-admin -> 403, nada é salvo', async () => {
      currentUserId = OPERADOR_USER_ID;
      const res = await request(montarApp())
        .post('/configuracoes/twilio')
        .set('X-Teste-User-Id', OPERADOR_USER_ID)
        .send({ accountSid: ACCOUNT_SID_VALIDO, authToken: AUTH_TOKEN_VALIDO });

      expect(res.status).toBe(403);
      expect(adicionarVersaoSecretMock).not.toHaveBeenCalled();
    });

    it('formato de accountSid inválido -> 400, nada é salvo', async () => {
      currentUserId = ADMIN_USER_ID;
      const res = await request(montarApp())
        .post('/configuracoes/twilio')
        .set('X-Teste-User-Id', ADMIN_USER_ID)
        .send({ accountSid: 'sid-invalido', authToken: AUTH_TOKEN_VALIDO });

      expect(res.status).toBe(400);
      expect(adicionarVersaoSecretMock).not.toHaveBeenCalled();
    });

    it('credencial rejeitada pela Twilio (accounts.fetch falha) -> 400, nada é salvo', async () => {
      currentUserId = ADMIN_USER_ID;
      accountsFetchMock.mockRejectedValue(new Error('Authenticate'));

      const res = await request(montarApp())
        .post('/configuracoes/twilio')
        .set('X-Teste-User-Id', ADMIN_USER_ID)
        .send({ accountSid: ACCOUNT_SID_VALIDO, authToken: AUTH_TOKEN_VALIDO });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Authenticate');
      expect(adicionarVersaoSecretMock).not.toHaveBeenCalled();
    });

    it('admin + credencial válida -> salva os dois secrets, invalida cache, 200', async () => {
      currentUserId = ADMIN_USER_ID;

      const res = await request(montarApp())
        .post('/configuracoes/twilio')
        .set('X-Teste-User-Id', ADMIN_USER_ID)
        .send({ accountSid: ACCOUNT_SID_VALIDO, authToken: AUTH_TOKEN_VALIDO });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      expect(adicionarVersaoSecretMock).toHaveBeenCalledWith('hub-twilio-account-sid', ACCOUNT_SID_VALIDO);
      expect(adicionarVersaoSecretMock).toHaveBeenCalledWith('hub-twilio-auth-token', AUTH_TOKEN_VALIDO);
      expect(invalidarCacheMock).toHaveBeenCalledOnce();
    });
  });
});
