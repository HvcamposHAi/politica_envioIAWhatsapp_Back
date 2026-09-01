// Teste pontual da captura de CSAT (PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md,
// fase 2). O foco é a regra conservadora: perder uma nota é aceitável,
// sequestrar uma mensagem de negócio para dentro de um chamado fechado não é.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let updates: { tabela: string; campos: Record<string, unknown> }[] = [];
let inserts: { tabela: string; campos: Record<string, unknown> }[] = [];
let pendente: unknown = null;
let erroBusca: { message: string } | null = null;
/** Resultado do select em `mensagens` (checagem de reentrega). */
let mensagemExistente: unknown = null;
/** Linhas devolvidas pelo `.select()` do UPDATE — é assim que o código
 *  distingue "gravei" de "a guarda de corrida barrou". Lista vazia = perdi a
 *  corrida para outra entrega da mesma resposta. */
let linhasAtualizadas: { id: string }[] = [{ id: 'conversa-fechada-1' }];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encadear(resultado: unknown): any {
  const builder = {
    eq: () => builder,
    is: () => builder,
    not: () => builder,
    gte: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve(resultado),
    maybeSingle: () => Promise.resolve(resultado),
    then: (resolve: (v: unknown) => void) => resolve(resultado),
  };
  return builder;
}

const fromMock = vi.fn((tabela: string) => ({
  select: () =>
    encadear(
      tabela === 'mensagens'
        ? { data: mensagemExistente, error: null }
        : { data: pendente, error: erroBusca },
    ),
  update: (campos: Record<string, unknown>) => {
    updates.push({ tabela, campos });
    // O `.select()` encadeado depois do update devolve as linhas afetadas.
    return {
      eq: function () {
        return this;
      },
      is: function () {
        return this;
      },
      select: () => Promise.resolve({ data: linhasAtualizadas, error: null }),
    };
  },
  insert: (campos: Record<string, unknown>) => {
    inserts.push({ tabela, campos });
    return encadear({ data: null, error: null });
  },
}));

vi.mock('../db/client.server.js', () => ({ supabaseAdmin: { from: fromMock } }));

const { parseNotaAvaliacao, tentarRegistrarAvaliacao } = await import('./avaliacao.js');

const CLIENTE = 'cliente-1';
const CANAL = 'canal-1';
const CONVERSA_FECHADA = 'conversa-fechada-1';

function comPendencia() {
  pendente = { id: CONVERSA_FECHADA, avaliacao_solicitada_em: new Date().toISOString() };
}

beforeEach(() => {
  updates = [];
  inserts = [];
  pendente = null;
  erroBusca = null;
  mensagemExistente = null;
  linhasAtualizadas = [{ id: CONVERSA_FECHADA }];
  fromMock.mockClear();
});

describe('parseNotaAvaliacao', () => {
  it('aceita dígito de 1 a 5, com ou sem espaço em volta', () => {
    expect(parseNotaAvaliacao('4')).toBe(4);
    expect(parseNotaAvaliacao('  1  ')).toBe(1);
    expect(parseNotaAvaliacao('5')).toBe(5);
  });

  it('recusa qualquer coisa que não seja o dígito isolado', () => {
    // Cada um destes, se aceito, engoliria uma mensagem de negócio.
    for (const t of ['nota 4', '4 estrelas', '10', '0', '6', '5.', '4/5', 'quero 2 sacas de milho', '', '   ']) {
      expect(parseNotaAvaliacao(t)).toBeNull();
    }
  });

  it('recusa null e undefined sem quebrar', () => {
    expect(parseNotaAvaliacao(null)).toBeNull();
    expect(parseNotaAvaliacao(undefined)).toBeNull();
  });
});

describe('tentarRegistrarAvaliacao', () => {
  it('grava a nota e a mensagem na conversa fechada quando há pendência', async () => {
    comPendencia();

    const r = await tentarRegistrarAvaliacao(CLIENTE, CANAL, '3', 'wa-1');

    expect(r).toMatchObject({ capturada: true, conversaId: CONVERSA_FECHADA, nota: 3 });
    expect(updates[0].campos.nota_satisfacao).toBe(3);
    expect(updates[0].campos.avaliacao_registrada_em).toBeTruthy();
    expect(inserts[0]).toMatchObject({
      tabela: 'mensagens',
      campos: { conversa_id: CONVERSA_FECHADA, autor: 'cliente', texto: '3' },
    });
  });

  it('não consulta o banco quando o texto nem parece nota', async () => {
    // O parse local descarta a esmagadora maioria das mensagens; ir ao banco
    // a cada mensagem recebida seria custo no caminho quente do inbound.
    const r = await tentarRegistrarAvaliacao(CLIENTE, CANAL, 'bom dia, preciso de um orçamento');

    expect(r.capturada).toBe(false);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('devolve ao fluxo normal quando não há pendência (nota vira conversa nova)', async () => {
    pendente = null;

    const r = await tentarRegistrarAvaliacao(CLIENTE, CANAL, '5');

    expect(r.capturada).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('consome a REENTREGA de uma nota já registrada, sem agradecer de novo', async () => {
    // Regressão: o Baileys reemite messages.upsert após reconectar. Na
    // segunda entrega a pendência já não existe (a nota foi gravada), então
    // sem esta checagem a mensagem cairia no fluxo normal e
    // resolverConversaAberta criaria uma CONVERSA FANTASMA — vazia, porque o
    // insert seguinte vira no-op pelo unique de wa_message_id.
    pendente = null;
    mensagemExistente = { id: 'mensagem-ja-gravada' };

    const r = await tentarRegistrarAvaliacao(CLIENTE, CANAL, '4', 'wa-repetido');

    expect(r).toEqual({ capturada: true, reentrega: true });
    // Não regrava nota nem duplica a mensagem no histórico.
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it('deixa passar um "5" espontâneo quando a mensagem é nova', async () => {
    // Contraprova do teste acima: sem pendência E sem registro anterior, o
    // dígito é assunto novo do cliente e precisa virar conversa.
    pendente = null;
    mensagemExistente = null;

    const r = await tentarRegistrarAvaliacao(CLIENTE, CANAL, '5', 'wa-novo');

    expect(r.capturada).toBe(false);
  });

  it('não agradece duas vezes quando duas entregas disputam a mesma nota', async () => {
    // Regressão da auditoria: `.is('nota_satisfacao', null)` filtra no banco,
    // mas sem `.select()` o supabase-js devolve `{data:null,error:null}` tanto
    // para "gravei" quanto para "a guarda barrou". Sem distinguir, as duas
    // entregas simultâneas mandariam "Obrigado pela sua avaliação!".
    comPendencia();
    linhasAtualizadas = []; // perdi a corrida

    const r = await tentarRegistrarAvaliacao(CLIENTE, CANAL, '3', 'wa-corrida');

    expect(r).toMatchObject({ capturada: true, reentrega: true });
    // Consome a mensagem (não vira conversa) mas não duplica o histórico.
    expect(inserts).toHaveLength(0);
  });

  it('devolve ao fluxo normal se a busca no banco falhar', async () => {
    erroBusca = { message: 'timeout' };

    const r = await tentarRegistrarAvaliacao(CLIENTE, CANAL, '5');

    expect(r.capturada).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('nunca relança — falha inesperada vira capturada=false', async () => {
    comPendencia();
    fromMock.mockImplementationOnce(() => {
      throw new Error('explosao inesperada');
    });

    await expect(tentarRegistrarAvaliacao(CLIENTE, CANAL, '2')).resolves.toEqual({ capturada: false });
  });
});
