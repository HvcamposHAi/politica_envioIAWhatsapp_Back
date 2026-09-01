// Teste pontual: POST /conversas/:id/mensagens — marcação de primeira resposta
// (auditoria 2026-08-09, item 4).
//
// O que este arquivo protege: a coluna `primeira_resposta_em` passou a ter um
// único produtor, aqui no backend. A regra que veio junto é a que a Caixa já
// documentava e que a Fila violava — só marca quando a mensagem SAIU de
// verdade. Marcar com o canal recusando o envio grava "respondido no prazo"
// para um cliente que não recebeu nada, e o Painel inteiro (KPI de 1ª resposta
// e SLA) lê só desta coluna.
//
// Mesmo harness de routes/coach.test.ts.
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
    is: () => builder,
    select: () => builder,
    single: () => Promise.resolve(resultado),
    maybeSingle: () => Promise.resolve(resultado),
    then: (resolve: (v: unknown) => void) => resolve(resultado),
  };
  return builder;
}

const fromMock = vi.fn((tabela: string) => ({
  select: () => encadear(filas[tabela]?.shift() ?? { data: null, error: null }),
  insert: () => encadear(filas[tabela]?.shift() ?? { data: null, error: null }),
  update: () => encadear({ data: null, error: null }),
}));

vi.mock('../db/client.server.js', () => ({ supabaseAdmin: { from: fromMock } }));

const enviarMock = vi.fn();
vi.mock('../channels/registry.js', () => ({
  obterOuCriarCanal: async () => ({ enviar: enviarMock }),
}));

const marcarPrimeiraRespostaMock = vi.fn(async (_conversaId: string) => undefined);
vi.mock('../services/mensagens.js', () => ({
  marcarPrimeiraResposta: (id: string) => marcarPrimeiraRespostaMock(id),
}));

const { mensagensRouter } = await import('./mensagens.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(mensagensRouter);
  return app;
}

const CONVERSA_ID = 'conv-1';
const USER_ID = 'user-1';

function cenarioCompleto() {
  enfileirar('atendentes', { data: { id: 'atend-1', perfil: 'admin' }, error: null });
  enfileirar('conversas', {
    data: {
      id: CONVERSA_ID,
      canal_id: 'canal-1',
      cliente_id: 'cliente-1',
      setores: { empresa_id: 'empresa-1' },
      canais: { empresa_id: 'empresa-1' },
    },
    error: null,
  });
  enfileirar('clientes', { data: { telefone: '5541999998888', wa_jid: null }, error: null });
  enfileirar('mensagens', { data: { id: 'msg-1' }, error: null });
}

async function enviar() {
  return request(montarApp())
    .post(`/conversas/${CONVERSA_ID}/mensagens`)
    .set('x-teste-user-id', USER_ID)
    .send({ texto: 'vou verificar' });
}

beforeEach(() => {
  filas = {};
  enviarMock.mockReset();
  marcarPrimeiraRespostaMock.mockClear();
});

describe('POST /conversas/:id/mensagens — primeira_resposta_em', () => {
  it('marca a primeira resposta quando o canal aceitou o envio', async () => {
    cenarioCompleto();
    enviarMock.mockResolvedValue({ status: 'enviada', waMessageId: 'wa-1' });

    const res = await enviar();

    expect(res.status).toBe(202);
    expect(marcarPrimeiraRespostaMock).toHaveBeenCalledWith(CONVERSA_ID);
  });

  it('NÃO marca quando o canal recusou — nada saiu para o cliente', async () => {
    cenarioCompleto();
    enviarMock.mockResolvedValue({ status: 'falhou', waMessageId: '', erro: 'canal não conectado' });

    const res = await enviar();

    // A linha em hub.mensagens existe (o atendente escreveu), mas o relógio de
    // SLA não pode parar: o cliente não recebeu nada.
    expect(res.status).toBe(202);
    expect(res.body.envio).toBe('falhou');
    expect(marcarPrimeiraRespostaMock).not.toHaveBeenCalled();
  });

  it('contrato de resposta preservado: 202 com mensagemId, waMessageId e envio', async () => {
    cenarioCompleto();
    enviarMock.mockResolvedValue({ status: 'enviada', waMessageId: 'wa-1' });

    const res = await enviar();

    expect(res.body).toEqual({
      status: 'accepted',
      mensagemId: 'msg-1',
      waMessageId: 'wa-1',
      envio: 'enviada',
    });
  });

  it('não marca quando a conversa está fora do escopo do atendente', async () => {
    enfileirar('atendentes', { data: { id: 'atend-1', perfil: 'operador' }, error: null });
    enfileirar('conversas', {
      data: {
        id: CONVERSA_ID,
        canal_id: 'canal-1',
        cliente_id: 'cliente-1',
        setores: { empresa_id: 'empresa-Z' },
        canais: { empresa_id: 'empresa-Z' },
      },
      error: null,
    });
    enfileirar('atendente_empresas', { data: [{ empresa_id: 'empresa-1' }], error: null });

    const res = await enviar();

    expect(res.status).toBe(403);
    expect(enviarMock).not.toHaveBeenCalled();
    expect(marcarPrimeiraRespostaMock).not.toHaveBeenCalled();
  });
});
