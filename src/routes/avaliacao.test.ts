// Teste pontual: POST /conversas/:id/avaliacao (PLANO_IA_SENTIMENTO_ALERTAS_
// ALICE_CSAT.md, fase 2, §9.2). Cobre as guardas da rota — auth/escopo,
// conversa ainda aberta, idempotência e falha de envio. A captura da nota que
// o cliente responde é testada à parte em services/avaliacao.test.ts.
//
// Mesmo harness de routes/resumo.test.ts: fila por tabela, porque a rota faz
// leituras diferentes de `conversas` e `clientes` na mesma requisição.
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
let updates: { tabela: string; campos: Record<string, unknown> }[] = [];
let inserts: { tabela: string; campos: Record<string, unknown> }[] = [];
/** Linhas devolvidas pelo `.select()` da RESERVA. Lista vazia = outra
 *  requisição reservou primeiro (corrida). */
let linhasReservadas: { id: string }[] = [{ id: 'conv-1' }];

function enfileirar(tabela: string, resultado: { data: unknown; error: { message: string } | null }) {
  (filas[tabela] ??= []).push(resultado);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encadear(resultado: unknown): any {
  const builder = {
    eq: () => builder,
    is: () => builder,
    single: () => Promise.resolve(resultado),
    maybeSingle: () => Promise.resolve(resultado),
    then: (resolve: (v: unknown) => void) => resolve(resultado),
  };
  return builder;
}

const fromMock = vi.fn((tabela: string) => ({
  select: () => encadear(filas[tabela]?.shift() ?? { data: null, error: null }),
  update: (campos: Record<string, unknown>) => {
    updates.push({ tabela, campos });
    return {
      eq: function () {
        return this;
      },
      is: function () {
        return this;
      },
      select: () => Promise.resolve({ data: linhasReservadas, error: null }),
      // O update de rollback não encadeia `.select()`; precisa ser awaitável.
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    };
  },
  insert: (campos: Record<string, unknown>) => {
    inserts.push({ tabela, campos });
    return encadear({ data: null, error: null });
  },
}));

vi.mock('../db/client.server.js', () => ({ supabaseAdmin: { from: fromMock } }));

const enviarMock = vi.fn();
vi.mock('../channels/registry.js', () => ({
  obterOuCriarCanal: () => Promise.resolve({ enviar: enviarMock }),
}));

const { avaliacaoRouter } = await import('./avaliacao.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(avaliacaoRouter);
  return app;
}

const CONVERSA_ID = 'conv-1';
const USER_ID = 'user-1';

/** Atendente ativo, do mesmo escopo da conversa. */
function comAtendente() {
  enfileirar('atendentes', {
    data: { id: 'atend-1', perfil: 'admin', empresa_id: 'empresa-1', ativo: true },
    error: null,
  });
}

function comConversa(over: Record<string, unknown> = {}) {
  enfileirar('conversas', {
    data: {
      id: CONVERSA_ID,
      canal_id: 'canal-1',
      cliente_id: 'cliente-1',
      fechada_em: '2026-08-08T12:00:00Z',
      avaliacao_solicitada_em: null,
      setores: { empresa_id: 'empresa-1' },
      canais: { empresa_id: 'empresa-1' },
      ...over,
    },
    error: null,
  });
}

function comCliente(over: Record<string, unknown> = {}) {
  enfileirar('clientes', {
    data: { telefone: '554199999999', wa_jid: null, tipo_chat: 'contato', ...over },
    error: null,
  });
}

beforeEach(() => {
  filas = {};
  updates = [];
  inserts = [];
  linhasReservadas = [{ id: CONVERSA_ID }];
  fromMock.mockClear();
  enviarMock.mockReset();
  enviarMock.mockResolvedValue({ status: 'enviada', waMessageId: 'wa-1' });
});

describe('POST /conversas/:id/avaliacao', () => {
  it('envia a pesquisa e marca a conversa quando tudo está certo', async () => {
    comAtendente();
    comConversa();
    comCliente();

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(202);
    expect(enviarMock).toHaveBeenCalledTimes(1);
    expect(updates[0].campos.avaliacao_solicitada_em).toBeTruthy();
    // A pergunta entra no histórico do chamado.
    expect(inserts[0]).toMatchObject({ tabela: 'mensagens', campos: { direcao: 'saida' } });
  });

  it('403 quando o usuário não é atendente ativo', async () => {
    enfileirar('atendentes', { data: null, error: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(403);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('404 quando a conversa não existe', async () => {
    comAtendente();
    enfileirar('conversas', { data: null, error: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(404);
  });

  it('409 quando a conversa ainda não foi finalizada', async () => {
    // Pesquisa no meio do atendimento confundiria o cliente e envenenaria a
    // captura: com conversa aberta, um "5" é assunto em curso, não nota.
    comAtendente();
    comConversa({ fechada_em: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(409);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('409 quando a pesquisa já foi solicitada (idempotência)', async () => {
    comAtendente();
    comConversa({ avaliacao_solicitada_em: '2026-08-08T12:05:00Z' });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(409);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('502 e DEVOLVE a reserva quando o canal falha no envio', async () => {
    // Deixar a reserva marcada criaria um limbo: pesquisa que o cliente nunca
    // recebeu, que a idempotência impediria de reenviar, e que ainda entraria
    // no denominador da taxa de resposta do Painel.
    comAtendente();
    comConversa();
    comCliente();
    enviarMock.mockResolvedValue({ status: 'falhou', erro: 'canal desconectado' });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(502);
    // Reserva + rollback: o último update devolve o campo a null.
    expect(updates.at(-1)?.campos.avaliacao_solicitada_em).toBeNull();
  });

  // GRUPO NÃO RECEBE PESQUISA. Sem estas guardas, finalizar um chamado de
  // grupo publicava "de 1 a 5, como você avalia..." dentro do grupo do
  // cliente — e a nota nem seria captada, porque a captura ignora grupo.
  // Uma fonte por teste: cada uma pode faltar sozinha em produção.
  it('200 "nao_aplicavel" e NÃO envia quando a conversa é de grupo (origem_chat)', async () => {
    comAtendente();
    comConversa({ origem_chat: 'grupo' });
    comCliente({ tipo_chat: 'grupo', wa_jid: '120363000000000000@g.us' });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'nao_aplicavel', motivo: 'grupo' });
    expect(enviarMock).not.toHaveBeenCalled();
    // Barrado ANTES da reserva: nada de marcar avaliacao_solicitada_em numa
    // conversa que nunca vai receber pesquisa — isso a tiraria do numerador
    // e a deixaria no denominador da taxa de resposta do Painel.
    expect(updates).toHaveLength(0);
  });

  it('barra o grupo mesmo com origem_chat dessincronizado, pelo tipo_chat do cliente', async () => {
    // origem_chat é coluna desnormalizada por trigger: linha antiga pode ter
    // ficado sem. hub.clientes.tipo_chat é a fonte da verdade.
    comAtendente();
    comConversa({ origem_chat: null });
    comCliente({ tipo_chat: 'grupo', wa_jid: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(200);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('barra o grupo pelo sufixo @g.us, última linha de defesa', async () => {
    // Se as duas colunas falharem, o endereço de destino ainda denuncia:
    // é para onde a mensagem iria.
    comAtendente();
    comConversa({ origem_chat: null });
    comCliente({ tipo_chat: null, wa_jid: '120363000000000000@g.us' });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(200);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('NÃO confunde conversa 1:1 sem wa_jid com grupo', async () => {
    // Contra-prova das guardas acima: cliente antigo, sem wa_jid salvo e sem
    // tipo_chat preenchido, continua recebendo a pesquisa normalmente.
    comAtendente();
    comConversa({ origem_chat: null });
    comCliente({ tipo_chat: null, wa_jid: null });

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(202);
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });

  it('409 e NÃO envia quando outra requisição reserva primeiro (corrida)', async () => {
    // Regressão da auditoria: antes o envio acontecia ANTES do update, então
    // dois cliques simultâneos passavam os dois pela leitura e o cliente
    // recebia DUAS pesquisas — e ambas as respostas eram 202.
    comAtendente();
    comConversa();
    comCliente();
    linhasReservadas = []; // outra requisição já tinha reservado

    const r = await request(montarApp())
      .post(`/conversas/${CONVERSA_ID}/avaliacao`)
      .set('x-teste-user-id', USER_ID);

    expect(r.status).toBe(409);
    expect(enviarMock).not.toHaveBeenCalled();
  });
});
