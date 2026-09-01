// Rotas de disparo. Mocka auth, banco e worker.
//
// O que estes testes protegem: quem pode operar (só admin, só na empresa
// dele), o que o sistema recusa a fazer (janela invertida, iniciar sem
// fila, intervalo zero) e que o botão de parar tudo existe e funciona.
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = 'user-admin';
const OPERADOR = 'user-operador';
const EMPRESA = 'empresa-campanha';

vi.mock('../auth/middleware.js', () => ({
  requireSupabaseAuth: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.auth = { userId: req.headers['x-teste-user-id'] as string, claims: {} };
    next();
  },
}));

vi.mock('../auth/escopoConversa.js', () => ({
  buscarAtendenteAutenticado: vi.fn(async (userId: string) =>
    userId === ADMIN
      ? { id: 'atendente-admin', perfil: 'admin' }
      : userId === OPERADOR
        ? { id: 'atendente-op', perfil: 'operador' }
        : null,
  ),
  empresasDoAtendente: vi.fn(async () => new Set([EMPRESA])),
}));

const pararTudoMock = vi.fn(async (_motivo: string) => 2);
const religarMock = vi.fn();
vi.mock('../jobs/disparador.js', () => ({
  pararTudo: (m: string) => pararTudoMock(m),
  religarDisparos: () => religarMock(),
  disparoHabilitado: () => true,
}));

interface Est {
  disparos: Record<string, unknown>[];
  alvos: Record<string, unknown>[];
  clientes: Record<string, unknown>[];
  listaMembros: Record<string, unknown>[];
  listas: Record<string, unknown>[];
  erroAoIniciar: string | null;
}
let est: Est;

vi.mock('../db/client.server.js', () => {
  function fonte(t: string): Record<string, unknown>[] {
    if (t === 'disparos') return est.disparos;
    if (t === 'disparo_alvos') return est.alvos;
    if (t === 'clientes') return est.clientes;
    if (t === 'lista_eleitores') return est.listaMembros;
    if (t === 'listas') return est.listas;
    return [];
  }

  class Q {
    private filtros: Array<[string, string, unknown]> = [];
    private op: 'select' | 'update' | 'insert' = 'select';
    private patch: Record<string, unknown> | null = null;
    private linha: unknown = null;
    private contando = false;
    constructor(private t: string) {}
    select(_c?: string, o?: { count?: string }) {
      if (o?.count) this.contando = true;
      return this;
    }
    eq(k: string, v: unknown) {
      this.filtros.push(['eq', k, v]);
      return this;
    }
    in(k: string, v: unknown[]) {
      this.filtros.push(['in', k, v]);
      return this;
    }
    overlaps() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    update(p: Record<string, unknown>) {
      this.op = 'update';
      this.patch = p;
      return this;
    }
    insert(l: unknown) {
      this.op = 'insert';
      this.linha = l;
      return this;
    }
    private casadas() {
      return fonte(this.t).filter((l) =>
        this.filtros.every(([tipo, k, v]) =>
          tipo === 'in' ? (v as unknown[]).includes(l[k]) : l[k] === v,
        ),
      );
    }
    private exec(): { data: unknown; error: { message: string } | null; count?: number } {
      if (this.op === 'insert') {
        const linhas = Array.isArray(this.linha) ? this.linha : [this.linha];
        for (const l of linhas) {
          fonte(this.t).push({ ...(l as object), id: `${this.t}-${fonte(this.t).length + 1}` });
        }
        return { data: fonte(this.t)[fonte(this.t).length - 1], error: null };
      }
      if (this.op === 'update') {
        if (this.t === 'disparos' && est.erroAoIniciar && this.patch?.status === 'enviando') {
          return { data: null, error: { message: est.erroAoIniciar } };
        }
        const alvos = this.casadas();
        for (const l of alvos) Object.assign(l, this.patch);
        return { data: alvos, error: null };
      }
      const linhas = this.casadas();
      if (this.contando) return { data: null, error: null, count: linhas.length };
      return { data: linhas, error: null };
    }
    maybeSingle() {
      const r = this.exec();
      const d = r.data;
      return Promise.resolve({ data: Array.isArray(d) ? (d[0] ?? null) : d, error: r.error });
    }
    single() {
      return this.maybeSingle();
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve()
        .then(() => this.exec())
        .then(res, rej);
    }
  }
  return { supabaseAdmin: { from: (t: string) => new Q(t) } };
});

const { disparosRouter } = await import('./disparos.js');
const app = express();
app.use(express.json());
app.use(disparosRouter);

const CORPO_BASE = {
  empresaId: EMPRESA,
  nome: 'Primeira onda',
  textoBase: 'Oi {{primeiro_nome}}, aqui é da campanha. Responda SAIR para não receber mais.',
  canalId: 'canal-1',
  listaId: 'lista-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  est = {
    disparos: [],
    alvos: [],
    clientes: [
      { id: 'cli-1', empresa_id: EMPRESA, nome: 'Maria Silva', bairro: 'Centro', cidade: 'Timbó', situacao: 'ativo', telefone: '5547999887766', opt_out_em: null },
    ],
    listaMembros: [],
    listas: [],
    erroAoIniciar: null,
  };
});

describe('autorização', () => {
  it('recusa operador em toda rota de disparo', async () => {
    const r = await request(app).post('/disparos').set('x-teste-user-id', OPERADOR).send(CORPO_BASE);
    expect(r.status).toBe(403);
  });

  it('recusa empresa fora do escopo', async () => {
    const r = await request(app)
      .post('/disparos')
      .set('x-teste-user-id', ADMIN)
      .send({ ...CORPO_BASE, empresaId: 'outra' });
    expect(r.status).toBe(403);
  });
});

describe('POST /disparos', () => {
  it('cria em rascunho, sem enviar nada', async () => {
    const r = await request(app).post('/disparos').set('x-teste-user-id', ADMIN).send(CORPO_BASE);
    expect(r.status).toBe(201);
    expect(est.disparos[0]).toMatchObject({ status: 'rascunho', nome: 'Primeira onda' });
    expect(est.alvos).toHaveLength(0);
  });

  it('aplica a janela e o intervalo padrão quando não vêm', async () => {
    await request(app).post('/disparos').set('x-teste-user-id', ADMIN).send(CORPO_BASE);
    expect(est.disparos[0]).toMatchObject({
      janela_inicio: '09:00',
      janela_fim: '20:00',
      intervalo_min_seg: 25,
      intervalo_max_seg: 90,
    });
  });

  it('recusa janela invertida em vez de virar envio de madrugada', async () => {
    const r = await request(app)
      .post('/disparos')
      .set('x-teste-user-id', ADMIN)
      .send({ ...CORPO_BASE, janelaInicio: '20:00', janelaFim: '09:00' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('meia-noite');
  });

  it('recusa intervalo zero — é a diferença entre campanha e flood', async () => {
    const r = await request(app)
      .post('/disparos')
      .set('x-teste-user-id', ADMIN)
      .send({ ...CORPO_BASE, intervaloMinSeg: 0 });
    expect(r.status).toBe(400);
  });

  it('recusa intervalo máximo menor que o mínimo', async () => {
    const r = await request(app)
      .post('/disparos')
      .set('x-teste-user-id', ADMIN)
      .send({ ...CORPO_BASE, intervaloMinSeg: 60, intervaloMaxSeg: 10 });
    expect(r.status).toBe(400);
  });

  it('exige texto, canal e lista', async () => {
    for (const campo of ['textoBase', 'canalId', 'listaId'] as const) {
      const corpo: Record<string, unknown> = { ...CORPO_BASE };
      delete corpo[campo];
      const r = await request(app).post('/disparos').set('x-teste-user-id', ADMIN).send(corpo);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(campo);
    }
  });
});

describe('POST /disparos/:id/preparar', () => {
  beforeEach(() => {
    est.disparos = [
      { id: 'd1', empresa_id: EMPRESA, status: 'rascunho', canal_id: 'canal-1', lista_id: 'lista-1', texto_base: 'oi', pausado_em: null },
    ];
  });

  it('materializa a fila a partir da lista', async () => {
    est.listaMembros = [
      { lista_id: 'lista-1', cliente_id: 'cli-1', clientes: { id: 'cli-1', telefone: '5547999887766', situacao: 'ativo', opt_out_em: null } },
    ];
    const r = await request(app)
      .post('/disparos/d1/preparar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.status).toBe(200);
    expect(r.body.preparados).toBe(1);
    expect(est.alvos).toHaveLength(1);
    expect(est.alvos[0]).toMatchObject({ status: 'pendente', cliente_id: 'cli-1' });
  });

  it('tira da fila quem pediu descadastro, e diz quantos', async () => {
    est.listaMembros = [
      { lista_id: 'lista-1', cliente_id: 'cli-1', clientes: { id: 'cli-1', telefone: '1', situacao: 'ativo', opt_out_em: null } },
      { lista_id: 'lista-1', cliente_id: 'cli-2', clientes: { id: 'cli-2', telefone: '2', situacao: 'opt_out', opt_out_em: '2026-09-01' } },
      { lista_id: 'lista-1', cliente_id: 'cli-3', clientes: { id: 'cli-3', telefone: '3', situacao: 'bloqueado', opt_out_em: null } },
    ];
    const r = await request(app)
      .post('/disparos/d1/preparar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.body.preparados).toBe(1);
    expect(r.body.removidos).toBe(2);
    expect(r.body.aviso).toContain('descadastro');
  });

  it('recusa preparar duas vezes', async () => {
    est.disparos[0].status = 'enviando';
    const r = await request(app)
      .post('/disparos/d1/preparar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.status).toBe(409);
  });

  it('recusa lista em que ninguém pode receber', async () => {
    est.listaMembros = [
      { lista_id: 'lista-1', cliente_id: 'cli-2', clientes: { id: 'cli-2', telefone: '2', situacao: 'opt_out', opt_out_em: '2026-09-01' } },
    ];
    const r = await request(app)
      .post('/disparos/d1/preparar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.status).toBe(400);
  });
});

describe('POST /disparos/:id/iniciar', () => {
  beforeEach(() => {
    est.disparos = [
      { id: 'd1', empresa_id: EMPRESA, status: 'rascunho', canal_id: 'canal-1', lista_id: 'lista-1', texto_base: 'oi', pausado_em: null },
    ];
  });

  it('liga o disparo quando há fila', async () => {
    est.alvos = [{ id: 'a1', disparo_id: 'd1', status: 'pendente' }];
    const r = await request(app)
      .post('/disparos/d1/iniciar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.status).toBe(200);
    expect(est.disparos[0].status).toBe('enviando');
  });

  it('recusa iniciar sem fila preparada', async () => {
    const r = await request(app)
      .post('/disparos/d1/iniciar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Prepare a fila');
  });

  it('devolve a mensagem do guarda-corpo do banco em vez de reescrevê-la', async () => {
    // O trigger hub.impede_disparo_sem_base_legal já explica o problema
    // melhor do que qualquer coisa que a gente inventasse aqui.
    est.alvos = [{ id: 'a1', disparo_id: 'd1', status: 'pendente' }];
    est.erroAoIniciar = 'Disparo tem 3 destinatário(s) sem base legal declarada.';
    const r = await request(app)
      .post('/disparos/d1/iniciar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('sem base legal');
  });

  it('recusa iniciar disparo já concluído', async () => {
    est.disparos[0].status = 'concluido';
    const r = await request(app)
      .post('/disparos/d1/iniciar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(r.status).toBe(409);
  });
});

describe('pausar, retomar e parar tudo', () => {
  beforeEach(() => {
    est.disparos = [
      { id: 'd1', empresa_id: EMPRESA, status: 'enviando', canal_id: 'c1', lista_id: 'l1', texto_base: 'oi', pausado_em: null },
    ];
  });

  it('pausa com motivo', async () => {
    const r = await request(app)
      .post('/disparos/d1/pausar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA, motivo: 'conferir o texto' });
    expect(r.status).toBe(200);
    expect(est.disparos[0].pausado_em).toBeTruthy();
    expect(est.disparos[0].pausa_motivo).toBe('conferir o texto');
  });

  it('retoma limpando o motivo', async () => {
    est.disparos[0].pausado_em = '2026-09-01T10:00:00Z';
    await request(app)
      .post('/disparos/d1/retomar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(est.disparos[0].pausado_em).toBeNull();
    expect(est.disparos[0].pausa_motivo).toBeNull();
  });

  it('o botão vermelho chama o worker e reporta quantos parou', async () => {
    const r = await request(app)
      .post('/disparos/parar-tudo')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA, motivo: 'reclamação no grupo' });
    expect(r.status).toBe(200);
    expect(r.body.disparosPausados).toBe(2);
    expect(pararTudoMock).toHaveBeenCalledWith('reclamação no grupo');
  });

  it('religar não retoma disparo nenhum sozinho', async () => {
    // Cada campanha precisa ser retomada de propósito, uma a uma.
    est.disparos[0].pausado_em = '2026-09-01T10:00:00Z';
    await request(app)
      .post('/disparos/religar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA });
    expect(religarMock).toHaveBeenCalled();
    expect(est.disparos[0].pausado_em).toBe('2026-09-01T10:00:00Z');
  });

  it('operador não pode parar tudo nem religar', async () => {
    const parar = await request(app)
      .post('/disparos/parar-tudo')
      .set('x-teste-user-id', OPERADOR)
      .send({ empresaId: EMPRESA });
    expect(parar.status).toBe(403);
    expect(pararTudoMock).not.toHaveBeenCalled();
  });
});

describe('POST /disparos/previsualizar', () => {
  it('mostra a mensagem já substituída, com gente de verdade', async () => {
    // Sem isto, o primeiro a ver o texto substituído é o eleitor.
    const r = await request(app)
      .post('/disparos/previsualizar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA, textoBase: 'Oi {{primeiro_nome}}, tudo bem no {{bairro}}?' });
    expect(r.status).toBe(200);
    expect(r.body.exemplos[0]).toMatchObject({
      para: 'Maria Silva',
      texto: 'Oi Maria, tudo bem no Centro?',
    });
  });

  it('exige o texto', async () => {
    const r = await request(app)
      .post('/disparos/previsualizar')
      .set('x-teste-user-id', ADMIN)
      .send({ empresaId: EMPRESA, textoBase: '   ' });
    expect(r.status).toBe(400);
  });
});
