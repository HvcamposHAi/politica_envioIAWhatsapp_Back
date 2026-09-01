// Teste pontual: POST /conversas/:id/resumo/gerar (plano "Resumo de IA no
// Kanban de Chamados") — cobre só a guarda de auth/escopo desta rota
// (mesmo padrão de escopo já usado por /conversas/:id/mensagens). A
// geração em si (gerarResumoConversa) é mockada aqui e testada à parte em
// services/resumoIA.test.ts.
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/middleware.js', () => ({
  requireSupabaseAuth: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.auth = { userId: req.headers['x-teste-user-id'] as string, claims: {} };
    next();
  },
}));

// Fila por tabela: cada chamada a supabaseAdmin.from(tabela).select(...)
// consome o próximo resultado enfileirado para aquela tabela — precisa
// disto (em vez de um resultado fixo por tabela) porque esta rota faz DUAS
// leituras diferentes de `conversas` na mesma requisição (escopo, depois o
// resumo já atualizado).
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
  select: () => {
    const fila = filas[tabela];
    const resultado = fila?.shift() ?? { data: null, error: null };
    return encadear(resultado);
  },
}));

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: { from: fromMock },
}));

const gerarResumoConversaMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/resumoIA.js', () => ({
  gerarResumoConversa: gerarResumoConversaMock,
}));

const { resumoRouter } = await import('./resumo.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(resumoRouter);
  return app;
}

const CONVERSA_ID = 'conv-1';

beforeEach(() => {
  filas = {};
  fromMock.mockClear();
  gerarResumoConversaMock.mockClear();
});

describe('POST /conversas/:id/resumo/gerar', () => {
  it('admin em qualquer empresa: gera e devolve o resumo atualizado', async () => {
    enfileirar('atendentes', { data: { id: 'atd-admin', perfil: 'admin' }, error: null });
    enfileirar('conversas', {
      data: { id: CONVERSA_ID, setores: { empresa_id: 'empresa-A' }, canais: { empresa_id: 'empresa-A' } },
      error: null,
    });
    const resumoFinal = {
      resumo_ia: 'Cliente perguntou sobre entrega; atendente confirmou prazo.',
      resumo_ia_status: 'pronto',
      resumo_ia_gerado_em: '2026-08-07T10:00:00Z',
      resumo_ia_mensagens_count: 4,
      resumo_ia_erro: null,
      titulo_ia: 'Prazo de entrega do pedido',
      titulo_ia_gerado_em: '2026-08-07T10:00:00Z',
    };
    enfileirar('conversas', { data: resumoFinal, error: null });

    const res = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/resumo/gerar`)
      .set('x-teste-user-id', 'user-admin');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(resumoFinal);
    // Contrato com o front (lib/api.ts, interface ResumoIA): o título volta
    // junto para o dialog atualizar sem recarregar o board.
    expect(res.body.titulo_ia).toBe('Prazo de entrega do pedido');
    expect(gerarResumoConversaMock).toHaveBeenCalledWith(CONVERSA_ID);
  });

  it('operador de empresa diferente da conversa: 403, gerarResumoConversa não é chamado', async () => {
    enfileirar('atendentes', { data: { id: 'atd-operador', perfil: 'operador' }, error: null });
    enfileirar('conversas', {
      data: { id: CONVERSA_ID, setores: { empresa_id: 'empresa-B' }, canais: null },
      error: null,
    });
    enfileirar('atendente_empresas', { data: [{ empresa_id: 'empresa-A' }], error: null });

    const res = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/resumo/gerar`)
      .set('x-teste-user-id', 'user-operador');

    expect(res.status).toBe(403);
    expect(gerarResumoConversaMock).not.toHaveBeenCalled();
  });

  it('usuário autenticado sem atendente ativo correspondente: 403', async () => {
    enfileirar('atendentes', { data: null, error: null });

    const res = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/resumo/gerar`)
      .set('x-teste-user-id', 'user-desconhecido');

    expect(res.status).toBe(403);
    expect(gerarResumoConversaMock).not.toHaveBeenCalled();
  });
});
