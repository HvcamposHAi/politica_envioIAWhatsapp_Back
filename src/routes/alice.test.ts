// Teste pontual: POST /alice/chat (PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md,
// fase 3, §9.2). O foco é a validação de entrada e a guarda de auth — o
// escopo dos dados é testado em services/alice.test.ts, onde está a lógica.
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

let atendente: { id: string; perfil: string } | null = { id: 'atend-1', perfil: 'admin' };
vi.mock('../auth/escopoConversa.js', () => ({
  buscarAtendenteAutenticado: () => Promise.resolve(atendente),
  empresasDoAtendente: () => Promise.resolve(new Set<string>()),
  setoresSupervisionados: () => Promise.resolve(new Set<string>()),
}));

const responderAliceMock = vi.fn();
vi.mock('../services/alice.js', () => ({
  responderAlice: (...args: unknown[]) => responderAliceMock(...args),
}));

const { aliceRouter } = await import('./alice.js');

function montarApp() {
  const app = express();
  app.use(express.json());
  app.use(aliceRouter);
  return app;
}

/* O rate limit é por usuário e vive no módulo, então persiste entre os testes.
 * Cada caso usa um userId próprio para não consumir a cota do seguinte — foi
 * assim que este arquivo descobriu que o limite realmente funciona: a primeira
 * versão usava um id fixo e o último teste recebia 429. O limite em si é
 * exercitado de propósito no último caso. */
let seq = 0;
const novoUsuario = () => `user-${++seq}`;
const perguntar = (body: object, user = novoUsuario()) =>
  request(montarApp()).post('/alice/chat').set('x-teste-user-id', user).send(body);

beforeEach(() => {
  atendente = { id: 'atend-1', perfil: 'admin' };
  responderAliceMock.mockReset();
  responderAliceMock.mockResolvedValue('Compras tem 9 chamados sem dono.');
});

describe('POST /alice/chat', () => {
  it('responde a pergunta e repassa os filtros do Painel', async () => {
    const r = await perguntar({
      mensagens: [{ role: 'user', content: 'Como está o setor Compras?' }],
      filtros: { setorId: 'setor-1' },
    });

    expect(r.status).toBe(200);
    expect(r.body.resposta).toContain('Compras');
    // O atendente vai como PRIMEIRO argumento — é dele que sai o escopo.
    expect(responderAliceMock).toHaveBeenCalledWith(
      'atend-1',
      [{ role: 'user', content: 'Como está o setor Compras?' }],
      expect.objectContaining({ setorId: 'setor-1' }),
      // 4º argumento: o indicador clicado. `undefined` aqui é o caminho do chat
      // de texto livre — e é o que mantém um front antigo funcionando contra
      // este backend (PLANO_PAINEL_CLICAVEL_ALICE_CONTEXTUAL.md, §3.5).
      undefined,
    );
  });

  /* T25–T27 do PLANO_GOVERNANCA_ACESSOS.md (incoerência I2).
   *
   * A Alice responde sobre a OPERAÇÃO — volume, ranking por atendente, motivos
   * de perda, CSAT — e o Painel, que é a tela dela, sempre foi supervisor/admin.
   * Só que isso vivia apenas em `abasVisiveis` no front: esta rota aceitava
   * qualquer atendente ativo, então um operador com o próprio token obtinha os
   * indicadores da empresa inteira por curl. */
  it('403 para operador — a Alice atende supervisão e administração', async () => {
    atendente = { id: 'atend-1', perfil: 'operador' };

    const r = await perguntar({
      mensagens: [{ role: 'user', content: 'quantos chamados abertos existem?' }],
    });

    expect(r.status).toBe(403);
    // Não basta responder 403: o contexto não pode nem ser montado.
    expect(responderAliceMock).not.toHaveBeenCalled();
  });

  it('403 para perfil desconhecido (fail-closed)', async () => {
    atendente = { id: 'atend-1', perfil: 'atendente' };

    const r = await perguntar({ mensagens: [{ role: 'user', content: 'e aí?' }] });

    expect(r.status).toBe(403);
    expect(responderAliceMock).not.toHaveBeenCalled();
  });

  it('200 para supervisor', async () => {
    atendente = { id: 'atend-1', perfil: 'supervisor' };

    const r = await perguntar({
      mensagens: [{ role: 'user', content: 'como está a operação?' }],
    });

    expect(r.status).toBe(200);
    expect(responderAliceMock).toHaveBeenCalledTimes(1);
  });

  it('403 quando o usuário não é atendente ativo', async () => {
    atendente = null;

    const r = await perguntar({ mensagens: [{ role: 'user', content: 'oi' }] });

    expect(r.status).toBe(403);
    expect(responderAliceMock).not.toHaveBeenCalled();
  });

  it('400 em histórico vazio, longo demais ou malformado', async () => {
    expect((await perguntar({ mensagens: [] })).status).toBe(400);
    expect((await perguntar({})).status).toBe(400);
    expect((await perguntar({ mensagens: [{ role: 'sistema', content: 'x' }] })).status).toBe(400);
    expect((await perguntar({ mensagens: [{ role: 'user', content: '' }] })).status).toBe(400);

    const longo = Array.from({ length: 21 }, () => ({ role: 'user', content: 'oi' }));
    expect((await perguntar({ mensagens: longo })).status).toBe(400);

    const gigante = [{ role: 'user', content: 'x'.repeat(4001) }];
    expect((await perguntar({ mensagens: gigante })).status).toBe(400);

    expect(responderAliceMock).not.toHaveBeenCalled();
  });

  it('400 quando a última mensagem não é do usuário', async () => {
    // A API da Anthropic exige que a conversa termine numa fala do usuário.
    const r = await perguntar({
      mensagens: [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'olá' },
      ],
    });

    expect(r.status).toBe(400);
  });

  it('ignora filtros que não sejam string (não deixa objeto vazar para a query)', async () => {
    await perguntar({
      mensagens: [{ role: 'user', content: 'oi' }],
      filtros: { setorId: { $ne: null }, empresaId: 123 },
    });

    expect(responderAliceMock).toHaveBeenCalledWith(
      'atend-1',
      expect.anything(),
      {
        empresaId: undefined,
        setorId: undefined,
        atendenteId: undefined,
      },
      undefined,
    );
  });

  it('500 com mensagem acionável quando a chave da Anthropic está inválida', async () => {
    responderAliceMock.mockRejectedValue(Object.assign(new Error('401'), { status: 401 }));

    const r = await perguntar({ mensagens: [{ role: 'user', content: 'oi' }] });

    expect(r.status).toBe(500);
    expect(r.body.error).toContain('Configurações → Integrações');
  });

  it('429 depois de 20 perguntas no mesmo minuto (teto por usuário)', async () => {
    /* Cada pergunta custa uma chamada ao modelo com a janela inteira de
     * contexto. Sem teto por usuário, um loop no front vira conta alta em
     * minutos.
     *
     * Subiu de 10 para 20 quando o Painel virou clicável: explorar cards gera
     * muito mais requisições que digitar perguntas, e um 429 no meio da
     * exploração leria como bug em vez de proteção. */
    const mesmoUsuario = novoUsuario();
    const corpo = { mensagens: [{ role: 'user', content: 'oi' }] };

    for (let i = 0; i < 20; i++) {
      expect((await perguntar(corpo, mesmoUsuario)).status).toBe(200);
    }

    const excedente = await perguntar(corpo, mesmoUsuario);
    expect(excedente.status).toBe(429);
    // O 21º nem chega no serviço — é o ponto do limite.
    expect(responderAliceMock).toHaveBeenCalledTimes(20);
  });

  // ----- indicador em foco (PLANO_PAINEL_CLICAVEL_ALICE_CONTEXTUAL.md, §8.1) -----

  const focoValido = {
    tipo: 'kpi_chamados',
    titulo: 'Chamados',
    valor: '13',
    periodo: '30',
    desde: new Date(Date.now() - 30 * 864e5).toISOString(),
    linhas: ['sem base anterior'],
  };

  it('repassa o foco válido como 4º argumento', async () => {
    const r = await perguntar({ mensagens: [{ role: 'user', content: 'explique' }], foco: focoValido });

    expect(r.status).toBe(200);
    expect(responderAliceMock).toHaveBeenCalledWith(
      'atend-1',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tipo: 'kpi_chamados', valor: '13', periodo: '30' }),
    );
  });

  it('400 quando o tipo do indicador está fora da allowlist', async () => {
    /* 400 e não "ignora e segue": o foco é produzido pela nossa própria UI, então
     * um tipo desconhecido é bug de deploy (front à frente do backend) ou
     * requisição forjada. Engolir esconderia os dois. */
    const r = await perguntar({
      mensagens: [{ role: 'user', content: 'oi' }],
      foco: { ...focoValido, tipo: 'kpi_inventado' },
    });

    expect(r.status).toBe(400);
    expect(responderAliceMock).not.toHaveBeenCalled();
  });

  it('400 em período inválido, título gigante, data inválida e detalhes demais', async () => {
    const casos = [
      { ...focoValido, periodo: '90' },
      { ...focoValido, titulo: 'x'.repeat(121) },
      { ...focoValido, valor: 'x'.repeat(61) },
      { ...focoValido, desde: 'ontem' },
      { ...focoValido, linhas: Array.from({ length: 9 }, () => 'x') },
      { ...focoValido, linhas: ['x'.repeat(201)] },
    ];

    for (const foco of casos) {
      const r = await perguntar({ mensagens: [{ role: 'user', content: 'oi' }], foco });
      expect(r.status, JSON.stringify(foco).slice(0, 80)).toBe(400);
    }
    expect(responderAliceMock).not.toHaveBeenCalled();
  });

  it('descarta id de recorte que não seja UUID (nada de operador do PostgREST)', async () => {
    await perguntar({
      mensagens: [{ role: 'user', content: 'oi' }],
      foco: {
        ...focoValido,
        tipo: 'area_setor',
        recorte: { setorId: { $ne: null }, atendenteId: 'nao-e-uuid', canalId: 42 },
      },
    });

    const recorte = responderAliceMock.mock.calls[0][3].recorte;
    expect(recorte).toEqual({
      setorId: undefined,
      atendenteId: undefined,
      canalId: undefined,
      conversaId: undefined,
      motivo: undefined,
    });
  });
});
