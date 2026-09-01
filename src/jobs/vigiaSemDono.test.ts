import { describe, it, expect, beforeEach, vi } from 'vitest';

/* Vigia de conversas sem dono — a contrapartida da regra de acesso de
 * 2026-08-17: o operador deixou de ver a fila "Sem dono", e quem responde por
 * ela agora é o gestor da área e o admin. Ver PLANO_GOVERNANCA_ACESSOS.md §7.4. */

let resultado: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const filtros: Record<string, unknown> = {};

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: {
    from: () => {
      const b = {
        select: () => b,
        is: (col: string, v: unknown) => {
          filtros[`is:${col}`] = v;
          return b;
        },
        neq: (col: string, v: unknown) => {
          filtros[`neq:${col}`] = v;
          return b;
        },
        lte: (col: string, v: unknown) => {
          filtros[`lte:${col}`] = v;
          return b;
        },
        order: (col: string, o: unknown) => {
          filtros[`order:${col}`] = o;
          return b;
        },
        then: (r: (v: unknown) => void) => r(resultado),
      };
      return b;
    },
  },
}));

const { vigiarSemDono, LIMITE_SEM_DONO_MS, VIGIA_SEM_DONO_INTERVALO_MS } = await import(
  './vigiaSemDono.js'
);

const AGORA = new Date('2026-08-18T12:00:00.000Z').getTime();

/** Conversa aberta há `minutos`, no formato do embed que o job pede. */
function conversa(minutos: number, setor: string | null, id = 'c1') {
  return {
    id,
    setor_id: setor ? 's-' + setor : null,
    aberta_em: new Date(AGORA - minutos * 60_000).toISOString(),
    setores: setor ? { nome: setor } : null,
  };
}

beforeEach(() => {
  resultado = { data: [], error: null };
  for (const k of Object.keys(filtros)) delete filtros[k];
});

describe('vigiarSemDono', () => {
  it('sem fila parada, devolve zerado', async () => {
    const r = await vigiarSemDono(AGORA);
    expect(r).toEqual({ atrasadas: 0, esperaMaximaMin: 0, porSetor: {} });
  });

  it('conta as atrasadas e agrupa por setor', async () => {
    resultado = {
      data: [
        conversa(40, 'Compras', 'a'),
        conversa(30, 'Compras', 'b'),
        conversa(20, 'Comercial', 'c'),
      ],
      error: null,
    };

    const r = await vigiarSemDono(AGORA);

    expect(r.atrasadas).toBe(3);
    // "3 sem dono" nao aciona ninguem; "2 no Compras" aciona.
    expect(r.porSetor).toEqual({ Compras: 2, Comercial: 1 });
  });

  it('espera maxima vem da mais antiga', async () => {
    resultado = { data: [conversa(47, 'Compras', 'a'), conversa(16, 'Compras', 'b')], error: null };
    const r = await vigiarSemDono(AGORA);
    expect(r.esperaMaximaMin).toBe(47);
  });

  it('conversa sem setor entra como "sem setor", nao desaparece', async () => {
    // Sem dono E sem setor e o caso que nenhum supervisor enxerga — so o
    // admin. Some do log seria o pior lugar para essa conversa sumir.
    resultado = { data: [conversa(30, null, 'a')], error: null };
    const r = await vigiarSemDono(AGORA);
    expect(r.atrasadas).toBe(1);
    expect(r.porSetor).toEqual({ 'sem setor': 1 });
  });

  it('filtra por aberta, sem dono, nao-grupo e acima do limite', async () => {
    await vigiarSemDono(AGORA);

    expect(filtros['is:fechada_em']).toBeNull();
    expect(filtros['is:atendente_id']).toBeNull();
    // Grupo nao e chamado: nao entra na fila de distribuicao.
    expect(filtros['neq:origem_chat']).toBe('grupo');
    // O corte tem que ser AGORA menos o limite, nao "agora".
    expect(filtros['lte:aberta_em']).toBe(new Date(AGORA - LIMITE_SEM_DONO_MS).toISOString());
    // Ordem crescente: a primeira linha e a mais antiga, e o calculo da espera
    // maxima depende disso.
    expect(filtros['order:aberta_em']).toEqual({ ascending: true });
  });

  it('erro de leitura devolve zerado SEM estourar', async () => {
    /* Um job de segundo plano que joga excecao no setInterval derruba a
     * passada e nao volta. Mas o zerado aqui e reportado por um log de ERROR,
     * nao por um log de "nada esperando" — a distincao esta no logger, nao no
     * valor de retorno. */
    resultado = { data: null, error: { message: 'banco fora' } };
    const r = await vigiarSemDono(AGORA);
    expect(r.atrasadas).toBe(0);
  });

  it('o intervalo e maior que o do vigia de canais', async () => {
    // 5 min contra 60s: ali o alvo e um socket caindo, aqui e uma pessoa
    // precisando reagir. Passada mais curta so encheria o log.
    expect(VIGIA_SEM_DONO_INTERVALO_MS).toBeGreaterThan(60_000);
    expect(LIMITE_SEM_DONO_MS).toBe(15 * 60_000);
  });
});
