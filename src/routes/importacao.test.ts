// Rotas de importação de eleitores. Mocka auth e banco — não toca rede.
//
// O que estes testes protegem, em ordem de custo do erro:
//   1. quem já pediu descadastro NUNCA volta por reimportação
//   2. sem procedência declarada, não grava
//   3. prévia não grava eleitor nenhum
//   4. só admin, e só na empresa dele
import express from 'express';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = 'user-admin';
const OPERADOR = 'user-operador';
const EMPRESA = 'empresa-campanha';
const OUTRA_EMPRESA = 'empresa-alheia';

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
        ? { id: 'atendente-operador', perfil: 'operador' }
        : null,
  ),
  empresasDoAtendente: vi.fn(async () => new Set([EMPRESA])),
}));

/** Estado do "banco" entre os testes. */
let clientesExistentes: Array<{ telefone: string; situacao: string }>;
let clientesInseridos: Record<string, unknown>[];
let importacoesInseridas: Record<string, unknown>[];
let falhaNoInsertDeClientes: string | null;

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: {
    from: (tabela: string) => {
      if (tabela === 'clientes') {
        return {
          select: () => ({
            eq: () => ({
              in: (_coluna: string, telefones: string[]) =>
                Promise.resolve({
                  data: clientesExistentes.filter((c) => telefones.includes(c.telefone)),
                  error: null,
                }),
            }),
          }),
          insert: (linhas: Record<string, unknown>[]) => {
            if (falhaNoInsertDeClientes) {
              return Promise.resolve({ error: { message: falhaNoInsertDeClientes } });
            }
            clientesInseridos.push(...linhas);
            return Promise.resolve({ error: null });
          },
        };
      }
      // importacoes
      return {
        insert: (linha: Record<string, unknown>) => {
          importacoesInseridas.push(linha);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'imp-1' }, error: null }),
            }),
          };
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        select: () => ({
          eq: () => ({
            order: () => ({ limit: () => Promise.resolve({ data: importacoesInseridas, error: null }) }),
          }),
        }),
      };
    },
  },
}));

const { importacaoRouter } = await import('./importacao.js');

const app = express();
app.use(importacaoRouter);

async function planilha(linhas: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('l');
  for (const l of linhas) ws.addRow(l);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const MAPEAMENTO = JSON.stringify({ Nome: 'nome', Telefone: 'telefone' });

beforeEach(() => {
  clientesExistentes = [];
  clientesInseridos = [];
  importacoesInseridas = [];
  falhaNoInsertDeClientes = null;
});

describe('POST /importacoes/analisar', () => {
  it('devolve colunas e palpite de mapeamento sem gravar nada', async () => {
    const buf = await planilha([
      ['Nome Completo', 'Celular', 'Bairro'],
      ['Maria', '47999887766', 'Centro'],
    ]);
    const r = await request(app)
      .post('/importacoes/analisar')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .attach('arquivo', buf, 'lista.xlsx');

    expect(r.status).toBe(200);
    expect(r.body.colunas).toEqual(['Nome Completo', 'Celular', 'Bairro']);
    expect(r.body.mapeamentoSugerido).toMatchObject({ 'Nome Completo': 'nome', Celular: 'telefone' });
    expect(r.body.totalLinhas).toBe(1);
    expect(importacoesInseridas).toHaveLength(0);
  });

  it('recusa planilha só com cabeçalho', async () => {
    const buf = await planilha([['Nome', 'Telefone']]);
    const r = await request(app)
      .post('/importacoes/analisar')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .attach('arquivo', buf, 'l.xlsx');
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('nenhuma linha');
  });

  it('recusa operador', async () => {
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await request(app)
      .post('/importacoes/analisar')
      .set('x-teste-user-id', OPERADOR)
      .field('empresaId', EMPRESA)
      .attach('arquivo', buf, 'l.xlsx');
    expect(r.status).toBe(403);
  });

  it('recusa empresa fora do escopo do admin', async () => {
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await request(app)
      .post('/importacoes/analisar')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', OUTRA_EMPRESA)
      .attach('arquivo', buf, 'l.xlsx');
    expect(r.status).toBe(403);
  });
});

describe('POST /importacoes — prévia', () => {
  it('conta sem gravar eleitor nenhum', async () => {
    const buf = await planilha([
      ['Nome', 'Telefone'],
      ['Maria', '47999887766'],
      ['João', '123'],
      ['Ana', '47988776655'],
      ['Ana de novo', '(47) 98877-6655'],
    ]);
    const r = await request(app)
      .post('/importacoes')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .field('origem', 'cadastro do site')
      .field('baseLegal', 'consentimento')
      .field('mapeamento', MAPEAMENTO)
      .field('confirmar', 'false')
      .attach('arquivo', buf, 'l.xlsx');

    expect(r.status).toBe(200);
    expect(r.body.status).toBe('previa');
    expect(r.body.contagem).toMatchObject({
      linhasLidas: 4,
      aceitas: 2,
      invalidas: 1,
      duplicadas: 1,
    });
    expect(clientesInseridos).toHaveLength(0);
    // A prévia é registrada mesmo assim: mostra que alguém tentou subir
    // uma lista, e com qual procedência declarada.
    expect(importacoesInseridas).toHaveLength(1);
    expect(importacoesInseridas[0]).toMatchObject({ status: 'previa', linhas_aceitas: 0 });
  });

  it('avisa quando a lista tem gente que já pediu descadastro', async () => {
    clientesExistentes = [{ telefone: '5547999887766', situacao: 'opt_out' }];
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await request(app)
      .post('/importacoes')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .field('origem', 'evento')
      .field('baseLegal', 'consentimento')
      .field('mapeamento', MAPEAMENTO)
      .field('confirmar', 'false')
      .attach('arquivo', buf, 'l.xlsx');

    expect(r.status).toBe(200);
    expect(r.body.contagem.optOut).toBe(1);
    expect(r.body.contagem.aceitas).toBe(0);
    expect(r.body.aviso).toContain('descadastro');
  });
});

describe('POST /importacoes — confirmação', () => {
  it('grava os novos com procedência e vínculo da importação', async () => {
    const buf = await planilha([
      ['Nome', 'Telefone'],
      ['Maria Silva', '47999887766'],
    ]);
    const r = await request(app)
      .post('/importacoes')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .field('origem', 'caravana do bairro Centro')
      .field('baseLegal', 'consentimento')
      .field('mapeamento', MAPEAMENTO)
      .field('confirmar', 'true')
      .attach('arquivo', buf, 'l.xlsx');

    expect(r.status).toBe(201);
    expect(clientesInseridos).toHaveLength(1);
    expect(clientesInseridos[0]).toMatchObject({
      empresa_id: EMPRESA,
      nome: 'Maria Silva',
      telefone: '5547999887766',
      origem: 'caravana do bairro Centro',
      base_legal: 'consentimento',
      importacao_id: 'imp-1',
      situacao: 'ativo',
    });
    expect(clientesInseridos[0].consentimento_em).toBeTruthy();
  });

  it('NUNCA ressuscita quem pediu descadastro, mesmo reimportando o arquivo', async () => {
    // O modo de falha que este teste existe para impedir: um descadastro
    // atendido virar uma segunda mensagem porque alguém subiu a planilha
    // antiga de novo.
    clientesExistentes = [{ telefone: '5547999887766', situacao: 'opt_out' }];
    const buf = await planilha([
      ['Nome', 'Telefone'],
      ['Maria', '47999887766'],
      ['Novo Contato', '47988776655'],
    ]);
    const r = await request(app)
      .post('/importacoes')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .field('origem', 'planilha antiga')
      .field('baseLegal', 'consentimento')
      .field('mapeamento', MAPEAMENTO)
      .field('confirmar', 'true')
      .attach('arquivo', buf, 'l.xlsx');

    expect(r.status).toBe(201);
    expect(clientesInseridos).toHaveLength(1);
    expect(clientesInseridos[0].telefone).toBe('5547988776655');
    expect(clientesInseridos.some((c) => c.telefone === '5547999887766')).toBe(false);
  });

  it('base legal não declarada entra bloqueada, não ativa', async () => {
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await request(app)
      .post('/importacoes')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .field('origem', 'planilha recebida de terceiro')
      .field('baseLegal', 'nao_declarada')
      .field('mapeamento', MAPEAMENTO)
      .field('confirmar', 'true')
      .attach('arquivo', buf, 'l.xlsx');

    expect(r.status).toBe(201);
    expect(clientesInseridos[0]).toMatchObject({ situacao: 'bloqueado', base_legal: 'nao_declarada' });
    expect(clientesInseridos[0].consentimento_em).toBeNull();
  });

  it('marca a importação como erro quando o insert falha no meio', async () => {
    falhaNoInsertDeClientes = 'conexão caiu';
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await request(app)
      .post('/importacoes')
      .set('x-teste-user-id', ADMIN)
      .field('empresaId', EMPRESA)
      .field('origem', 'evento')
      .field('baseLegal', 'consentimento')
      .field('mapeamento', MAPEAMENTO)
      .field('confirmar', 'true')
      .attach('arquivo', buf, 'l.xlsx');

    expect(r.status).toBe(500);
    expect(r.body.error).toContain('conexão caiu');
  });
});

describe('POST /importacoes — validação de entrada', () => {
  const anexar = (buf: Buffer, campos: Record<string, string>) => {
    const req = request(app).post('/importacoes').set('x-teste-user-id', ADMIN);
    for (const [k, v] of Object.entries(campos)) req.field(k, v);
    return req.attach('arquivo', buf, 'l.xlsx');
  };

  it('exige origem — é o que responde "por que vocês têm o meu número"', async () => {
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await anexar(buf, {
      empresaId: EMPRESA,
      baseLegal: 'consentimento',
      mapeamento: MAPEAMENTO,
      confirmar: 'false',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('origem');
  });

  it('recusa base legal fora da lista fechada', async () => {
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await anexar(buf, {
      empresaId: EMPRESA,
      origem: 'evento',
      baseLegal: 'porque sim',
      mapeamento: MAPEAMENTO,
      confirmar: 'false',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('baseLegal');
  });

  it('recusa mapeamento sem telefone', async () => {
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await anexar(buf, {
      empresaId: EMPRESA,
      origem: 'evento',
      baseLegal: 'consentimento',
      mapeamento: JSON.stringify({ Nome: 'nome' }),
      confirmar: 'false',
    });
    expect(r.status).toBe(400);
    expect(r.body.problemas.map((p: { campo: string }) => p.campo)).toContain('telefone');
  });

  it('recusa mapeamento que não é JSON', async () => {
    const buf = await planilha([['Nome', 'Telefone'], ['Maria', '47999887766']]);
    const r = await anexar(buf, {
      empresaId: EMPRESA,
      origem: 'evento',
      baseLegal: 'consentimento',
      mapeamento: 'Nome=nome',
      confirmar: 'false',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('JSON');
  });
});

describe('GET /importacoes', () => {
  it('lista o histórico da empresa', async () => {
    importacoesInseridas = [{ id: 'imp-1', arquivo_nome: 'lista.xlsx' }];
    const r = await request(app)
      .get('/importacoes')
      .query({ empresaId: EMPRESA })
      .set('x-teste-user-id', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.importacoes).toHaveLength(1);
  });

  it('recusa operador', async () => {
    const r = await request(app)
      .get('/importacoes')
      .query({ empresaId: EMPRESA })
      .set('x-teste-user-id', OPERADOR);
    expect(r.status).toBe(403);
  });
});
