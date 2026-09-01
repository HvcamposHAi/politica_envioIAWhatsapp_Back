import { describe, expect, it } from 'vitest';
import {
  aplicarCampos,
  avaliarPausaAutomatica,
  decidir,
  dentroDaJanela,
  diaNaCampanha,
  diasDeVidaDaLinha,
  minutoAtualNaCampanha,
  minutosDoDia,
  proximoIntervaloMs,
  tempoDigitandoMs,
  tetoDeHoje,
  type EstadoDisparo,
  type RitmoConfig,
} from './ritmoDisparo.js';

/** Instante em UTC. Brasília é UTC-3 o ano inteiro desde 2019 (sem
 *  horário de verão), então 12:00Z = 09:00 em São Paulo. */
function utc(iso: string): Date {
  return new Date(iso);
}

const CONFIG: RitmoConfig = {
  janelaInicio: '09:00',
  janelaFim: '20:00',
  intervaloMinSeg: 25,
  intervaloMaxSeg: 90,
  rampa: [40, 80, 150, 250, 400],
  tetoDiario: null,
};

describe('minutosDoDia', () => {
  it('converte HH:MM', () => {
    expect(minutosDoDia('09:00')).toBe(540);
    expect(minutosDoDia('20:30')).toBe(1230);
    expect(minutosDoDia('00:00')).toBe(0);
  });

  it('devolve null em vez de adivinhar 00:00', () => {
    expect(minutosDoDia('')).toBeNull();
    expect(minutosDoDia('25:00')).toBeNull();
    expect(minutosDoDia('09:70')).toBeNull();
    expect(minutosDoDia('manhã')).toBeNull();
  });
});

describe('fuso da campanha', () => {
  it('lê a hora em São Paulo, não no relógio do container', () => {
    // O Cloud Run roda em UTC. 12:00Z são 09:00 em São Paulo.
    expect(minutoAtualNaCampanha(utc('2026-09-01T12:00:00Z'))).toBe(9 * 60);
    expect(minutoAtualNaCampanha(utc('2026-09-01T23:00:00Z'))).toBe(20 * 60);
  });

  it('vira o dia à meia-noite de Brasília, não à de UTC', () => {
    // 02:00Z do dia 2 ainda são 23:00 do dia 1 em São Paulo. Se o contador
    // virasse em UTC, a campanha ganharia um teto extra às 21h.
    expect(diaNaCampanha(utc('2026-09-02T02:00:00Z'))).toBe('2026-09-01');
    expect(diaNaCampanha(utc('2026-09-02T03:00:00Z'))).toBe('2026-09-02');
  });
});

describe('dentroDaJanela', () => {
  it('deixa passar dentro do horário', () => {
    expect(dentroDaJanela(utc('2026-09-01T15:00:00Z'), '09:00', '20:00')).toBe(true); // 12:00 BRT
  });

  it('inclui o início e EXCLUI o fim', () => {
    expect(dentroDaJanela(utc('2026-09-01T12:00:00Z'), '09:00', '20:00')).toBe(true); // 09:00
    expect(dentroDaJanela(utc('2026-09-01T23:00:00Z'), '09:00', '20:00')).toBe(false); // 20:00
    expect(dentroDaJanela(utc('2026-09-01T22:59:00Z'), '09:00', '20:00')).toBe(true); // 19:59
  });

  it('barra a madrugada', () => {
    expect(dentroDaJanela(utc('2026-09-01T06:00:00Z'), '09:00', '20:00')).toBe(false); // 03:00
  });

  it('recusa janela invertida em vez de interpretar como "atravessa a meia-noite"', () => {
    // Aceitar isso transformaria um erro de digitação em envio às 3h.
    expect(dentroDaJanela(utc('2026-09-01T06:00:00Z'), '20:00', '09:00')).toBe(false);
    expect(dentroDaJanela(utc('2026-09-01T15:00:00Z'), '20:00', '09:00')).toBe(false);
  });

  it('recusa janela malformada', () => {
    expect(dentroDaJanela(utc('2026-09-01T15:00:00Z'), 'manhã', '20:00')).toBe(false);
  });
});

describe('rampa de aquecimento', () => {
  it('cresce nos primeiros dias', () => {
    expect(tetoDeHoje(1, CONFIG)).toBe(40);
    expect(tetoDeHoje(2, CONFIG)).toBe(80);
    expect(tetoDeHoje(3, CONFIG)).toBe(150);
    expect(tetoDeHoje(4, CONFIG)).toBe(250);
    expect(tetoDeHoje(5, CONFIG)).toBe(400);
  });

  it('mantém o último valor dali em diante', () => {
    expect(tetoDeHoje(6, CONFIG)).toBe(400);
    expect(tetoDeHoje(90, CONFIG)).toBe(400);
  });

  it('trata dia 0 ou negativo como dia 1, nunca como sem teto', () => {
    expect(tetoDeHoje(0, CONFIG)).toBe(40);
    expect(tetoDeHoje(-3, CONFIG)).toBe(40);
  });

  it('quando há rampa e teto do disparo, vence o MENOR', () => {
    // A rampa protege a linha; o teto protege o orçamento. Nenhum dos dois
    // pode ser anulado pelo outro.
    expect(tetoDeHoje(5, { ...CONFIG, tetoDiario: 100 })).toBe(100);
    expect(tetoDeHoje(1, { ...CONFIG, tetoDiario: 100 })).toBe(40);
  });

  it('sem rampa, vale o teto do disparo', () => {
    expect(tetoDeHoje(9, { ...CONFIG, rampa: [], tetoDiario: 500 })).toBe(500);
  });

  it('sem rampa e sem teto, não há limite', () => {
    expect(tetoDeHoje(9, { ...CONFIG, rampa: [], tetoDiario: null })).toBeNull();
  });
});

describe('diasDeVidaDaLinha', () => {
  it('conta o dia da conexão como 1', () => {
    expect(diasDeVidaDaLinha(utc('2026-09-01T13:00:00Z'), utc('2026-09-01T20:00:00Z'))).toBe(1);
  });

  it('conta pelo dia civil, não por 24h corridas', () => {
    // Conectou 22h de ontem, agora são 10h de hoje: é o dia 2, ainda que
    // tenham passado só 12 horas.
    expect(diasDeVidaDaLinha(utc('2026-09-01T01:00:00Z'), utc('2026-09-01T13:00:00Z'))).toBe(2);
  });

  it('linha sem data de conexão é tratada como dia 1', () => {
    expect(diasDeVidaDaLinha(null, utc('2026-09-01T13:00:00Z'))).toBe(1);
  });
});

describe('proximoIntervaloMs', () => {
  it('respeita as pontas', () => {
    expect(proximoIntervaloMs(25, 90, 0)).toBe(25_000);
    expect(proximoIntervaloMs(25, 90, 0.999999)).toBe(90_000);
  });

  it('sorteia dentro da faixa', () => {
    for (let i = 0; i <= 20; i += 1) {
      const ms = proximoIntervaloMs(25, 90, i / 20);
      expect(ms).toBeGreaterThanOrEqual(25_000);
      expect(ms).toBeLessThanOrEqual(90_000);
    }
  });

  it('nunca devolve zero, mesmo com configuração absurda', () => {
    // Intervalo zero é a diferença entre uma campanha e um flood.
    expect(proximoIntervaloMs(0, 0, 0.5)).toBeGreaterThan(0);
    expect(proximoIntervaloMs(-10, -5, 0.5)).toBeGreaterThan(0);
  });

  it('max menor que min não inverte a faixa', () => {
    expect(proximoIntervaloMs(60, 10, 0.5)).toBe(60_000);
  });
});

describe('tempoDigitandoMs', () => {
  it('cresce com o tamanho do texto', () => {
    expect(tempoDigitandoMs('Oi')).toBeLessThan(tempoDigitandoMs('Oi, '.repeat(20)));
  });

  it('tem piso e teto', () => {
    expect(tempoDigitandoMs('')).toBe(800);
    expect(tempoDigitandoMs('x'.repeat(10_000))).toBe(6_000);
  });
});

describe('decidir', () => {
  const base: EstadoDisparo = {
    status: 'enviando',
    pausadoEm: null,
    enviadosHoje: 0,
    contadorDia: '2026-09-01',
    pendentes: 10,
    canalConectado: true,
    diasDeVidaDaLinha: 5,
  };
  const agora = utc('2026-09-01T15:00:00Z'); // 12:00 BRT, dentro da janela

  it('envia quando tudo está em ordem', () => {
    expect(decidir(base, CONFIG, agora)).toEqual({ enviar: true });
  });

  it('não envia disparo que não está enviando', () => {
    expect(decidir({ ...base, status: 'rascunho' }, CONFIG, agora)).toMatchObject({
      motivo: 'disparo_inativo',
    });
  });

  it('não envia disparo pausado', () => {
    expect(decidir({ ...base, pausadoEm: '2026-09-01T10:00:00Z' }, CONFIG, agora)).toMatchObject({
      motivo: 'pausado',
    });
  });

  it('não envia com o canal fora do ar', () => {
    expect(decidir({ ...base, canalConectado: false }, CONFIG, agora)).toMatchObject({
      motivo: 'canal_desconectado',
    });
  });

  it('não envia fora da janela', () => {
    expect(decidir(base, CONFIG, utc('2026-09-01T06:00:00Z'))).toMatchObject({
      motivo: 'fora_da_janela',
    });
  });

  it('para ao bater o teto do dia', () => {
    expect(decidir({ ...base, enviadosHoje: 400 }, CONFIG, agora)).toMatchObject({
      motivo: 'teto_diario',
    });
  });

  it('contador de outro dia é contador zerado', () => {
    // Sem isto a campanha para para sempre no dia em que bate o teto.
    const ontem = { ...base, enviadosHoje: 400, contadorDia: '2026-08-31' };
    expect(decidir(ontem, CONFIG, agora)).toEqual({ enviar: true });
  });

  it('respeita a rampa no primeiro dia da linha', () => {
    const linhaNova = { ...base, diasDeVidaDaLinha: 1, enviadosHoje: 40 };
    expect(decidir(linhaNova, CONFIG, agora)).toMatchObject({ motivo: 'teto_diario' });
    expect(decidir({ ...linhaNova, enviadosHoje: 39 }, CONFIG, agora)).toEqual({ enviar: true });
  });

  it('canal fora do ar pesa mais que teto e janela', () => {
    // A ordem de checagem é a do §3.4 do plano — o motivo relatado precisa
    // ser o primeiro impedimento, não um qualquer.
    const ruim = { ...base, canalConectado: false, enviadosHoje: 9999 };
    expect(decidir(ruim, CONFIG, utc('2026-09-01T06:00:00Z'))).toMatchObject({
      motivo: 'canal_desconectado',
    });
  });

  it('sem pendentes não é erro, é fim', () => {
    expect(decidir({ ...base, pendentes: 0 }, CONFIG, agora)).toMatchObject({
      motivo: 'sem_pendentes',
    });
  });
});

describe('avaliarPausaAutomatica', () => {
  const limiares = { falhaPct: 15, optOutPct: 5, amostraMinima: 20 };

  it('não conclui nada com amostra pequena', () => {
    // 2 falhas em 3 envios é 66% e não é sinal de nada.
    expect(avaliarPausaAutomatica({ enviados: 3, falhas: 2, optOuts: 1 }, limiares)).toBeNull();
  });

  it('pausa quando a taxa de opt-out estoura', () => {
    expect(avaliarPausaAutomatica({ enviados: 100, falhas: 0, optOuts: 5 }, limiares)).toBe(
      'taxa_de_optout',
    );
  });

  it('pausa quando a taxa de falha estoura', () => {
    expect(avaliarPausaAutomatica({ enviados: 100, falhas: 15, optOuts: 0 }, limiares)).toBe(
      'taxa_de_falha',
    );
  });

  it('opt-out tem prioridade sobre falha quando os dois estouram', () => {
    // Opt-out mede gente incomodada; falha mede número ruim. O primeiro é
    // o que antecede a denúncia.
    expect(avaliarPausaAutomatica({ enviados: 100, falhas: 50, optOuts: 20 }, limiares)).toBe(
      'taxa_de_optout',
    );
  });

  it('não pausa dentro dos limiares', () => {
    expect(avaliarPausaAutomatica({ enviados: 100, falhas: 10, optOuts: 2 }, limiares)).toBeNull();
  });
});

describe('aplicarCampos', () => {
  it('substitui os campos disponíveis', () => {
    expect(
      aplicarCampos('Oi {{primeiro_nome}}, tudo bem no {{bairro}}?', {
        primeiro_nome: 'Maria',
        bairro: 'Centro',
      }),
    ).toBe('Oi Maria, tudo bem no Centro?');
  });

  it('campo ausente vira vazio, nunca "{{nome}}" literal', () => {
    // É o erro que todo mundo já recebeu por SMS, e ele diz para a pessoa,
    // em uma linha, que ela é uma linha de planilha.
    expect(aplicarCampos('Oi {{primeiro_nome}}!', {})).toBe('Oi!');
    expect(aplicarCampos('Oi {{primeiro_nome}}!', { primeiro_nome: null })).toBe('Oi!');
  });

  it('limpa o espaço duplo que a substituição vazia deixa', () => {
    expect(aplicarCampos('Oi {{primeiro_nome}} tudo bem?', {})).toBe('Oi tudo bem?');
  });

  it('aceita espaço dentro das chaves', () => {
    expect(aplicarCampos('Oi {{ primeiro_nome }}', { primeiro_nome: 'Ana' })).toBe('Oi Ana');
  });

  it('não toca em chave desconhecida que não está no mapa', () => {
    expect(aplicarCampos('Custa {{valor}} reais', {})).toBe('Custa reais');
  });

  it('preserva quebra de parágrafo, colapsa excesso', () => {
    expect(aplicarCampos('a\n\n\n\nb', {})).toBe('a\n\nb');
  });
});
