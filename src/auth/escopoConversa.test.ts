import { describe, it, expect, beforeEach, vi } from 'vitest';

/* T19–T24 do PLANO_GOVERNANCA_ACESSOS.md.
 *
 * `conversaNoEscopo` é a única barreira do BACKEND: todas as rotas gravam com
 * `service_role`, que ignora a RLS. Até 2026-08-17 a regra aqui era "é da minha
 * empresa" — bastava um operador conhecer o id para responder, pedir resumo e
 * gerar coach numa conversa que não aparecia na tela dele. Este arquivo não
 * existia. */

let empresasPorAtendente = new Map<string, string[]>();
let supervisaoPorAtendente = new Map<string, string[]>();

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: {
    from: (tabela: string) => {
      let atendenteId = '';
      const b = {
        select: () => b,
        eq: (_col: string, v: string) => {
          atendenteId = v;
          return b;
        },
        then: (r: (v: unknown) => void) => {
          if (tabela === 'atendente_empresas') {
            const ids = empresasPorAtendente.get(atendenteId) ?? [];
            return r({ data: ids.map((empresa_id) => ({ empresa_id })), error: null });
          }
          if (tabela === 'supervisao') {
            const ids = supervisaoPorAtendente.get(atendenteId) ?? [];
            return r({ data: ids.map((setor_id) => ({ setor_id })), error: null });
          }
          return r({ data: [], error: null });
        },
      };
      return b;
    },
  },
}));

const { conversaNoEscopo, setoresSupervisionados } = await import('./escopoConversa.js');

const EU = 'atend-eu';
const COLEGA = 'atend-colega';
const EMPRESA = 'emp-1';
const MEU_SETOR = 'set-meu';
const OUTRO_SETOR = 'set-outro';

/** Conversa no formato que as rotas montam (embed de setores/canais). */
function conversa(over: Partial<Record<string, unknown>> = {}) {
  return {
    atendente_id: null,
    setor_id: MEU_SETOR,
    setores: { empresa_id: EMPRESA },
    canais: { empresa_id: EMPRESA },
    ...over,
  } as Parameters<typeof conversaNoEscopo>[1];
}

beforeEach(() => {
  empresasPorAtendente = new Map([[EU, [EMPRESA]]]);
  supervisaoPorAtendente = new Map();
});

describe('conversaNoEscopo', () => {
  it('T19 · admin passa em qualquer conversa', async () => {
    const ok = await conversaNoEscopo({ id: EU, perfil: 'admin' }, conversa({ atendente_id: COLEGA }));
    expect(ok).toBe(true);
  });

  it('T20 · operador passa na conversa dele', async () => {
    const ok = await conversaNoEscopo({ id: EU, perfil: 'operador' }, conversa({ atendente_id: EU }));
    expect(ok).toBe(true);
  });

  it('T21 · operador NÃO passa na conversa de colega da mesma empresa', async () => {
    // Antes de 2026-08-17 isto devolvia `true` — era o furo.
    const ok = await conversaNoEscopo({ id: EU, perfil: 'operador' }, conversa({ atendente_id: COLEGA }));
    expect(ok).toBe(false);
  });

  it('T21b · operador NÃO passa em conversa sem dono do próprio setor', async () => {
    const ok = await conversaNoEscopo({ id: EU, perfil: 'operador' }, conversa({ atendente_id: null }));
    expect(ok).toBe(false);
  });

  it('T22 · supervisor passa em conversa de setor que supervisiona', async () => {
    supervisaoPorAtendente = new Map([[EU, [MEU_SETOR]]]);
    const ok = await conversaNoEscopo(
      { id: EU, perfil: 'supervisor' },
      conversa({ atendente_id: COLEGA }),
    );
    expect(ok).toBe(true);
  });

  it('T23 · supervisor NÃO passa em setor que não supervisiona', async () => {
    supervisaoPorAtendente = new Map([[EU, [MEU_SETOR]]]);
    const ok = await conversaNoEscopo(
      { id: EU, perfil: 'supervisor' },
      conversa({ atendente_id: COLEGA, setor_id: OUTRO_SETOR }),
    );
    expect(ok).toBe(false);
  });

  it('supervisor passa na conversa dele fora dos setores supervisionados', async () => {
    supervisaoPorAtendente = new Map([[EU, [MEU_SETOR]]]);
    const ok = await conversaNoEscopo(
      { id: EU, perfil: 'supervisor' },
      conversa({ atendente_id: EU, setor_id: OUTRO_SETOR }),
    );
    expect(ok).toBe(true);
  });

  it('supervisor com setor_id nulo na conversa não passa', async () => {
    supervisaoPorAtendente = new Map([[EU, [MEU_SETOR]]]);
    const ok = await conversaNoEscopo(
      { id: EU, perfil: 'supervisor' },
      conversa({ atendente_id: COLEGA, setor_id: null }),
    );
    expect(ok).toBe(false);
  });

  it('supervisão órfã de outra empresa não vale', async () => {
    // Vínculo de supervisão sobrevivendo a uma troca de empresa.
    supervisaoPorAtendente = new Map([[EU, [MEU_SETOR]]]);
    empresasPorAtendente = new Map([[EU, ['outra-empresa']]]);
    const ok = await conversaNoEscopo(
      { id: EU, perfil: 'supervisor' },
      conversa({ atendente_id: COLEGA }),
    );
    expect(ok).toBe(false);
  });

  it('T24 · perfil desconhecido não passa (fail-closed)', async () => {
    const ok = await conversaNoEscopo(
      { id: EU, perfil: 'atendente' },
      conversa({ atendente_id: COLEGA }),
    );
    expect(ok).toBe(false);
  });
});

describe('setoresSupervisionados', () => {
  it('devolve vazio para quem não é supervisor, mesmo com linha em hub.supervisao', async () => {
    // O gate de perfil mora na função, num lugar só: supervisor rebaixado a
    // operador perde a visão na hora, sem depender de limpar a tabela.
    supervisaoPorAtendente = new Map([[EU, [MEU_SETOR]]]);
    const s = await setoresSupervisionados({ id: EU, perfil: 'operador' });
    expect(s.size).toBe(0);
  });

  it('devolve os setores do supervisor', async () => {
    supervisaoPorAtendente = new Map([[EU, [MEU_SETOR, OUTRO_SETOR]]]);
    const s = await setoresSupervisionados({ id: EU, perfil: 'supervisor' });
    expect([...s].sort()).toEqual([MEU_SETOR, OUTRO_SETOR].sort());
  });
});
