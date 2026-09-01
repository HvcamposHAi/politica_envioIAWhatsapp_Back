// Teste pontual: gerarResumoConversa e agendarResumoDebounced (plano
// "Resumo de IA no Kanban de Chamados"). Mocka Anthropic e supabaseAdmin —
// não toca rede nem banco real. GCP_PROJECT_ID fica ausente de propósito
// (mesmo padrão de webhooks/twilio.test.ts): cai no modo dev/env var de
// obterCliente(), sem precisar mockar o Secret Manager aqui.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

delete process.env.GCP_PROJECT_ID;
process.env.ANTHROPIC_API_KEY = 'chave-de-teste';

const messagesCreateMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    messages = { create: messagesCreateMock };
  },
}));

// Harness mínimo para o builder fluente do supabase-js: cada tabela devolve
// um resultado fixo pra select (encadeado com .eq/.order/.limit/.single) e
// registra toda chamada de update em `updates`, na ordem em que ocorreram —
// suficiente para as asserções deste arquivo, sem reimplementar o
// PostgrestFilterBuilder inteiro.
let updates: { tabela: string; campos: Record<string, unknown> }[] = [];
let dadosPorTabela: Record<string, { data: unknown; error: { message: string } | null }> = {};

// `any`: builder mock deliberadamente solto, não uma implementação real de
// PromiseLike — o formato exato do supabase-js não importa aqui, só que
// `await` funcione via `.then` (thenable) e a cadeia devolva a si mesma.
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
  select: () => encadear(dadosPorTabela[tabela] ?? { data: null, error: null }),
  update: (campos: Record<string, unknown>) => {
    updates.push({ tabela, campos });
    return encadear({ data: null, error: null });
  },
}));

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: { from: fromMock },
}));

const { gerarResumoConversa, agendarResumoDebounced, extrairTituloEResumo } = await import('./resumoIA.js');

const CONVERSA_ID = 'conversa-1';

function mensagens() {
  return [
    { autor: 'cliente', texto: 'Oi, o pedido 123 não chegou', midia_tipo: null, enviada_em: '2026-08-07T10:00:00Z' },
    { autor: 'atendente', texto: 'Vou verificar com a transportadora', midia_tipo: null, enviada_em: '2026-08-07T10:05:00Z' },
  ];
}

beforeEach(() => {
  updates = [];
  fromMock.mockClear();
  messagesCreateMock.mockReset();
  dadosPorTabela = {
    conversas: { data: { cliente_id: 'cliente-1' }, error: null },
    clientes: { data: { nome: 'Maria', cidade: 'Curitiba' }, error: null },
    // mensagens.select() não usa .single(), resolve via .then — a lista já
    // vem em ordem desc (mais recente primeiro), como o select real pede.
    mensagens: { data: [...mensagens()].reverse(), error: null },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('gerarResumoConversa', () => {
  it('caminho feliz: grava resumo, status pronto e metadados', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'Cliente com atraso no pedido 123; atendente investigando.' }] });

    await gerarResumoConversa(CONVERSA_ID);

    const camposUpdates = updates.filter((u) => u.tabela === 'conversas').map((u) => u.campos);
    expect(camposUpdates[0]).toEqual({ resumo_ia_status: 'processando' });

    const final = camposUpdates[camposUpdates.length - 1];
    expect(final.resumo_ia).toBe('Cliente com atraso no pedido 123; atendente investigando.');
    expect(final.resumo_ia_status).toBe('pronto');
    expect(final.resumo_ia_modelo).toBe('claude-sonnet-5');
    expect(final.resumo_ia_mensagens_count).toBe(2);
    expect(final.resumo_ia_erro).toBeNull();
    expect(typeof final.resumo_ia_gerado_em).toBe('string');

    // Prompt precisa levar o histórico em ordem cronológica (mais antiga
    // primeiro), não a ordem desc que veio do select.
    const prompt = messagesCreateMock.mock.calls[0][0].messages[0].content as string;
    expect(prompt.indexOf('não chegou')).toBeLessThan(prompt.indexOf('transportadora'));
  });

  it('erro isolado: Anthropic falha -> status erro, nunca relança', async () => {
    messagesCreateMock.mockRejectedValue(new Error('timeout da API'));

    await expect(gerarResumoConversa(CONVERSA_ID)).resolves.toBeUndefined();

    const camposUpdates = updates.filter((u) => u.tabela === 'conversas').map((u) => u.campos);
    const final = camposUpdates[camposUpdates.length - 1];
    expect(final.resumo_ia_status).toBe('erro');
    expect(final.resumo_ia_erro).toBe('timeout da API');
    // Título de um ciclo anterior tem que sobreviver a uma falha: o caminho de
    // erro não pode encostar em titulo_ia (nem para zerar).
    expect(final).not.toHaveProperty('titulo_ia');
    expect(final).not.toHaveProperty('titulo_ia_gerado_em');
  });

  /* Auditoria 2026-08-09, item 5. O teto era 350 tokens num modelo que liga
   * thinking por padrão e cobra thinking + texto do MESMO orçamento — truncar
   * era o caso comum, e o texto cortado ia para o banco como 'pronto'. */

  it('resposta truncada (stop_reason max_tokens) vira ERRO, nunca resumo pela metade', async () => {
    messagesCreateMock.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: 'Cliente relatou que o pedido 123 não che' }],
    });

    await expect(gerarResumoConversa(CONVERSA_ID)).resolves.toBeUndefined();

    const camposUpdates = updates.filter((u) => u.tabela === 'conversas').map((u) => u.campos);
    const final = camposUpdates[camposUpdates.length - 1];
    expect(final.resumo_ia_status).toBe('erro');
    expect(String(final.resumo_ia_erro)).toContain('truncada');
    // O fragmento não pode ter sido gravado como resumo.
    expect(final).not.toHaveProperty('resumo_ia');
  });

  it('recusa dos classificadores (stop_reason refusal) vira ERRO em vez de quebrar em content[0]', async () => {
    messagesCreateMock.mockResolvedValue({ stop_reason: 'refusal', content: [] });

    await expect(gerarResumoConversa(CONVERSA_ID)).resolves.toBeUndefined();

    const camposUpdates = updates.filter((u) => u.tabela === 'conversas').map((u) => u.campos);
    const final = camposUpdates[camposUpdates.length - 1];
    expect(final.resumo_ia_status).toBe('erro');
    expect(String(final.resumo_ia_erro)).toContain('recusado');
  });

  it('stop_reason end_turn segue no caminho feliz (regressão)', async () => {
    messagesCreateMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Resumo completo do caso.' }],
    });

    await gerarResumoConversa(CONVERSA_ID);

    const camposUpdates = updates.filter((u) => u.tabela === 'conversas').map((u) => u.campos);
    const final = camposUpdates[camposUpdates.length - 1];
    expect(final.resumo_ia_status).toBe('pronto');
  });

  it('pede max_tokens folgado o bastante para thinking + título + resumo', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'Resumo.' }] });

    await gerarResumoConversa(CONVERSA_ID);

    expect(messagesCreateMock.mock.calls[0][0].max_tokens).toBe(4000);
  });
});

// PLANO_TITULO_IA_KANBAN.md §6.1 — o título vem na mesma resposta do resumo.
describe('extrairTituloEResumo', () => {
  it('separa a linha TÍTULO do corpo do resumo', () => {
    const { titulo, resumo } = extrairTituloEResumo(
      'TÍTULO: Dúvida sobre boleto vencido\n\nCliente pediu segunda via do boleto de julho.',
    );
    expect(titulo).toBe('Dúvida sobre boleto vencido');
    expect(resumo).toBe('Cliente pediu segunda via do boleto de julho.');
  });

  it.each([
    ['sem acento', 'Titulo: Cotação de adubo'],
    ['sem espaço', 'TÍTULO:Cotação de adubo'],
    ['markdown em volta', '**TÍTULO:** Cotação de adubo'],
    ['cabeçalho markdown', '## Título: Cotação de adubo'],
    ['linha em branco antes', '\n\nTÍTULO: Cotação de adubo'],
    ['ponto final sobrando', 'TÍTULO: Cotação de adubo.'],
  ])('tolera variação de formato: %s', (_caso, primeiraLinha) => {
    const { titulo, resumo } = extrairTituloEResumo(`${primeiraLinha}\n\nCliente quer preço de 20 sacas.`);
    expect(titulo).toBe('Cotação de adubo');
    expect(resumo).toBe('Cliente quer preço de 20 sacas.');
  });

  it('sem linha de título: devolve o texto integral como resumo, título null', () => {
    const texto = 'Cliente com atraso no pedido 123; atendente investigando.';
    expect(extrairTituloEResumo(texto)).toEqual({ titulo: null, resumo: texto });
  });

  it('só título e nenhum resumo: trata como parse falho (resumo nunca fica vazio)', () => {
    const texto = 'TÍTULO: Cotação de adubo';
    expect(extrairTituloEResumo(texto)).toEqual({ titulo: null, resumo: texto });
  });

  it('título gigante é truncado em 80 chars (constraint do banco nunca dispara)', () => {
    const { titulo } = extrairTituloEResumo(`TÍTULO: ${'x'.repeat(200)}\n\nResumo qualquer.`);
    expect(titulo).toHaveLength(80);
  });
});

describe('gerarResumoConversa + título', () => {
  it('resposta no formato esperado grava titulo_ia e resumo sem a linha do título', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: 'TÍTULO: Atraso na entrega do pedido 123\n\nCliente relatou que o pedido não chegou; atendente foi verificar com a transportadora.',
        },
      ],
    });

    await gerarResumoConversa(CONVERSA_ID);

    const camposUpdates = updates.filter((u) => u.tabela === 'conversas').map((u) => u.campos);
    const final = camposUpdates[camposUpdates.length - 1];
    expect(final.titulo_ia).toBe('Atraso na entrega do pedido 123');
    expect(final.resumo_ia).toBe(
      'Cliente relatou que o pedido não chegou; atendente foi verificar com a transportadora.',
    );
    expect(final.resumo_ia).not.toContain('TÍTULO');
    // Título e resumo saem do mesmo ciclo — os carimbos têm que bater.
    expect(final.titulo_ia_gerado_em).toBe(final.resumo_ia_gerado_em);
    expect(final.resumo_ia_status).toBe('pronto');
  });

  it('modelo ignora o formato: resumo normal e titulo_ia intocado', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'Cliente com atraso no pedido 123; atendente investigando.' }],
    });

    await gerarResumoConversa(CONVERSA_ID);

    const camposUpdates = updates.filter((u) => u.tabela === 'conversas').map((u) => u.campos);
    const final = camposUpdates[camposUpdates.length - 1];
    expect(final.resumo_ia).toBe('Cliente com atraso no pedido 123; atendente investigando.');
    expect(final.resumo_ia_status).toBe('pronto');
    expect(final).not.toHaveProperty('titulo_ia');
  });

  it('pede o título no prompt', async () => {
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'TÍTULO: X\n\nResumo.' }] });

    await gerarResumoConversa(CONVERSA_ID);

    const prompt = messagesCreateMock.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain('TÍTULO:');
    // As instruções originais do resumo continuam intactas (auditoria A5).
    expect(prompt).toContain('no máximo 4 frases curtas');
    expect(prompt).toContain('Nunca recuse nem peça mais mensagens');
  });
});

describe('agendarResumoDebounced', () => {
  it('rajada de 3 chamadas na mesma conversa gera só 1 chamada à Anthropic', async () => {
    vi.useFakeTimers();
    messagesCreateMock.mockResolvedValue({ content: [{ type: 'text', text: 'Resumo único.' }] });

    agendarResumoDebounced(CONVERSA_ID);
    await vi.advanceTimersByTimeAsync(4_000);
    agendarResumoDebounced(CONVERSA_ID);
    await vi.advanceTimersByTimeAsync(4_000);
    agendarResumoDebounced(CONVERSA_ID);

    // Ainda dentro da janela de 10s desde a última chamada: nenhuma geração disparou.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(messagesCreateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
  });
});
