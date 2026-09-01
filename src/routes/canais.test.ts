// Teste pontual: escopo das rotas de canal (auditoria 2026-08-09, item 1).
//
// O que este arquivo protege: até a correção, as três rotas exigiam apenas
// autenticação. Como o registry usa supabaseAdmin (service_role, ignora RLS),
// qualquer atendente de qualquer empresa podia comandar a linha de outra — e
// DELETE /sessao cai em desconectar() sem preservarSessao, que faz logout()
// protocolar e DESPAREIA o aparelho. O caso "operador da empresa B derruba a
// linha da empresa A" é o teste que não pode voltar a passar por engano.
//
// Mesmo harness de routes/coach.test.ts: mock do middleware de auth + fila de
// resultados por tabela em db/client.server.js.
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

const conectarMock = vi.fn();
const desconectarMock = vi.fn();
const removerCanalMock = vi.fn();
const statusMock = vi.fn(async () => 'conectado');
let canalVivo: unknown;

vi.mock('../channels/registry.js', () => ({
  obterOuCriarCanal: async () => ({ conectar: conectarMock, desconectar: desconectarMock }),
  canalEmMemoria: () => canalVivo,
  // Este mock existia desde 2026-08-10 com um comentário afirmando que a rota
  // já tirava o canal do Map — mas a chamada NUNCA tinha sido escrita na rota
  // (confirmado em 2026-08-14 por `git show HEAD:src/routes/canais.ts`). Era
  // a segunda metade da causa 2 das quedas periódicas: o objeto ficava no
  // registry com `encerrandoIntencionalmente` grudado em true, e o canal
  // perdia o auto-reconnect pelo resto da vida do processo. Agora é spy, não
  // no-op, justamente para o teste conseguir afirmar que a chamada acontece.
  removerCanal: (...a: unknown[]) => removerCanalMock(...a),
}));

const { canaisRouter } = await import('./canais.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(canaisRouter);
  return app;
}

const CANAL_ID = 'canal-1';
const USER_ID = 'user-1';

/** Primeira leitura: buscarAtendenteAutenticado. */
function comAtendente(over: Record<string, unknown> = {}) {
  enfileirar('atendentes', { data: { id: 'atend-1', perfil: 'operador', ...over }, error: null });
}
/** Segunda leitura: canalNoEscopo -> hub.canais. */
function comCanal(empresaId: string | null = 'empresa-A') {
  enfileirar('canais', { data: { empresa_id: empresaId }, error: null });
}
/** Terceira leitura (só para não-admin): empresasDoAtendente. */
function comVinculos(...empresas: string[]) {
  enfileirar('atendente_empresas', {
    data: empresas.map((empresa_id) => ({ empresa_id })),
    error: null,
  });
}

beforeEach(() => {
  filas = {};
  canalVivo = { desconectar: desconectarMock, status: statusMock };
  conectarMock.mockReset();
  desconectarMock.mockReset();
  statusMock.mockClear();
});

describe('POST /canais/:id/conectar', () => {
  it('403 quando o usuário autenticado não é atendente ativo', async () => {
    enfileirar('atendentes', { data: null, error: null });

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(conectarMock).not.toHaveBeenCalled();
  });

  /* MUDOU em 2026-08-17 (PLANO_GOVERNANCA_ACESSOS.md, I6): conectar deixou de
   * ser liberado a qualquer atendente da empresa. Estar no escopo não basta —
   * é operação de infraestrutura, e a RLS de hub.canais já exigia admin para
   * escrita. Este teste antes esperava 202. */
  it('403 para operador, mesmo na empresa dona do canal', async () => {
    comAtendente();
    comCanal('empresa-A');
    comVinculos('empresa-A');

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(conectarMock).not.toHaveBeenCalled();
  });

  it('403 para supervisor, mesmo na empresa dona do canal', async () => {
    comAtendente({ perfil: 'supervisor' });
    comCanal('empresa-A');
    comVinculos('empresa-A');

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(conectarMock).not.toHaveBeenCalled();
  });

  it('202 para admin da empresa dona do canal', async () => {
    comAtendente({ perfil: 'admin' });
    comCanal('empresa-A');
    comVinculos('empresa-A');

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(202);
    expect(conectarMock).toHaveBeenCalledTimes(1);
  });

  it('403 para operador de OUTRA empresa — e não toca no canal', async () => {
    comAtendente();
    comCanal('empresa-A');
    comVinculos('empresa-B');

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(conectarMock).not.toHaveBeenCalled();
  });

  it('202 para admin em canal de qualquer empresa, sem consultar vínculos', async () => {
    comAtendente({ perfil: 'admin' });
    comCanal('empresa-Z');

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(202);
    expect(conectarMock).toHaveBeenCalledTimes(1);
  });

  it('404 quando o canal não existe', async () => {
    comAtendente({ perfil: 'admin' });
    enfileirar('canais', { data: null, error: null });

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(404);
    expect(conectarMock).not.toHaveBeenCalled();
  });

  it('403 quando o canal existe mas está sem empresa_id (não-admin)', async () => {
    comAtendente();
    comCanal(null);

    const res = await request(montarApp())
      .post(`/canais/${CANAL_ID}/conectar`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(conectarMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /canais/:id/sessao', () => {
  // A rota mais perigosa do arquivo: desconectar() sem preservarSessao faz
  // logout() protocolar e despareia o aparelho do vendedor.
  it('403 para operador de outra empresa — e NÃO desconecta a linha', async () => {
    comAtendente();
    comCanal('empresa-A');
    comVinculos('empresa-B');

    const res = await request(montarApp())
      .delete(`/canais/${CANAL_ID}/sessao`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(desconectarMock).not.toHaveBeenCalled();
  });

  /* `DELETE /sessao` chama logout() de protocolo e DESPAREIA o aparelho da
   * linha — derruba o atendimento da empresa inteira. Era a rota destrutiva
   * mais exposta: qualquer atendente ativo da empresa podia chamar. Agora só
   * admin (I6 do plano). Este teste antes esperava 202 para operador. */
  it('403 para operador — não despareia a linha da própria empresa', async () => {
    comAtendente();
    comCanal('empresa-A');
    comVinculos('empresa-A');

    const res = await request(montarApp())
      .delete(`/canais/${CANAL_ID}/sessao`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(desconectarMock).not.toHaveBeenCalled();
  });

  it('403 para supervisor — desparear é operação de admin', async () => {
    comAtendente({ perfil: 'supervisor' });
    comCanal('empresa-A');
    comVinculos('empresa-A');

    const res = await request(montarApp())
      .delete(`/canais/${CANAL_ID}/sessao`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(desconectarMock).not.toHaveBeenCalled();
  });

  it('202 e desconecta quando o admin manda', async () => {
    comAtendente({ perfil: 'admin' });
    comCanal('empresa-A');
    comVinculos('empresa-A');

    const res = await request(montarApp())
      .delete(`/canais/${CANAL_ID}/sessao`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(202);
    expect(desconectarMock).toHaveBeenCalledTimes(1);
  });

  // T10 — depois de um logout() de protocolo a sessão está morta e a
  // instância não serve mais para nada. Mantê-la no Map fazia o próximo
  // obterOuCriarCanal() devolver um zumbi carregando estado do ciclo
  // anterior — o canal nunca mais reconectava sozinho.
  it('tira o canal do registry depois de desconectar', async () => {
    comAtendente({ perfil: 'admin' });
    comCanal('empresa-A');
    comVinculos('empresa-A');
    removerCanalMock.mockClear();

    await request(montarApp()).delete(`/canais/${CANAL_ID}/sessao`).set('x-teste-user-id', USER_ID);

    expect(removerCanalMock).toHaveBeenCalledWith(CANAL_ID);
  });

  it('403 não pode tirar o canal do registry — nem desconectar, nem esquecer', async () => {
    comAtendente();
    comCanal('empresa-A');
    comVinculos('empresa-B');
    removerCanalMock.mockClear();

    const res = await request(montarApp())
      .delete(`/canais/${CANAL_ID}/sessao`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(removerCanalMock).not.toHaveBeenCalled();
  });

  it('404 quando o canal está no escopo mas não tem sessão em memória', async () => {
    comAtendente({ perfil: 'admin' });
    comCanal('empresa-A');
    canalVivo = undefined;

    const res = await request(montarApp())
      .delete(`/canais/${CANAL_ID}/sessao`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(404);
    expect(desconectarMock).not.toHaveBeenCalled();
  });
});

describe('GET /canais/:id/status', () => {
  it('devolve o status da sessão viva para quem está no escopo', async () => {
    comAtendente({ perfil: 'admin' });
    comCanal('empresa-A');

    const res = await request(montarApp())
      .get(`/canais/${CANAL_ID}/status`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'conectado' });
  });

  it('CONTRATO PRESERVADO: canal no escopo e sem sessão viva responde 200 desconectado', async () => {
    // O semáforo de Configurações → Canais faz poll disto a cada 30s e trata
    // 200 como fonte de verdade. Transformar este caso em 404 quebraria a tela.
    comAtendente({ perfil: 'admin' });
    comCanal('empresa-A');
    canalVivo = undefined;

    const res = await request(montarApp())
      .get(`/canais/${CANAL_ID}/status`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'desconectado' });
  });

  it('403 para canal de outra empresa — não vaza nem o estado da linha', async () => {
    comAtendente();
    comCanal('empresa-A');
    comVinculos('empresa-B');

    const res = await request(montarApp())
      .get(`/canais/${CANAL_ID}/status`)
      .set('x-teste-user-id', USER_ID);

    expect(res.status).toBe(403);
    expect(statusMock).not.toHaveBeenCalled();
  });
});
