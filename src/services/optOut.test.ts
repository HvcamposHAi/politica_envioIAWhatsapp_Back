import { describe, expect, it } from 'vitest';
import { ehPedidoDeDescadastro, normalizarTexto } from './optOut.js';

describe('normalizarTexto', () => {
  it('tira acento, caixa e pontuação', () => {
    expect(normalizarTexto('SAIR!!!')).toBe('sair');
    expect(normalizarTexto('Não  quero.')).toBe('nao quero');
    expect(normalizarTexto('  ')).toBe('');
  });
});

describe('ehPedidoDeDescadastro — o que PRECISA ser reconhecido', () => {
  // Cada falso negativo aqui é uma pessoa que pediu para sair e recebe
  // mensagem de novo. É o dano que não tem desfazer.
  const pedidos = [
    'SAIR',
    'sair',
    'Sair.',
    'sair por favor',
    'PARE',
    'pare!',
    'parar',
    'stop',
    'cancelar',
    'descadastrar',
    'me descadastra',
    'me descadastre por favor',
    'remover',
    'chega',
    'não quero mais receber',
    'nao quero mais mensagens',
    'não me mande mais mensagens',
    'não me manda mais nada',
    'me tira dessa lista',
    'me tire daqui',
    'para de me mandar mensagem',
    'pare de mandar essas mensagens',
    'me remova da lista',
    'quero cancelar o recebimento',
    'sair da lista',
    'não perturbe',
    'me exclua',
    'me desinscreva',
  ];

  for (const p of pedidos) {
    it(`reconhece "${p}"`, () => {
      expect(ehPedidoDeDescadastro(p)).toBe(true);
    });
  }
});

describe('ehPedidoDeDescadastro — o que NÃO pode disparar', () => {
  // Falso positivo remove um apoiador por engano. É barato perto do
  // falso negativo, mas ainda é erro.
  const naoSao = [
    'Oi, tudo bem?',
    'Vou sair de casa agora e te respondo depois',
    'Estou indo para a reunião',
    'Isso é para mim?',
    'Bom dia, para quando é o evento?',
    'Legal, vou parar para ler com calma',
    'Quero saber mais sobre a proposta',
    'Obrigado pela mensagem!',
    'Vocês vão fazer alguma coisa para o bairro?',
    'Preciso de ajuda para resolver um problema na rua',
    'Vou remover o carro da garagem, depois vejo isso',
    '',
    '   ',
  ];

  for (const t of naoSao) {
    it(`não dispara com "${t.slice(0, 45)}"`, () => {
      expect(ehPedidoDeDescadastro(t)).toBe(false);
    });
  }

  it('não dispara com null nem undefined', () => {
    expect(ehPedidoDeDescadastro(null)).toBe(false);
    expect(ehPedidoDeDescadastro(undefined)).toBe(false);
  });
});

describe('a regra de "palavra isolada"', () => {
  it('"para" sozinho conta, dentro de frase longa não', () => {
    // É por isso que a lista de palavras isoladas só vale em mensagem
    // curta: "para" é preposição na maior parte do português.
    expect(ehPedidoDeDescadastro('para')).toBe(true);
    expect(ehPedidoDeDescadastro('bom dia, para quando é a reunião do bairro?')).toBe(false);
  });

  it('ignora cortesia ao redor da palavra', () => {
    expect(ehPedidoDeDescadastro('sair pf')).toBe(true);
    expect(ehPedidoDeDescadastro('pare obrigado')).toBe(true);
  });

  it('não é acionado por mensagem longa que só contém a palavra', () => {
    expect(ehPedidoDeDescadastro('eu não vou parar de apoiar vocês de jeito nenhum')).toBe(false);
  });
});
