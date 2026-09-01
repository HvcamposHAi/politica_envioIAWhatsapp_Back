// registry.ts não tinha NENHUM teste até o diagnóstico de 2026-08-14 — e é
// o arquivo que decide, a cada boot, quais linhas de WhatsApp voltam a
// existir. Foi exatamente aí que a causa 1 das quedas periódicas se
// escondeu por uma semana: o filtro de reconexão (`= 'conectado'`) e o
// status gravado no shutdown ('desconectado') se contradiziam, e nenhum
// teste cruzava os dois.
//
// Estes testes travam o contrato de reconexão: QUEM volta no boot, quem NÃO
// volta, e como o processo sai sem desparear aparelho.
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Resposta programável do fake do PostgREST, por tabela. */
let canaisResposta: Array<Record<string, unknown>> = [];
let sessoesResposta: Array<Record<string, unknown>> = [];
let erroCanais: { message: string } | null = null;
let erroSessoes: { message: string } | null = null;

/** Toda chamada ao "banco", para os testes afirmarem sobre o FILTRO usado —
 *  que é o que de fato quebrou em produção. */
const chamadas: Array<{ tabela: string; metodo: string; args: unknown[] }> = [];

function tabelaFake(tabela: string) {
  let ehUpdate = false;
  let ehSingle = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alvo: any = {};
  for (const metodo of ['select', 'eq', 'in', 'update', 'insert', 'delete']) {
    alvo[metodo] = vi.fn((...args: unknown[]) => {
      chamadas.push({ tabela, metodo, args });
      if (metodo === 'update') ehUpdate = true;
      return alvo;
    });
  }
  for (const metodo of ['single', 'maybeSingle']) {
    alvo[metodo] = vi.fn(() => {
      ehSingle = true;
      return alvo;
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  alvo.then = (resolve: any) => {
    if (ehUpdate) return resolve({ data: null, error: null });
    if (ehSingle) {
      return resolve({ data: { id: 'canal-x', transporte: 'baileys', numero: '5547999990000' }, error: null });
    }
    if (tabela === 'canal_sessoes') return resolve({ data: sessoesResposta, error: erroSessoes });
    return resolve({ data: canaisResposta, error: erroCanais });
  };
  return alvo;
}

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: { from: vi.fn((tabela: string) => tabelaFake(tabela)) },
}));

/** Canal falso: o registry não deve saber nada do Baileys de verdade. */
const conectarSpy = vi.fn().mockResolvedValue(undefined);
const desconectarSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('./baileys.adapter.js', () => ({
  BaileysChannel: class {
    transporte = 'baileys';
    constructor(readonly canalId: string) {}
    conectar = (...a: unknown[]) => conectarSpy(this.canalId, ...a);
    desconectar = (...a: unknown[]) => desconectarSpy(this.canalId, ...a);
    aoReceber = vi.fn();
    status = vi.fn().mockResolvedValue('conectado');
    enviar = vi.fn();
  },
}));
vi.mock('../services/mensagens.js', () => ({ processarEventoRecebido: vi.fn() }));
vi.mock('../services/twilioCredenciais.js', () => ({ obterCredenciaisTwilio: vi.fn() }));

const { reconectarCanaisAoSubir, canaisRecuperaveis, obterOuCriarCanal, desconectarTodosOsCanais, removerCanal } =
  await import('./registry.js');

beforeEach(() => {
  chamadas.length = 0;
  conectarSpy.mockClear();
  desconectarSpy.mockClear();
  canaisResposta = [];
  sessoesResposta = [];
  erroCanais = null;
  erroSessoes = null;
});

describe('canaisRecuperaveis() — quem tem direito de voltar sozinho', () => {
  // T5: o filtro original era `.eq('conexao_status', 'conectado')`, exato.
  // Um processo que morresse com a linha em 'instavel' (no meio do backoff)
  // ou 'conectando' nunca mais recuperava aquela linha — mesmo com
  // credencial válida e utilizável em hub.canal_sessoes.
  it('considera conectado, instavel e conectando — não só conectado', async () => {
    canaisResposta = [{ id: 'c1' }];
    sessoesResposta = [{ canal_id: 'c1' }];

    await canaisRecuperaveis();

    const filtro = chamadas.find((c) => c.tabela === 'canais' && c.metodo === 'in');
    expect(filtro).toBeDefined();
    expect(filtro!.args[1]).toEqual(['conectado', 'instavel', 'conectando']);
  });

  it('NÃO considera desconectado nem lendo_qr', async () => {
    canaisResposta = [{ id: 'c1' }];
    sessoesResposta = [{ canal_id: 'c1' }];

    await canaisRecuperaveis();

    const estados = chamadas.find((c) => c.tabela === 'canais' && c.metodo === 'in')!.args[1] as string[];
    // 'desconectado' é o resultado de um logout explícito do usuário:
    // reconectar sozinho desfaria a ação do admin. 'lendo_qr' é uma linha
    // esperando um humano, não uma sessão caída.
    expect(estados).not.toContain('desconectado');
    expect(estados).not.toContain('lendo_qr');
  });

  // T6: sem esta guarda, um canal sem credencial entra em ciclo de REGISTRO
  // sozinho no boot e a cada passada do vigia — o perfil de tráfego que faz
  // o WhatsApp aplicar limitação anti-abuso.
  it('descarta canal SEM linha em canal_sessoes — esse precisa de QR humano', async () => {
    canaisResposta = [{ id: 'com-sessao' }, { id: 'sem-sessao' }];
    sessoesResposta = [{ canal_id: 'com-sessao' }];

    expect(await canaisRecuperaveis()).toEqual(['com-sessao']);
  });

  it('falha ao LER canal_sessoes -> não reconecta nada (fail-closed)', async () => {
    canaisResposta = [{ id: 'c1' }];
    erroSessoes = { message: 'fetch failed' };

    // Tentar às cegas sem conseguir provar que há credencial é o caminho
    // para a limitação anti-abuso — melhor não reconectar nesta passada.
    expect(await canaisRecuperaveis()).toEqual([]);
  });

  it('nenhum canal candidato -> não consulta canal_sessoes à toa', async () => {
    canaisResposta = [];

    expect(await canaisRecuperaveis()).toEqual([]);
    expect(chamadas.some((c) => c.tabela === 'canal_sessoes')).toBe(false);
  });
});

describe('reconectarCanaisAoSubir()', () => {
  it('reconcilia conexao_status ANTES de reconectar: conectado -> instavel', async () => {
    canaisResposta = [];

    await reconectarCanaisAoSubir();

    // Neste instante o Map está vazio por definição — um canal gravado como
    // 'conectado' é resíduo de um processo que morreu sujo, e deixá-lo
    // assim faz a tela afirmar "conectado há 18h" sobre sessão inexistente.
    const update = chamadas.find((c) => c.tabela === 'canais' && c.metodo === 'update');
    expect(update).toBeDefined();
    expect(update!.args[0]).toEqual({ conexao_status: 'instavel' });
    expect(chamadas.filter((c) => c.metodo === 'eq').map((c) => c.args)).toContainEqual([
      'conexao_status',
      'conectado',
    ]);
  });

  it('reconecta cada canal elegível exatamente uma vez', async () => {
    canaisResposta = [{ id: 'c1' }, { id: 'c2' }];
    sessoesResposta = [{ canal_id: 'c1' }, { canal_id: 'c2' }];

    await reconectarCanaisAoSubir();

    expect(conectarSpy).toHaveBeenCalledTimes(2);
    expect(conectarSpy.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
    removerCanal('c1');
    removerCanal('c2');
  });

  it('um canal que falha ao reconectar não impede os demais', async () => {
    canaisResposta = [{ id: 'c1' }, { id: 'c2' }];
    sessoesResposta = [{ canal_id: 'c1' }, { canal_id: 'c2' }];
    conectarSpy.mockRejectedValueOnce(new Error('socket recusado'));

    await expect(reconectarCanaisAoSubir()).resolves.toBeUndefined();
    expect(conectarSpy).toHaveBeenCalledTimes(2);
    removerCanal('c1');
    removerCanal('c2');
  });
});

// T7: um logout de verdade aqui desvincularia o aparelho a CADA restart do
// Cloud Run — a causa raiz do incidente 2026-08-07. Este teste existe para
// que ninguém "simplifique" a chamada tirando o parâmetro.
describe('desconectarTodosOsCanais() — shutdown do processo', () => {
  it('desconecta TODOS preservando a sessão, e esvazia o registry', async () => {
    await obterOuCriarCanal('c1');
    await obterOuCriarCanal('c2');

    await desconectarTodosOsCanais();

    expect(desconectarSpy).toHaveBeenCalledTimes(2);
    for (const chamada of desconectarSpy.mock.calls) {
      expect(chamada[1]).toEqual({ preservarSessao: true });
    }
    // esvaziado: um obterOuCriarCanal depois disto cria instância nova
    await obterOuCriarCanal('c1');
    expect(desconectarSpy).toHaveBeenCalledTimes(2);
    removerCanal('c1');
  });
});
