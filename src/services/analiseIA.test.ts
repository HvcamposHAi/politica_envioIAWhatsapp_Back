// Teste pontual: analisarConversa, interpretarAnalise, resolverMotivoPerdaId e
// agendarAnaliseDebounced (PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md, fase 1).
// Mocka Anthropic e supabaseAdmin — não toca rede nem banco real. Mesmo
// harness de resumoIA.test.ts, inclusive a ausência deliberada de
// GCP_PROJECT_ID (obterCliente cai no modo dev e lê ANTHROPIC_API_KEY).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

delete process.env.GCP_PROJECT_ID;
process.env.ANTHROPIC_API_KEY = 'chave-de-teste';

const messagesCreateMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    messages = { create: messagesCreateMock };
  },
}));

let updates: { tabela: string; campos: Record<string, unknown> }[] = [];
let dadosPorTabela: Record<string, { data: unknown; error: { message: string } | null }> = {};
/** Respostas em ORDEM para tabelas consultadas mais de uma vez na mesma
 *  análise. `atendentes` é o caso: a primeira leitura é o dono da conversa (vai
 *  para o prompt), a segunda é o supervisor do setor (vai para a orientação de
 *  escalonamento). Sem isso os dois teriam o mesmo nome e o teste não provaria
 *  nada. Esvaziada a fila, cai no fixture de `dadosPorTabela`. */
let filaPorTabela: Record<string, { data: unknown; error: { message: string } | null }[]> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function encadear(resultado: unknown): any {
  const builder = {
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve(resultado),
    maybeSingle: () => Promise.resolve(resultado),
    then: (resolve: (v: unknown) => void) => resolve(resultado),
  };
  return builder;
}

const fromMock = vi.fn((tabela: string) => ({
  select: () => {
    const fila = filaPorTabela[tabela];
    if (fila?.length) return encadear(fila.shift()!);
    return encadear(dadosPorTabela[tabela] ?? { data: null, error: null });
  },
  update: (campos: Record<string, unknown>) => {
    updates.push({ tabela, campos });
    return encadear({ data: null, error: null });
  },
}));

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: { from: fromMock },
}));

const {
  analisarConversa,
  agendarAnaliseDebounced,
  interpretarAnalise,
  orientacaoEscalonamento,
  resolverMotivoPerdaId,
} = await import('./analiseIA.js');

const CONVERSA_ID = 'conversa-1';
const MOTIVO_PRECO_ID = 'motivo-preco';

function respostaComTexto(texto: string, stopReason = 'end_turn') {
  return { content: [{ type: 'text', text: texto }], stop_reason: stopReason };
}

/** Cenário padrão: conversa de uma empresa com dois motivos de perda ativos e
 *  três mensagens trocadas. Cada teste sobrescreve só o que precisa. */
function prepararCenarioPadrao() {
  dadosPorTabela = {
    conversas: {
      data: {
        id: CONVERSA_ID,
        fechada_em: null,
        setor_id: 'setor-1',
        cliente_id: 'cliente-1',
        atendente_id: 'atend-1',
        canais: { empresa_id: 'empresa-1' },
      },
      error: null,
    },
    // Identificação para o cabeçalho do prompt — consultas por id, sem embed
    // (ver o comentário do select em analiseIA.ts: embed quebrou em produção
    // quando uma segunda FK para atendentes apareceu no schema).
    clientes: { data: { nome: 'Sheila', telefone: '554198638874' }, error: null },
    setores: { data: { nome: 'Compras' }, error: null },
    supervisao: { data: [{ supervisor_id: 'supervisor-1' }], error: null },
    mensagens: {
      data: [
        { autor: 'cliente', texto: 'Terceira vez que cobro esse pedido', midia_tipo: null, enviada_em: '2026-08-08T10:02:00Z' },
        { autor: 'atendente', texto: 'Vou verificar', midia_tipo: null, enviada_em: '2026-08-08T10:01:00Z' },
        { autor: 'cliente', texto: 'Bom dia, cadê meu pedido?', midia_tipo: null, enviada_em: '2026-08-08T10:00:00Z' },
      ],
      error: null,
    },
    motivos_perda: {
      data: [
        { id: MOTIVO_PRECO_ID, nome: 'Preço alto' },
        { id: 'motivo-prazo', nome: 'Prazo de entrega' },
      ],
      error: null,
    },
  };
}

/** O update de sucesso é o único que carrega `sentimento`; o de erro carrega
 *  só `analise_ia_erro`. Separar por isso mantém as asserções legíveis. */
function ultimoUpdate() {
  return updates.at(-1)?.campos ?? {};
}

beforeEach(() => {
  updates = [];
  messagesCreateMock.mockReset();
  fromMock.mockClear();
  prepararCenarioPadrao();
  // 1ª leitura de atendentes = dono da conversa; 2ª = supervisor do setor.
  filaPorTabela = {
    atendentes: [
      { data: { nome: 'Humberto Camargo' }, error: null },
      { data: { nome: 'Marcelo' }, error: null },
    ],
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('interpretarAnalise', () => {
  it('lê o JSON limpo', () => {
    const analise = interpretarAnalise(
      '{"sentimento":"negativo","risco":"alto","risco_motivo":"cliente cobrou 3x","motivo_perda_provavel":"Preço alto"}',
    );
    expect(analise).toEqual({
      sentimento: 'negativo',
      risco: 'alto',
      riscoMotivo: 'cliente cobrou 3x',
      motivoPerdaProvavel: 'Preço alto',
      sugestoes: null,
      orientacoes: null,
    });
  });

  it('sobrevive a cerca de código e preâmbulo do modelo', () => {
    const analise = interpretarAnalise(
      'Claro! Segue a análise:\n```json\n{"sentimento":"positivo","risco":"baixo","risco_motivo":null,"motivo_perda_provavel":null}\n```',
    );
    expect(analise?.sentimento).toBe('positivo');
    expect(analise?.risco).toBe('baixo');
  });

  it('cai no default seguro quando o modelo inventa valor fora do domínio', () => {
    // Sem isso, o valor inválido iria para o update e o constraint
    // conversas_risco_valido rejeitaria a linha INTEIRA, levando junto um
    // sentimento que estava correto.
    const analise = interpretarAnalise('{"sentimento":"furioso","risco":"altíssimo"}');
    expect(analise?.sentimento).toBe('neutro');
    expect(analise?.risco).toBe('baixo');
  });

  it('descarta motivo de risco quando o risco é baixo', () => {
    const analise = interpretarAnalise(
      '{"sentimento":"neutro","risco":"baixo","risco_motivo":"nada demais","motivo_perda_provavel":null}',
    );
    expect(analise?.riscoMotivo).toBeNull();
  });

  it('trata a string "null" e o vazio como ausência de valor', () => {
    const analise = interpretarAnalise(
      '{"sentimento":"neutro","risco":"medio","risco_motivo":"null","motivo_perda_provavel":"  "}',
    );
    expect(analise?.riscoMotivo).toBeNull();
    expect(analise?.motivoPerdaProvavel).toBeNull();
  });

  it('devolve null quando não há JSON algum', () => {
    expect(interpretarAnalise('Desculpe, não posso analisar isso.')).toBeNull();
    expect(interpretarAnalise('{quebrado')).toBeNull();
  });
});

describe('interpretarAnalise — coach (fase 4)', () => {
  it('lê sugestões e orientações na ordem', () => {
    const analise = interpretarAnalise(
      JSON.stringify({
        sentimento: 'negativo',
        risco: 'alto',
        risco_motivo: 'cliente quer falar com o dono',
        motivo_perda_provavel: null,
        sugestoes_resposta: ['Sheila, me conte o que houve', 'Vou levar seu caso ao responsável', 'Posso te ligar agora?'],
        orientacoes: ['Reconheça a demora antes de explicar', 'Não negue o pedido de falar com o dono'],
      }),
    );
    expect(analise?.sugestoes).toEqual([
      'Sheila, me conte o que houve',
      'Vou levar seu caso ao responsável',
      'Posso te ligar agora?',
    ]);
    expect(analise?.orientacoes).toHaveLength(2);
  });

  it('descarta o coach quando o risco é baixo', () => {
    // Sugestão de resposta em conversa tranquila é ruído — e ruído treina o
    // atendente a ignorar a faixa justamente quando ela importa.
    const analise = interpretarAnalise(
      JSON.stringify({
        sentimento: 'positivo',
        risco: 'baixo',
        sugestoes_resposta: ['oi', 'olá', 'bom dia'],
        orientacoes: ['seja simpático'],
      }),
    );
    expect(analise?.sugestoes).toBeNull();
    expect(analise?.orientacoes).toBeNull();
  });

  it('devolve null para lista que não é array, SEM afetar sentimento e risco', () => {
    // A degradação é por campo. Uma chave de coach quebrada não pode derrubar
    // o que sustenta o Painel e o banner, que já estão em produção.
    for (const valor of ['uma string', 42, { a: 1 }, null]) {
      const analise = interpretarAnalise(
        JSON.stringify({ sentimento: 'negativo', risco: 'alto', sugestoes_resposta: valor }),
      );
      expect(analise?.sugestoes).toBeNull();
      expect(analise?.sentimento).toBe('negativo');
      expect(analise?.risco).toBe('alto');
    }
  });

  it('sane a lista: descarta vazio e "null", apara o texto e corta em 3 itens', () => {
    const longa = 'x'.repeat(900);
    const analise = interpretarAnalise(
      JSON.stringify({
        sentimento: 'negativo',
        risco: 'medio',
        sugestoes_resposta: ['   ', 'null', longa, 42, 'ok 1', 'ok 2', 'ok 3', 'ok 4'],
      }),
    );
    expect(analise?.sugestoes).toEqual([longa.slice(0, 300), 'ok 1', 'ok 2']);
    expect(analise?.sugestoes?.every((s) => s.length <= 300)).toBe(true);
  });

  it('devolve null quando a lista fica vazia depois do saneamento', () => {
    const analise = interpretarAnalise(
      JSON.stringify({ sentimento: 'negativo', risco: 'alto', orientacoes: ['', '  ', 'null'] }),
    );
    expect(analise?.orientacoes).toBeNull();
  });

  it('REGRESSÃO FASE 1: resposta no formato antigo continua válida', () => {
    // O produtor de sentimento (Painel) e de risco (banner + alertas) já está
    // em produção. Um JSON sem as chaves novas — que é o que um modelo devolve
    // se o prompt não pegar — não pode virar erro nem perder campo.
    const analise = interpretarAnalise(
      '{"sentimento":"negativo","risco":"medio","risco_motivo":"insatisfação contida","motivo_perda_provavel":"Preço alto"}',
    );
    expect(analise).toEqual({
      sentimento: 'negativo',
      risco: 'medio',
      riscoMotivo: 'insatisfação contida',
      motivoPerdaProvavel: 'Preço alto',
      sugestoes: null,
      orientacoes: null,
    });
  });
});

describe('orientacaoEscalonamento', () => {
  it('cita o supervisor e o setor quando há supervisor cadastrado', () => {
    const frase = orientacaoEscalonamento('Marcelo', 'Compras');
    expect(frase).toContain('Marcelo');
    expect(frase).toContain('supervisor de Compras');
  });

  it('cai no texto genérico sem supervisor, sem vazar null no texto', () => {
    const frase = orientacaoEscalonamento(null, 'Compras');
    expect(frase).toContain('seu supervisor');
    expect(frase).not.toContain('null');
    expect(frase).not.toContain('undefined');
  });

  it('omite o setor quando ele é desconhecido', () => {
    const frase = orientacaoEscalonamento('Marcelo', null);
    expect(frase).toContain('Marcelo');
    expect(frase).not.toContain('supervisor de');
  });
});

describe('resolverMotivoPerdaId', () => {
  const motivos = [
    { id: MOTIVO_PRECO_ID, nome: 'Preço alto' },
    { id: 'motivo-prazo', nome: 'Prazo de entrega' },
  ];

  it('casa ignorando acento, caixa e espaço extra', () => {
    expect(resolverMotivoPerdaId('preco  ALTO', motivos)).toBe(MOTIVO_PRECO_ID);
  });

  it('devolve null quando o modelo inventa um motivo fora da lista', () => {
    expect(resolverMotivoPerdaId('Cliente sumiu', motivos)).toBeNull();
  });

  it('devolve null para entrada nula', () => {
    expect(resolverMotivoPerdaId(null, motivos)).toBeNull();
  });
});

describe('analisarConversa', () => {
  it('grava sentimento, risco e motivo sugerido no caminho feliz', async () => {
    messagesCreateMock.mockResolvedValue(
      respostaComTexto(
        '{"sentimento":"negativo","risco":"alto","risco_motivo":"cliente cobrou o mesmo pedido tres vezes","motivo_perda_provavel":"Prazo de entrega"}',
      ),
    );

    await analisarConversa(CONVERSA_ID);

    const campos = ultimoUpdate();
    expect(campos.sentimento).toBe('negativo');
    expect(campos.risco).toBe('alto');
    expect(campos.risco_motivo).toBe('cliente cobrou o mesmo pedido tres vezes');
    expect(campos.motivo_perda_sugerido_id).toBe('motivo-prazo');
    expect(campos.analise_ia_modelo).toBe('claude-opus-5');
    expect(campos.analise_ia_erro).toBeNull();
  });

  it('não sugere motivo quando o nome devolvido não existe na empresa', async () => {
    messagesCreateMock.mockResolvedValue(
      respostaComTexto('{"sentimento":"neutro","risco":"baixo","risco_motivo":null,"motivo_perda_provavel":"Cliente sumiu"}'),
    );

    await analisarConversa(CONVERSA_ID);

    expect(ultimoUpdate().motivo_perda_sugerido_id).toBeNull();
  });

  it('grava analise_ia_erro e não relança quando a Anthropic falha', async () => {
    messagesCreateMock.mockRejectedValue(new Error('503 upstream'));

    await expect(analisarConversa(CONVERSA_ID)).resolves.toBeUndefined();

    const campos = ultimoUpdate();
    expect(campos.analise_ia_erro).toBe('503 upstream');
    expect(campos.sentimento).toBeUndefined();
  });

  it('traduz o 401 da Anthropic em instrução acionável', async () => {
    messagesCreateMock.mockRejectedValue(Object.assign(new Error('401 unauthorized'), { status: 401 }));

    await analisarConversa(CONVERSA_ID);

    expect(String(ultimoUpdate().analise_ia_erro)).toContain('Configurações → Integrações');
  });

  it('trata recusa dos classificadores sem quebrar ao ler content vazio', async () => {
    messagesCreateMock.mockResolvedValue({ content: [], stop_reason: 'refusal' });

    await expect(analisarConversa(CONVERSA_ID)).resolves.toBeUndefined();

    expect(String(ultimoUpdate().analise_ia_erro)).toContain('recusada');
  });

  it('grava o coach e anexa a orientação de escalonamento com o nome do supervisor', async () => {
    messagesCreateMock.mockResolvedValue(
      respostaComTexto(
        JSON.stringify({
          sentimento: 'negativo',
          risco: 'alto',
          risco_motivo: 'cliente exigiu falar com o dono',
          motivo_perda_provavel: null,
          sugestoes_resposta: ['Sheila, me conte o que houve', 'Vou levar ao responsável', 'Posso ligar agora?'],
          orientacoes: ['Reconheça a demora antes de explicar'],
        }),
      ),
    );

    await analisarConversa(CONVERSA_ID);

    const campos = ultimoUpdate();
    expect(campos.coach_sugestoes).toHaveLength(3);
    expect(campos.coach_atualizado_em).toBeTruthy();
    // A última orientação é montada em código, nunca pedida ao modelo.
    const orientacoes = campos.coach_orientacoes as string[];
    expect(orientacoes[0]).toBe('Reconheça a demora antes de explicar');
    expect(orientacoes.at(-1)).toContain('Marcelo');
  });

  it('manda o nome do cliente e do atendente no prompt', async () => {
    messagesCreateMock.mockResolvedValue(
      respostaComTexto('{"sentimento":"neutro","risco":"baixo","risco_motivo":null,"motivo_perda_provavel":null}'),
    );

    await analisarConversa(CONVERSA_ID);

    const prompt = messagesCreateMock.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('Nome do cliente: Sheila');
    expect(prompt).toContain('Setor que atende: Compras');
    // Primeiro nome: é como o atendente assina no WhatsApp.
    expect(prompt).toContain('Nome do atendente: Humberto');
  });

  it('não manda nome de cliente quando o contato não foi identificado', async () => {
    // Contato sem nome é gravado com nome = telefone; tratar o cliente por
    // "554198638874" é pior do que não ter nome nenhum.
    dadosPorTabela.clientes = { data: { nome: '554198638874', telefone: '554198638874' }, error: null };
    messagesCreateMock.mockResolvedValue(
      respostaComTexto('{"sentimento":"neutro","risco":"baixo","risco_motivo":null,"motivo_perda_provavel":null}'),
    );

    await analisarConversa(CONVERSA_ID);

    expect(messagesCreateMock.mock.calls[0][0].messages[0].content).not.toContain('Nome do cliente');
  });

  it('REGRESSÃO 08/08: falha ao ler os nomes não derruba sentimento e risco', async () => {
    // O incidente: os nomes vinham como embed no select crítico da conversa. A
    // migration da nota de atendimento criou uma SEGUNDA FK de hub.conversas
    // para hub.atendentes, o PostgREST recusou o embed por ambiguidade, e como
    // esse select é a primeira coisa que a função faz, a análise parou de
    // gravar sentimento e risco em TODAS as conversas — em silêncio, porque o
    // serviço é fire-and-forget. Agora os nomes são consultas separadas e
    // opcionais: o pior caso é um prompt sem nome.
    dadosPorTabela.clientes = { data: null, error: { message: 'embed ambíguo' } };
    dadosPorTabela.setores = { data: null, error: { message: 'embed ambíguo' } };
    filaPorTabela = { atendentes: [{ data: null, error: { message: 'embed ambíguo' } }] };
    messagesCreateMock.mockResolvedValue(
      respostaComTexto('{"sentimento":"negativo","risco":"alto","risco_motivo":"cliente irritado"}'),
    );

    await analisarConversa(CONVERSA_ID);

    const campos = ultimoUpdate();
    expect(campos.sentimento).toBe('negativo');
    expect(campos.risco).toBe('alto');
    expect(campos.analise_ia_erro).toBeNull();
    // O prompt saiu sem identificação, mas saiu.
    expect(messagesCreateMock.mock.calls[0][0].messages[0].content).not.toContain('Nome do cliente');
  });

  it('zera as TRÊS colunas do coach juntas quando o risco é baixo', async () => {
    messagesCreateMock.mockResolvedValue(
      respostaComTexto('{"sentimento":"positivo","risco":"baixo","risco_motivo":null,"motivo_perda_provavel":null}'),
    );

    await analisarConversa(CONVERSA_ID);

    const campos = ultimoUpdate();
    expect(campos.coach_sugestoes).toBeNull();
    expect(campos.coach_orientacoes).toBeNull();
    expect(campos.coach_atualizado_em).toBeNull();
  });

  it('não grava coach em conversa fechada no meio do debounce', async () => {
    // Mesma regra do risco: coach é sobre o que ainda dá para evitar. Deixá-lo
    // gravado seria resíduo — e é o que a reconciliação R6 procura.
    (dadosPorTabela.conversas.data as Record<string, unknown>).fechada_em = '2026-08-08T12:00:00Z';
    messagesCreateMock.mockResolvedValue(
      respostaComTexto(
        JSON.stringify({
          sentimento: 'negativo',
          risco: 'alto',
          sugestoes_resposta: ['a', 'b', 'c'],
          orientacoes: ['x'],
        }),
      ),
    );

    await analisarConversa(CONVERSA_ID);

    const campos = ultimoUpdate();
    expect(campos.risco).toBeNull();
    expect(campos.coach_sugestoes).toBeNull();
    expect(campos.coach_orientacoes).toBeNull();
    expect(campos.coach_atualizado_em).toBeNull();
    // Sentimento continua valendo: alimenta a matriz histórica do Painel.
    expect(campos.sentimento).toBe('negativo');
  });

  it('não grava timestamp de coach quando o modelo não devolveu sugestão', async () => {
    // Invariante: as três se movem juntas. Timestamp sem lista é um estado que
    // a UI teria de adivinhar como exibir (reconciliação R7).
    messagesCreateMock.mockResolvedValue(
      respostaComTexto('{"sentimento":"negativo","risco":"alto","risco_motivo":"cliente irritado"}'),
    );

    await analisarConversa(CONVERSA_ID);

    const campos = ultimoUpdate();
    expect(campos.risco).toBe('alto');
    expect(campos.coach_sugestoes).toBeNull();
    expect(campos.coach_atualizado_em).toBeNull();
    expect(campos.coach_orientacoes).toBeNull();
  });

  it('não chama a Anthropic quando a conversa não tem mensagens', async () => {
    dadosPorTabela.mensagens = { data: [], error: null };

    await analisarConversa(CONVERSA_ID);

    expect(messagesCreateMock).not.toHaveBeenCalled();
    // Sai em silêncio: sem update, para não poluir a métrica de erros com
    // conversas que simplesmente ainda não têm o que analisar.
    expect(updates).toHaveLength(0);
  });
});

describe('agendarAnaliseDebounced', () => {
  it('colapsa uma rajada de mensagens numa única chamada', async () => {
    vi.useFakeTimers();
    messagesCreateMock.mockResolvedValue(
      respostaComTexto('{"sentimento":"neutro","risco":"baixo","risco_motivo":null,"motivo_perda_provavel":null}'),
    );

    agendarAnaliseDebounced(CONVERSA_ID);
    await vi.advanceTimersByTimeAsync(3_000);
    agendarAnaliseDebounced(CONVERSA_ID);
    await vi.advanceTimersByTimeAsync(3_000);
    agendarAnaliseDebounced(CONVERSA_ID);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });
});
