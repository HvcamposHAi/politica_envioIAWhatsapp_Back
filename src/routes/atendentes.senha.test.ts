// Teste pontual das rotas administrativas de senha (plano "Senha no
// cadastro, reset e troca no primeiro acesso" §10.1):
//   POST /atendentes/:id/acesso        — cria login com senha provisória
//   POST /atendentes/:id/reset-senha   — redefine senha de quem já tem acesso
//
// O que estes testes protegem, em ordem de importância:
//   1. só admin chega ao Supabase Auth (privilégio);
//   2. as duas rotas SEMPRE marcam must_change_password (a senha provisória
//      nunca vira senha definitiva por esquecimento);
//   3. createUser sem vínculo em hub.atendentes é desfeito (sem órfão no
//      Auth, que é a falha E2 do plano);
//   4. nenhuma senha chega a log ou à auditoria.
//
// Mocka auth/db — não toca rede, Supabase real nem GCP.
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_USER_ID = 'user-admin-1';
const OPERADOR_USER_ID = 'user-operador-1';
const ID_ALVO = '11111111-1111-1111-1111-111111111111';

interface AtendenteFake {
  id: string;
  email: string | null;
  user_id: string | null;
  empresa_id: string | null;
}

// Estado montado por cada teste no beforeEach/no próprio caso.
let chamador: { id: string; perfil: string } | null;
let alvo: AtendenteFake | null;
let vinculoRetorna: { data: { id: string } | null; error: { message: string } | null };
const insercoesAuditoria: Array<Record<string, unknown>> = [];

vi.mock('../auth/middleware.js', () => ({
  requireSupabaseAuth: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.auth = {
      userId: req.headers['x-teste-user-id'] as string,
      claims: { email: req.headers['x-teste-email'] as string },
    };
    next();
  },
}));

const createUserMock = vi.fn();
const updateUserByIdMock = vi.fn();
const deleteUserMock = vi.fn();

// Construtor de query encadeável mínimo: registra a intenção e resolve no
// terminal (`maybeSingle`). Distingue as três consultas que as rotas fazem
// pela combinação tabela + operação + filtros.
function criarBuilder(tabela: string) {
  const estado = {
    tabela,
    operacao: 'select' as 'select' | 'update',
    filtros: {} as Record<string, unknown>,
    usouOr: false,
  };
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: () => {
      estado.operacao = 'update';
      return builder;
    },
    eq: (coluna: string, valor: unknown) => {
      estado.filtros[coluna] = valor;
      return builder;
    },
    is: (coluna: string, valor: unknown) => {
      estado.filtros[`is:${coluna}`] = valor;
      return builder;
    },
    or: () => {
      estado.usouOr = true;
      return builder;
    },
    limit: () => builder,
    maybeSingle: () => {
      if (estado.operacao === 'update') return Promise.resolve(vinculoRetorna);
      if (estado.usouOr) return Promise.resolve({ data: chamador, error: null });
      return Promise.resolve({ data: alvo, error: null });
    },
    insert: (linha: Record<string, unknown>) => {
      insercoesAuditoria.push(linha);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return builder;
}

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: {
    from: (tabela: string) => criarBuilder(tabela),
    auth: {
      admin: {
        createUser: (...args: unknown[]) => createUserMock(...args),
        updateUserById: (...args: unknown[]) => updateUserByIdMock(...args),
        deleteUser: (...args: unknown[]) => deleteUserMock(...args),
      },
    },
  },
}));

const { atendentesRouter } = await import('./atendentes.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(atendentesRouter);
  return app;
}

function comoAdmin(req: request.Test) {
  return req.set('X-Teste-User-Id', ADMIN_USER_ID).set('X-Teste-Email', 'admin@exemplo.com');
}

const SENHA_OK = 'Provisoria2026!';

describe('POST /atendentes/:id/acesso', () => {
  beforeEach(() => {
    chamador = { id: 'atendente-admin', perfil: 'admin' };
    alvo = { id: ID_ALVO, email: 'novo@exemplo.com', user_id: null, empresa_id: 'empresa-1' };
    vinculoRetorna = { data: { id: ID_ALVO }, error: null };
    insercoesAuditoria.length = 0;
    createUserMock.mockReset().mockResolvedValue({ data: { user: { id: 'auth-user-novo' } }, error: null });
    updateUserByIdMock.mockReset().mockResolvedValue({ data: {}, error: null });
    deleteUserMock.mockReset().mockResolvedValue({ error: null });
  });

  it('não-admin -> 403 e nem chega no Auth', async () => {
    chamador = { id: 'atendente-operador', perfil: 'operador' };
    const res = await request(montarApp())
      .post(`/atendentes/${ID_ALVO}/acesso`)
      .set('X-Teste-User-Id', OPERADOR_USER_ID)
      .set('X-Teste-Email', 'operador@exemplo.com')
      .send({ senha: SENHA_OK });

    expect(res.status).toBe(403);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('integrante inexistente -> 404', async () => {
    alvo = null;
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });
    expect(res.status).toBe(404);
  });

  it('integrante sem e-mail -> 400', async () => {
    alvo = { id: ID_ALVO, email: null, user_id: null, empresa_id: null };
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });
    expect(res.status).toBe(400);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('integrante que já tem acesso -> 409 apontando o reset', async () => {
    alvo = { id: ID_ALVO, email: 'novo@exemplo.com', user_id: 'auth-existente', empresa_id: null };
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Resetar senha/i);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('senha curta -> 400 sem chamar o Auth', async () => {
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: '1234567' });
    expect(res.status).toBe(400);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('senha ausente -> 400', async () => {
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({});
    expect(res.status).toBe(400);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('senha recusada por vazamento (HIBP) -> 400 com mensagem amigável', async () => {
    createUserMock.mockResolvedValue({
      data: null,
      error: { code: 'weak_password', message: 'Password is known to be weak and easy to guess' },
    });
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vazamentos|fraca/i);
  });

  it('e-mail já existente no Auth -> 409, não 500', async () => {
    createUserMock.mockResolvedValue({
      data: null,
      error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
    });
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });
    expect(res.status).toBe(409);
  });

  it('vínculo falha -> rollback deleteUser e 500 (sem órfão no Auth)', async () => {
    vinculoRetorna = { data: null, error: { message: 'boom' } };
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });

    expect(res.status).toBe(500);
    expect(deleteUserMock).toHaveBeenCalledWith('auth-user-novo');
    expect(insercoesAuditoria).toHaveLength(0);
  });

  it('caminho feliz -> 201, usuário confirmado e marcado para trocar a senha', async () => {
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ user_id: 'auth-user-novo' });
    expect(createUserMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'novo@exemplo.com',
        password: SENHA_OK,
        email_confirm: true,
        app_metadata: { must_change_password: true },
      }),
    );
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it('a auditoria registra a ação sem nenhum vestígio da senha', async () => {
    await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/acesso`)).send({ senha: SENHA_OK });

    expect(insercoesAuditoria).toHaveLength(1);
    expect(insercoesAuditoria[0]).toMatchObject({ acao: 'acesso.criado_com_senha', entidade: 'atendente' });
    expect(JSON.stringify(insercoesAuditoria[0])).not.toContain(SENHA_OK);
  });
});

describe('POST /atendentes/:id/reset-senha', () => {
  beforeEach(() => {
    chamador = { id: 'atendente-admin', perfil: 'admin' };
    alvo = { id: ID_ALVO, email: 'alguem@exemplo.com', user_id: 'auth-user-existente', empresa_id: 'empresa-1' };
    insercoesAuditoria.length = 0;
    createUserMock.mockReset();
    updateUserByIdMock.mockReset().mockResolvedValue({ data: {}, error: null });
    deleteUserMock.mockReset();
  });

  it('não-admin -> 403', async () => {
    chamador = { id: 'atendente-operador', perfil: 'operador' };
    const res = await request(montarApp())
      .post(`/atendentes/${ID_ALVO}/reset-senha`)
      .set('X-Teste-User-Id', OPERADOR_USER_ID)
      .set('X-Teste-Email', 'operador@exemplo.com')
      .send({ senha: SENHA_OK });

    expect(res.status).toBe(403);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('integrante ainda sem acesso -> 409 apontando a criação de acesso', async () => {
    alvo = { id: ID_ALVO, email: 'alguem@exemplo.com', user_id: null, empresa_id: null };
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/reset-senha`)).send({
      senha: SENHA_OK,
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Criar acesso/i);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('senha curta -> 400 sem chamar o Auth', async () => {
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/reset-senha`)).send({ senha: 'abc' });
    expect(res.status).toBe(400);
    expect(updateUserByIdMock).not.toHaveBeenCalled();
  });

  it('senha fraca recusada pelo Supabase -> 400 amigável', async () => {
    updateUserByIdMock.mockResolvedValue({
      data: null,
      error: { code: 'weak_password', message: 'Password is known to be weak' },
    });
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/reset-senha`)).send({
      senha: SENHA_OK,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vazamentos|fraca/i);
  });

  it('caminho feliz -> 200 e a flag de troca obrigatória volta a valer', async () => {
    const res = await comoAdmin(request(montarApp()).post(`/atendentes/${ID_ALVO}/reset-senha`)).send({
      senha: SENHA_OK,
    });

    expect(res.status).toBe(200);
    expect(updateUserByIdMock).toHaveBeenCalledWith('auth-user-existente', {
      password: SENHA_OK,
      app_metadata: { must_change_password: true },
    });
    expect(insercoesAuditoria[0]).toMatchObject({ acao: 'acesso.senha_redefinida' });
    expect(JSON.stringify(insercoesAuditoria[0])).not.toContain(SENHA_OK);
  });
});
