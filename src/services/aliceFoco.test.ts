// Teste do módulo puro do indicador em foco.
// PLANO_PAINEL_CLICAVEL_ALICE_CONTEXTUAL.md, §8.1.
//
// Sem nenhum mock: é essa a vantagem de aliceFoco.ts não conhecer Supabase nem
// Anthropic. O que se prova aqui é a parte que mais quebra confiança quando dá
// errado — a Alice citar um número diferente do que está no card.
import { describe, expect, it } from 'vitest';
import {
  conferirValor,
  detalharFoco,
  diasDoPeriodo,
  FOCOS_VALIDOS,
  MAX_DIAS_JANELA,
  resolverJanela,
  type AliceFoco,
  type ContextoFoco,
  type ConversaFoco,
} from './aliceFoco.js';

const AGORA = '2026-08-08T18:00:00.000Z';
const minAtras = (n: number) => new Date(Date.parse(AGORA) - n * 60_000).toISOString();

function conversa(over: Partial<ConversaFoco> = {}): ConversaFoco {
  return {
    id: `c-${Math.random().toString(36).slice(2)}`,
    setor_id: 'setor-1',
    atendente_id: 'atend-1',
    canal_id: 'canal-1',
    status: 'novo',
    desfecho: null,
    motivo_perda: null,
    sentimento: null,
    risco: null,
    risco_motivo: null,
    titulo_ia: null,
    resumo_ia: null,
    nota_satisfacao: null,
    valor_venda: null,
    aberta_em: minAtras(600),
    primeira_resposta_em: null,
    fechada_em: null,
    avaliacao_solicitada_em: null,
    avaliacao_registrada_em: null,
    setores: { id: 'setor-1', nome: 'Compras', empresa_id: 'emp-A' },
    canais: { empresa_id: 'emp-A' },
    ...over,
  };
}

function contexto(atuais: ConversaFoco[], anteriores: ConversaFoco[] = []): ContextoFoco {
  return {
    atuais,
    anteriores,
    nomesAtendentes: new Map([
      ['atend-1', 'Humberto'],
      ['atend-2', 'Marina'],
    ]),
    agoraISO: AGORA,
  };
}

function foco(over: Partial<AliceFoco> = {}): AliceFoco {
  return {
    tipo: 'kpi_chamados',
    titulo: 'Chamados',
    valor: '13',
    periodo: '30',
    desde: minAtras(30 * 24 * 60),
    linhas: [],
    ...over,
  };
}

const texto = (linhas: string[]) => linhas.join('\n');

describe('janela', () => {
  it('diasDoPeriodo traduz os três períodos do Painel', () => {
    expect(diasDoPeriodo('hoje')).toBe(1);
    expect(diasDoPeriodo('7')).toBe(7);
    expect(diasDoPeriodo('30')).toBe(30);
  });

  it('usa o `desde` do front — é o que faz "hoje" bater apesar do fuso', () => {
    /* O Painel calcula meia-noite no fuso do NAVEGADOR; o Cloud Run roda em
     * UTC. Recalcular no servidor erraria em 3h todo dia, e o sintoma seria a
     * Alice citando um total que o card não mostra. */
    const meiaNoiteSP = '2026-08-08T03:00:00.000Z';
    const j = resolverJanela(meiaNoiteSP, 'hoje', AGORA);

    expect(j.desde.toISOString()).toBe(meiaNoiteSP);
    expect(j.clampado).toBe(false);
    // A janela anterior tem exatamente a mesma largura.
    expect(j.desde.getTime() - j.anteriorDesde.getTime()).toBe(
      Date.parse(AGORA) - Date.parse(meiaNoiteSP),
    );
  });

  it('clampa uma janela absurda em vez de varrer a tabela inteira', () => {
    const j = resolverJanela('1970-01-01T00:00:00.000Z', '30', AGORA);

    expect(j.clampado).toBe(true);
    expect(Math.round(j.dias)).toBe(MAX_DIAS_JANELA);
  });

  it('cai no período quando `desde` não é data', () => {
    const j = resolverJanela('ontem', '7', AGORA);
    expect(Math.round(j.dias)).toBe(7);
  });
});

describe('detalharFoco', () => {
  it('kpi_primeira_resposta traz p90, sem-resposta e os piores casos com nome', () => {
    const cs = [
      conversa({ primeira_resposta_em: minAtras(595) }), // 5 min
      conversa({ primeira_resposta_em: minAtras(580) }), // 20 min
      conversa({
        atendente_id: 'atend-2',
        primeira_resposta_em: minAtras(480),
        setores: { id: 'setor-2', nome: 'Televendas', empresa_id: 'emp-A' },
        setor_id: 'setor-2',
      }), // 120 min
      conversa({ primeira_resposta_em: null }),
    ];

    const t = texto(detalharFoco(foco({ tipo: 'kpi_primeira_resposta' }), contexto(cs)));

    expect(t).toContain('p90');
    expect(t).toContain('Ainda sem nenhuma resposta: 1');
    expect(t).toContain('Piores casos');
    expect(t).toContain('Televendas · Marina · 2h');
  });

  it('kpi_espera declara o mock e não oferece número para decidir', () => {
    const t = texto(
      detalharFoco(foco({ tipo: 'kpi_espera', mock: true }), contexto([conversa()])),
    );

    expect(t).toContain('ESTE INDICADOR É MOCK');
    expect(t).toContain('NÃO recomende nada com base neste número');
    // O único número que ele pode citar é um que existe de verdade.
    expect(t).toContain('sem dono agora');
  });

  it('kpi_sla separa violação de "ainda no prazo"', () => {
    const cs = [
      conversa({ primeira_resposta_em: minAtras(595) }), // 5 min → dentro
      conversa({ primeira_resposta_em: minAtras(570) }), // 30 min → violou
      conversa({ aberta_em: minAtras(5), primeira_resposta_em: null }), // relógio correndo
      conversa({ aberta_em: minAtras(60), primeira_resposta_em: null }), // venceu sem responder
    ];

    const t = texto(detalharFoco(foco({ tipo: 'kpi_sla' }), contexto(cs)));

    expect(t).toContain('Decididas: 3');
    expect(t).toContain('Dentro da meta: 1');
    expect(t).toContain('Violações: 2');
    expect(t).toContain('Ainda dentro do prazo (excluídas do denominador, o relógio está correndo): 1');
  });

  it('alerta_risco resolve a conversa DENTRO do array já escopado', () => {
    const alvo = conversa({
      id: 'conv-alvo',
      risco: 'alto',
      risco_motivo: 'cliente exigiu falar com o dono',
      titulo_ia: 'Reclamação de prazo',
      primeira_resposta_em: null,
    });
    const f = foco({ tipo: 'alerta_risco', recorte: { conversaId: 'conv-alvo' } });

    const t = texto(detalharFoco(f, contexto([alvo, conversa()])));

    expect(t).toContain('cliente exigiu falar com o dono');
    expect(t).toContain('Reclamação de prazo');
    expect(t).toContain('AINDA SEM PRIMEIRA RESPOSTA');
  });

  it('recorte que não encontra nada devolve "não tem a informação" em vez de lançar', () => {
    const f = foco({
      tipo: 'alerta_risco',
      recorte: { conversaId: '00000000-0000-4000-8000-000000000000' },
    });

    expect(() => detalharFoco(f, contexto([conversa()]))).not.toThrow();
    expect(texto(detalharFoco(f, contexto([conversa()])))).toContain('Não encontrei esta conversa');
  });

  it('linha_saude sem canal no escopo não inventa a linha', () => {
    const f = foco({
      tipo: 'linha_saude',
      recorte: { canalId: '00000000-0000-4000-8000-000000000001' },
    });

    // ctx.canal ausente = buscarCanalNoEscopo não encontrou dentro das empresas
    // visíveis. É o caso do canalId forjado.
    expect(texto(detalharFoco(f, contexto([conversa()])))).toContain('Não encontrei esta linha');
  });

  it('sentimento_celula compara a célula com o setor inteiro', () => {
    const cs = [
      conversa({ sentimento: 'negativo', titulo_ia: 'Atraso na entrega' }),
      conversa({ sentimento: 'negativo' }),
      conversa({ atendente_id: 'atend-2', sentimento: 'positivo' }),
    ];
    const f = foco({
      tipo: 'sentimento_celula',
      recorte: { setorId: 'setor-1', atendenteId: 'atend-1' },
    });

    const t = texto(detalharFoco(f, contexto(cs)));

    expect(t).toContain('Nesta célula: 2 conversas');
    expect(t).toContain('No setor inteiro (todos os atendentes): 3 classificadas');
    expect(t).toContain('Atraso na entrega');
  });
});

describe('conferirValor — a invariante contra contradizer a tela', () => {
  it('confirma quando o recálculo bate com o card', () => {
    const c = conferirValor(foco({ valor: '2' }), contexto([conversa(), conversa()]));
    expect(c).toContain('Sem divergência');
  });

  it('reporta divergência E manda tratar o valor da tela como o da conversa', () => {
    const c = conferirValor(foco({ valor: '13' }), contexto([conversa()]));

    expect(c).toContain('HÁ DIVERGÊNCIA');
    expect(c).toContain('"13"');
    expect(c).toContain('"1"');
    expect(c).toContain('Trate o valor da tela como o número da conversa');
  });

  it('conta as conversas sem setor que foram excluídas, como o Painel exclui', () => {
    /* O Painel monta o escopo a partir da lista de setores, então conversa sem
     * setor não entra em KPI nenhum. Aqui o escopo vem da empresa (que pode vir
     * do canal), então ela entraria — e a Alice diria 3 onde o card diz 1.
     * Replicar o descarte é o certo; esconder que ele existiu, não. */
    const cs = [conversa(), conversa({ setor_id: null, setores: null }), conversa({ setor_id: null, setores: null })];

    const c = conferirValor(foco({ valor: '1' }), contexto(cs));

    expect(c).toContain('Sem divergência');
    expect(c).toContain('2 conversa(s) sem setor foram excluídas');
  });

  it('não recalcula indicador mock — não dá autoridade a um número que não existe', () => {
    expect(conferirValor(foco({ tipo: 'kpi_espera', mock: true }), contexto([conversa()]))).toBeNull();
    expect(conferirValor(foco({ tipo: 'linha_saude' }), contexto([conversa()]))).toBeNull();
    expect(conferirValor(foco({ tipo: 'faixa_numeros' }), contexto([conversa()]))).toBeNull();
  });

  it('formata como o Painel formata — a comparação é de string, não de float', () => {
    const cs = [
      conversa({ primeira_resposta_em: minAtras(596) }), // 4 min
      conversa({ primeira_resposta_em: minAtras(596) }),
    ];

    const c = conferirValor(foco({ tipo: 'kpi_primeira_resposta', valor: '4 min' }), contexto(cs));
    expect(c).toContain('Sem divergência');
  });

  it('"—" quando não há base, em vez de 0% (mesma regra do card)', () => {
    const c = conferirValor(foco({ tipo: 'kpi_csat', valor: '—' }), contexto([conversa()]));
    expect(c).toContain('Sem divergência');
  });
});

describe('allowlist', () => {
  it('tem os 22 tipos do plano e nenhum duplicado', () => {
    // Trava a divergência com o front: um tipo que exista só lá vira 400 em
    // produção, e o sintoma seria "um card específico não funciona".
    expect(FOCOS_VALIDOS).toHaveLength(22);
    expect(new Set(FOCOS_VALIDOS).size).toBe(22);
  });
});
