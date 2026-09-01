// Teste pontual do incidente 2026-08-07 (convite de equipe deslogava o
// admin): confirma que requireSupabaseAuth() distingue "não consegui
// validar o token" (rede/infra do getClaims, retryable) de "token
// genuinamente inválido" — só o segundo caso pode responder 401, senão o
// front (chamarBackend) interpreta qualquer 401 como sessão morta e desloga
// o app inteiro por um problema que era só deste serviço.
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

const getClaimsMock = vi.fn();

vi.mock('@supabase/supabase-js', async () => {
  const real = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  return {
    ...real,
    createClient: () => ({ auth: { getClaims: getClaimsMock } }),
  };
});

process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_teste';

const { requireSupabaseAuth } = await import('./middleware.js');

const TOKEN_FORMATO_VALIDO = 'aaa.bbb.ccc';

function montarApp() {
  const app = express();
  app.use(requireSupabaseAuth());
  app.get('/protegido', (req, res) => res.json({ userId: req.auth?.userId }));
  return app;
}

describe('requireSupabaseAuth', () => {
  beforeEach(() => {
    getClaimsMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responde 503 (retryable) quando getClaims falha por erro de rede/infra, não 401', async () => {
    getClaimsMock.mockResolvedValue({
      data: null,
      error: new AuthRetryableFetchError('fetch failed', 0),
    });

    const res = await request(montarApp()).get('/protegido').set('Authorization', `Bearer ${TOKEN_FORMATO_VALIDO}`);

    expect(res.status).toBe(503);
  });

  it('responde 401 quando o token é genuinamente rejeitado pelo Supabase', async () => {
    getClaimsMock.mockResolvedValue({
      data: null,
      error: new AuthApiError('invalid claim: token is expired', 401, 'bad_jwt'),
    });

    const res = await request(montarApp()).get('/protegido').set('Authorization', `Bearer ${TOKEN_FORMATO_VALIDO}`);

    expect(res.status).toBe(401);
  });

  it('responde 401 quando a validação retorna sem claim "sub"', async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: {} }, error: null });

    const res = await request(montarApp()).get('/protegido').set('Authorization', `Bearer ${TOKEN_FORMATO_VALIDO}`);

    expect(res.status).toBe(401);
  });

  it('segue para a rota e popula req.auth quando o token é válido', async () => {
    getClaimsMock.mockResolvedValue({ data: { claims: { sub: 'user-1' } }, error: null });

    const res = await request(montarApp()).get('/protegido').set('Authorization', `Bearer ${TOKEN_FORMATO_VALIDO}`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('user-1');
  });

  it('responde 401 sem chamar getClaims quando não há header de autorização', async () => {
    const res = await request(montarApp()).get('/protegido');

    expect(res.status).toBe(401);
    expect(getClaimsMock).not.toHaveBeenCalled();
  });

  it('responde 401 sem chamar getClaims quando o token está mal formado', async () => {
    const res = await request(montarApp()).get('/protegido').set('Authorization', 'Bearer nao-e-jwt');

    expect(res.status).toBe(401);
    expect(getClaimsMock).not.toHaveBeenCalled();
  });
});
