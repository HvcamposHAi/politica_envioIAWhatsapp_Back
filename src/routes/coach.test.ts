// Teste pontual: POST /conversas/:id/coach/gerar
// (PLANO_COACH_RESPOSTA_E_CONDUTA.md, §8.2). Cobre as guardas da rota —
// auth, escopo, conversa já finalizada — e o caso que mais importa: falha da
// Anthropic virando 502 em vez de 200 com lista vazia.
//
// Mesmo harness de routes/avaliacao.test.ts: fila por tabela, porque a rota faz
// duas leituras de `conversas` na mesma requisição (antes e depois da análise).
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/middleware.js', () => ({
  requireSupabaseAuth:
    () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = { userId: req.headers['x-teste-user-id'] as string, claims: {} };
      next();
    },
}));

let filas: Record<string, { data: unknown; error: { message: string } | null }[]>;

function enfileirar(tabela: string, resultado: { data: unknown; error: { message: string } | null }) {
  (filas[tabela] ??= []).push(resultado);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encadear(resultado: unknown): any {
  const builder = {
    eq: () => builder,
    single: () => Promise.resolve(resultado),
    maybeSingle: () => Promise.resolve(resultado),
    then: (resolve: (v: unknown) => void) => resolve(resultado),
  };
  return builder;
}

const fromMock = vi.fn((tabela: string) => ({
  select: () => encadear(filas[tabela]?.shift() ?? { data: null, error: null }),
}));

vi.mock('../db/client.server.js', () => ({ supabaseAdmin: { from: fromMock } }));

const analisarConversaMock = vi.fn();
vi.mock('../services/analiseIA.js', () => ({
  analisarConversa: (id: string) => analisarConversaMock(id),
}));

const { coachRouter } = await import('./coach.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(coachRouter);
  return app;
}

const CONVERSA_ID = 'conv-1';
const USER_ID = 'user-1';

function comAtendente(over: Record<string, unknown> = {}) {
  enfileirar('atendentes', { data: { id: 'atend-1', perfil: 'admin', ...over }, error: null });
}

/** Primeira leitura de `conversas`: escopo + estado. */
function comConversa(over: Record<string, unknown> = {}) {
  enfileirar('conversas', {
    data: {
      id: CONVERSA_ID,
      fechada_em: null,
      setores: { empresa_id: 'empresa-1' },
      canais: { empresa_id: 'empresa-1' },
      ...over,
    },
    error: null,
  });
}

/** Segunda leitura de `conversas`: o resultado já gravado pela análise. */
function comCoachGravado(over: Record<string, unknown> = {}) {
  enfileirar('conversas', {
    data: {
      risco: 'alto',
      risco_motivo: 'cliente exigiu falar com o dono',
      coach_sugestoes: ['a', 'b', 'c'],
      coach_orientacoes: ['x', 'chame Marcelo'],
      coach_atualizado_em: '2026-08-08T18:00:00Z',
      analise_ia_erro: null,
      ...over,
    },
    error: null,
  });
}

beforeEach(() => {
  filas = {};
  fromMock.mockClear();
  analisarConversaMock.mockReset();
  analisarConversaMock.mockResolvedValue(undefined);
});

describe('POST /conversas/:id/coach/gerar', () => {
  it('gera e devolve o coach no caminho feliz', async () => {
    comAtendente();
    comConversa();
    comCoachGravado();

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/coach/gerar`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(200);
    expect(analisarConversaMock).toHaveBeenCalledWith(CONVERSA_ID);
    expect(r.body.coach_sugestoes).toHaveLength(3);
    expect(r.body.coach_atualizado_em).toBeTruthy();
    expect(r.body.risco).toBe('alto');
    // A coluna de erro é detalhe interno; não vaza no corpo do sucesso.
    expect(r.body.analise_ia_erro).toBeUndefined();
  });

  it('403 quando o usuário não é atendente ativo', async () => {
    enfileirar('atendentes', { data: null, error: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/coach/gerar`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(403);
    expect(analisarConversaMock).not.toHaveBeenCalled();
  });

  it('403 quando a conversa é de outra empresa', async () => {
    comAtendente({ perfil: 'operador' });
    comConversa({ setores: { empresa_id: 'outra' }, canais: { empresa_id: 'outra' } });
    enfileirar('atendente_empresas', { data: [{ empresa_id: 'empresa-1' }], error: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/coach/gerar`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(403);
    expect(analisarConversaMock).not.toHaveBeenCalled();
  });

  it('404 quando a conversa não existe', async () => {
    comAtendente();
    enfileirar('conversas', { data: null, error: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/coach/gerar`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(404);
  });

  it('409 e NÃO gasta chamada de IA em conversa já finalizada', async () => {
    comAtendente();
    comConversa({ fechada_em: '2026-08-08T12:00:00Z' });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/coach/gerar`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(409);
    expect(analisarConversaMock).not.toHaveBeenCalled();
  });

  it('502 quando a análise falhou, em vez de 200 com lista vazia', async () => {
    // analisarConversa nunca relança (contrato de fire-and-forget): a falha vai
    // para analise_ia_erro. Sem esta checagem a tela diria "não há sugestões"
    // quando o certo é "não deu para gerar" — alerta falhando em verde.
    comAtendente();
    comConversa();
    comCoachGravado({
      coach_sugestoes: null,
      coach_orientacoes: null,
      coach_atualizado_em: null,
      analise_ia_erro: 'Chave da Anthropic não configurada ou inválida.',
    });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/coach/gerar`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(502);
    expect(r.body.error).toContain('Anthropic');
  });
});
