// Teste pontual de POST /conta/senha (plano "Senha no cadastro, reset e
// troca no primeiro acesso" §10.1).
//
// O caso mais importante deste arquivo é o "não limpa a flag sem trocar de
// verdade": a troca obrigatória do primeiro acesso só tem valor se não
// existir atalho para apagar `must_change_password` sem apresentar a senha
// vigente e escolher uma nova diferente. Os dois primeiros testes são
// exatamente essas duas tentativas de atalho.
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = 'user-1';
const EMAIL = 'pessoa@exemplo.com';
const SENHA_ATUAL = 'Provisoria2026!';
const SENHA_NOVA = 'MinhaNovaSenha2026!';

const signInMock = vi.fn();
const signOutMock = vi.fn();
const updateUserByIdMock = vi.fn();
const insercoesAuditoria: Array<Record<string, unknown>> = [];

vi.mock('../auth/middleware.js', () => ({
  requireSupabaseAuth: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.auth = {
      userId: USER_ID,
      claims: req.headers['x-teste-sem-email'] ? {} : { email: EMAIL },
    };
    next();
  },
  createSupabaseFetch: () => fetch,
}));

vi.mock('@supabase/supabase-js', async () => {
  const real = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
  return {
    ...real,
    createClient: () => ({
      auth: { signInWithPassword: signInMock, signOut: signOutMock },
    }),
  };
});

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { id: 'atendente-1', empresa_id: 'empresa-1' }, error: null }),
        }),
      }),
      insert: (linha: Record<string, unknown>) => {
        insercoesAuditoria.push(linha);
        return Promise.resolve({ data: null, error: null });
      },
    }),
    auth: { admin: { updateUserById: (...args: unknown[]) => updateUserByIdMock(...args) } },
  },
}));

process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_teste';

const { contaRouter } = await import('./conta.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(contaRouter);
  return app;
}

describe('POST /conta/senha', () => {
  beforeEach(() => {
    insercoesAuditoria.length = 0;
    signInMock.mockReset().mockResolvedValue({ data: { session: { access_token: 'tok' } }, error: null });
    signOutMock.mockReset().mockResolvedValue({ error: null });
    updateUserByIdMock.mockReset().mockResolvedValue({ data: {}, error: null });
  });

  it('senha atual incorreta -> 400 e a senha NÃO é trocada', async () => {
    signInMock.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } });

    const res = await request(montarApp())
      .post('/conta/senha')
      .send({ senha_atual: 'errada-mas-longa', senha_nova: SENHA_NOVA });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/senha atual/i);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('nova senha igual à atual -> 400 (fechando o atalho de limpar a flag sem trocar)', async () => {
    const res = await request(montarApp())
      .post('/conta/senha')
      .send({ senha_atual: SENHA_ATUAL, senha_nova: SENHA_ATUAL });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/diferente/i);
    expect(signInMock).not.toHaveBeenCalled();
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('senha nova curta -> 400 sem tocar no Auth', async () => {
    const res = await request(montarApp()).post('/conta/senha').send({ senha_atual: SENHA_ATUAL, senha_nova: 'curta' });

    expect(res.status).toBe(400);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('senha atual ausente -> 400', async () => {
    const res = await request(montarApp()).post('/conta/senha').send({ senha_nova: SENHA_NOVA });

    expect(res.status).toBe(400);
    expect(signInMock).not.toHaveBeenCalled();
  });

  it('token sem claim de e-mail -> 400 (não dá para validar a senha atual)', async () => {
    const res = await request(montarApp())
      .post('/conta/senha')
      .set('X-Teste-Sem-Email', '1')
      .send({ senha_atual: SENHA_ATUAL, senha_nova: SENHA_NOVA });

    expect(res.status).toBe(400);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('caminho feliz -> 200, troca no PRÓPRIO usuário e limpa a flag na mesma operação', async () => {
    const res = await request(montarApp())
      .post('/conta/senha')
      .send({ senha_atual: SENHA_ATUAL, senha_nova: SENHA_NOVA });

    expect(res.status).toBe(200);
    expect(signInMock).toHaveBeenCalledWith({ email: EMAIL, password: SENHA_ATUAL });
    expect(updateUserByIdMock).toHaveBeenCalledWith(USER_ID, {
      password: SENHA_NOVA,
      app_metadata: { must_change_password: false },
    });
  });

  it('senha nova recusada por vazamento (HIBP) -> 400 amigável', async () => {
    updateUserByIdMock.mockResolvedValue({
      data: null,
      error: { code: 'weak_password', message: 'Password is known to be weak' },
    });

    const res = await request(montarApp())
      .post('/conta/senha')
      .send({ senha_atual: SENHA_ATUAL, senha_nova: SENHA_NOVA });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vazamentos|fraca/i);
  });

  it('a auditoria registra a troca sem nenhum vestígio das senhas', async () => {
    await request(montarApp()).post('/conta/senha').send({ senha_atual: SENHA_ATUAL, senha_nova: SENHA_NOVA });

    expect(insercoesAuditoria).toHaveLength(1);
    expect(insercoesAuditoria[0]).toMatchObject({ acao: 'acesso.senha_trocada_pelo_usuario' });
    const serializado = JSON.stringify(insercoesAuditoria[0]);
    expect(serializado).not.toContain(SENHA_ATUAL);
    expect(serializado).not.toContain(SENHA_NOVA);
  });
});
