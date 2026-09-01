// O validador anti-invenção é a razão de este módulo existir. Prompt é
// pedido; validador é regra — e é o validador que impede uma promessa de
// campanha inventada por um modelo de sair no nome da candidata.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const criarMock = vi.fn();
vi.mock('./resumoIA.js', () => ({
  obterCliente: async () => ({ messages: { create: criarMock } }),
}));

const { validarVariacao, gerarLote, emLotes, TAMANHO_DO_LOTE } = await import('./personalizacaoIA.js');

const BASE =
  'Oi, aqui é a Indiara. Estou passando nos bairros para ouvir o que mais incomoda no dia a dia. ' +
  'Se quiser me contar, é só responder. Se preferir não receber mais, responda SAIR.';

describe('validarVariacao — o que precisa ser DESCARTADO', () => {
  it('promessa que não estava no texto-base', () => {
    const r = validarVariacao(BASE, `${BASE} Vou construir uma creche no seu bairro.`);
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/promessa|longa/);
  });

  it('número inventado', () => {
    const r = validarVariacao(
      BASE,
      'Oi, aqui é a Indiara. Já visitei 47 bairros ouvindo moradores. Responda SAIR para não receber mais.',
    );
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('47');
  });

  it('data inventada', () => {
    const r = validarVariacao(
      BASE,
      'Oi, aqui é a Indiara. Vamos nos encontrar dia 15 de outubro no seu bairro. Responda SAIR para sair.',
    );
    // Rejeitada — neste caso pela regra de dígito, que pega o "15" antes de a
    // regra de data ser consultada. Qual das três guardas dispara primeiro é
    // detalhe; o que o teste garante é que a variação NÃO passa.
    expect(r.ok).toBe(false);
  });

  it('data inventada mesmo quando o número já existia no texto-base', () => {
    // Aqui a regra de dígito não pega: "15" já está no original. É o caso
    // que justifica a regra de data existir separada.
    const base = 'Oi, sou a Indiara. Já são 15 anos morando aqui. Responda SAIR para não receber mais.';
    const r = validarVariacao(
      base,
      'Oi! Sou a Indiara, 15 anos morando aqui. Nos vemos 15 de outubro. Responda SAIR para sair.',
    );
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('data');
  });

  it('link inventado', () => {
    const r = validarVariacao(
      BASE,
      'Oi, aqui é a Indiara. Estou passando nos bairros para ouvir o que incomoda. Veja em www.exemplo.com. Responda SAIR.',
    );
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('link');
  });

  it('variação muito mais longa que o original', () => {
    const r = validarVariacao(BASE, BASE + ' ' + BASE + ' ' + BASE);
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('longa');
  });

  it('variação que cortou quase tudo', () => {
    expect(validarVariacao(BASE, 'Oi!').ok).toBe(false);
  });

  it('variação vazia', () => {
    expect(validarVariacao(BASE, '').ok).toBe(false);
    expect(validarVariacao(BASE, '   ').ok).toBe(false);
  });
});

describe('validarVariacao — o que precisa PASSAR', () => {
  it('reordenar e trocar o tratamento', () => {
    const r = validarVariacao(
      BASE,
      'Oi! Sou a Indiara. Quero ouvir o que mais incomoda no seu dia a dia — estou passando nos bairros. ' +
        'Pode me contar respondendo aqui. Se não quiser receber mais, responda SAIR.',
    );
    expect(r.ok).toBe(true);
  });

  it('citar o bairro passado como campo permitido', () => {
    // O bairro não está no texto-base literal; é um campo substituído, e
    // não pode contar como invenção.
    const r = validarVariacao(
      BASE,
      'Oi Maria! Sou a Indiara. Estou passando no Centro para ouvir o que mais incomoda. Responda SAIR para sair.',
      ['Maria', 'Centro'],
    );
    expect(r.ok).toBe(true);
  });

  it('manter um número que JÁ estava no original', () => {
    const base = 'Oi, sou a Indiara, número 45500 na urna. Responda SAIR para não receber mais.';
    const r = validarVariacao(base, 'Oi! Aqui é a Indiara — 45500 na urna. Responda SAIR para sair.');
    expect(r.ok).toBe(true);
  });

  it('manter uma promessa que JÁ estava no original', () => {
    const base = 'Oi, sou a Indiara. Vou trabalhar pela creche do bairro. Responda SAIR para não receber mais.';
    const r = validarVariacao(base, 'Oi! Aqui é a Indiara. Vou trabalhar pela creche daqui. Responda SAIR.');
    expect(r.ok).toBe(true);
  });
});

describe('emLotes', () => {
  it('divide no tamanho configurado', () => {
    const itens = Array.from({ length: 45 }, (_, i) => i);
    const lotes = emLotes(itens);
    expect(lotes).toHaveLength(Math.ceil(45 / TAMANHO_DO_LOTE));
    expect(lotes.flat()).toHaveLength(45);
  });

  it('lista vazia vira zero lotes', () => {
    expect(emLotes([])).toEqual([]);
  });
});

const ELEITORES = [
  { alvoId: 'a1', nome: 'Maria Silva', primeiroNome: 'Maria', bairro: 'Centro', cidade: 'Timbó' },
  { alvoId: 'a2', nome: 'João Souza', primeiroNome: 'João', bairro: 'Vila Nova', cidade: 'Timbó' },
];

function respostaComTextos(textos: Record<string, string>) {
  return {
    stop_reason: 'end_turn',
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          variacoes: Object.entries(textos).map(([id, texto]) => ({ id, texto })),
        }),
      },
    ],
  };
}

describe('gerarLote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('devolve a variação quando ela passa no validador', async () => {
    criarMock.mockResolvedValue(
      respostaComTextos({
        a1: 'Oi Maria! Sou a Indiara e estou passando no Centro para ouvir o que incomoda. Responda SAIR para sair.',
        a2: 'Oi João! Sou a Indiara, passando na Vila Nova para ouvir o que incomoda. Responda SAIR para sair.',
      }),
    );
    const r = await gerarLote(BASE, ELEITORES);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.personalizada)).toBe(true);
  });

  it('DESCARTA a variação que inventa e usa o texto-base no lugar', async () => {
    criarMock.mockResolvedValue(
      respostaComTextos({
        a1: 'Oi Maria! Sou a Indiara. Vou construir 3 creches no Centro. Responda SAIR para sair.',
        a2: 'Oi João! Sou a Indiara, passando na Vila Nova para ouvir o que incomoda. Responda SAIR para sair.',
      }),
    );
    const r = await gerarLote(BASE, ELEITORES);
    const maria = r.find((x) => x.alvoId === 'a1')!;
    expect(maria.personalizada).toBe(false);
    expect(maria.motivoDescarte).toBeTruthy();
    // Cai para o texto-base com os campos substituídos — não fica sem texto.
    expect(maria.texto).toContain('Indiara');

    expect(r.find((x) => x.alvoId === 'a2')!.personalizada).toBe(true);
  });

  it('modelo fora do ar não impede a campanha — cai para o texto-base', async () => {
    // Uma campanha que não sai porque o modelo caiu é pior que uma
    // campanha com mensagem menos personalizada. O texto-base é, ele
    // mesmo, uma mensagem aprovada.
    criarMock.mockRejectedValue(new Error('502 upstream'));
    const r = await gerarLote(BASE, ELEITORES);
    expect(r).toHaveLength(2);
    expect(r.every((x) => !x.personalizada)).toBe(true);
    expect(r[0].motivoDescarte).toContain('502');
    expect(r[0].texto.length).toBeGreaterThan(20);
  });

  it('JSON quebrado cai para o texto-base', async () => {
    criarMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'não sou json' }],
    });
    const r = await gerarLote(BASE, ELEITORES);
    expect(r.every((x) => !x.personalizada)).toBe(true);
    expect(r[0].motivoDescarte).toContain('JSON');
  });

  it('resposta truncada cai para o texto-base', async () => {
    criarMock.mockResolvedValue({ stop_reason: 'max_tokens', content: [] });
    const r = await gerarLote(BASE, ELEITORES);
    expect(r[0].motivoDescarte).toContain('truncada');
  });

  it('recusa do modelo cai para o texto-base', async () => {
    criarMock.mockResolvedValue({ stop_reason: 'refusal', content: [] });
    const r = await gerarLote(BASE, ELEITORES);
    expect(r[0].motivoDescarte).toContain('recusou');
  });

  it('id ausente na resposta cai para o texto-base só naquele eleitor', async () => {
    criarMock.mockResolvedValue(
      respostaComTextos({
        a1: 'Oi Maria! Sou a Indiara, passando no Centro para ouvir o que incomoda. Responda SAIR para sair.',
      }),
    );
    const r = await gerarLote(BASE, ELEITORES);
    expect(r.find((x) => x.alvoId === 'a1')!.personalizada).toBe(true);
    expect(r.find((x) => x.alvoId === 'a2')!.personalizada).toBe(false);
  });

  it('tolera cerca de código na resposta', async () => {
    const conteudo = JSON.stringify({
      variacoes: [
        {
          id: 'a1',
          texto:
            'Oi Maria! Sou a Indiara e estou passando no Centro para ouvir o que incomoda. Responda SAIR para sair.',
        },
      ],
    });
    criarMock.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '```json\n' + conteudo + '\n```' }],
    });
    const r = await gerarLote(BASE, [ELEITORES[0]]);
    expect(r[0].personalizada).toBe(true);
  });

  it('lista vazia não chama o modelo', async () => {
    const r = await gerarLote(BASE, []);
    expect(r).toEqual([]);
    expect(criarMock).not.toHaveBeenCalled();
  });
});
