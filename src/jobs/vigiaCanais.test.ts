// O vigia é a única coisa no backend que percebe uma linha caída sem
// ninguém olhando a tela. Dois riscos precisam ficar travados por teste:
//
//  1. que ele NÃO vire uma fonte de tráfego constante para o WhatsApp —
//     reconectar o que já está de pé é o perfil que dispara limitação
//     anti-abuso (R1 do plano de risco);
//  2. que ele NUNCA derrube o processo — uma exceção escapando de dentro
//     de um setInterval vira unhandledRejection, e este processo segura
//     todas as linhas de WhatsApp ao mesmo tempo (modo de falha "processo
//     em ciclo de restart" do plano).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const canaisRecuperaveisMock = vi.fn();
const canalEmMemoriaMock = vi.fn();
const conectarSpy = vi.fn().mockResolvedValue(undefined);
const obterOuCriarCanalMock = vi.fn(async () => ({ conectar: conectarSpy }));

/** A posse do gateway (jobs/lease.ts) barra tudo que toca em canal quando
 *  esta instância não é a dona. Aqui ela é controlável, para os testes
 *  exercitarem os dois lados. */
let temPosse = true;
vi.mock('./lease.js', () => ({
  souODonoDoGateway: () => temPosse,
}));

vi.mock('../channels/registry.js', () => ({
  canaisRecuperaveis: (...a: unknown[]) => canaisRecuperaveisMock(...a),
  canalEmMemoria: (...a: unknown[]) => canalEmMemoriaMock(...a),
  obterOuCriarCanal: (...a: unknown[]) => obterOuCriarCanalMock(...(a as [])),
}));

const insercoes: Array<Record<string, unknown>> = [];
vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      insert: vi.fn((dados: Record<string, unknown>) => {
        insercoes.push(dados);
        return Promise.resolve({ error: null });
      }),
    })),
  },
}));

const { vigiarCanais } = await import('./vigiaCanais.js');

/** Canal presente no Map do registry, com o status que o teste quiser. */
const emMemoria = (status: string) => ({ status: vi.fn().mockResolvedValue(status) });

beforeEach(() => {
  temPosse = true;
  insercoes.length = 0;
  conectarSpy.mockClear();
  obterOuCriarCanalMock.mockClear();
  canalEmMemoriaMock.mockReset();
  canaisRecuperaveisMock.mockReset().mockResolvedValue([]);
});

describe('vigiarCanais() — não cutuca o que está de pé', () => {
  it('canal em memória e conectado -> não faz nada', async () => {
    canaisRecuperaveisMock.mockResolvedValue(['c1']);
    canalEmMemoriaMock.mockReturnValue(emMemoria('conectado'));

    expect(await vigiarCanais()).toBe(0);
    expect(conectarSpy).not.toHaveBeenCalled();
    expect(insercoes).toHaveLength(0);
  });

  it.each(['conectando', 'lendo_qr'])(
    'canal em %s -> já há tentativa em andamento, o vigia não intervém',
    async (status) => {
      canaisRecuperaveisMock.mockResolvedValue(['c1']);
      canalEmMemoriaMock.mockReturnValue(emMemoria(status));

      expect(await vigiarCanais()).toBe(0);
      expect(conectarSpy).not.toHaveBeenCalled();
    },
  );

  it('canal recuperável AUSENTE do registry -> reconecta uma vez e registra o evento', async () => {
    canaisRecuperaveisMock.mockResolvedValue(['c1']);
    canalEmMemoriaMock.mockReturnValue(undefined);

    expect(await vigiarCanais()).toBe(1);
    expect(conectarSpy).toHaveBeenCalledTimes(1);
    // o evento é o que prova, em hub.eventos_canal, que o vigia está vivo
    expect(insercoes).toEqual([
      { canal_id: 'c1', tipo: 'reconectando', detalhe: { motivo: 'vigia', status: 'desconectado' } },
    ]);
  });

  it('canal em memória mas instavel -> reconecta', async () => {
    canaisRecuperaveisMock.mockResolvedValue(['c1']);
    canalEmMemoriaMock.mockReturnValue(emMemoria('instavel'));

    expect(await vigiarCanais()).toBe(1);
    expect(conectarSpy).toHaveBeenCalledTimes(1);
  });

  it('só reconecta quem canaisRecuperaveis() liberou — a guarda de sessão é lá', async () => {
    canaisRecuperaveisMock.mockResolvedValue([]);

    expect(await vigiarCanais()).toBe(0);
    expect(conectarSpy).not.toHaveBeenCalled();
  });
});

// T9 — o vigia roda dentro de um setInterval: qualquer exceção que escape
// daqui vira unhandledRejection num processo que segura todas as linhas.
describe('vigiarCanais() — nunca lança', () => {
  it('falha em UM canal não interrompe os outros nem propaga', async () => {
    canaisRecuperaveisMock.mockResolvedValue(['ruim', 'bom']);
    canalEmMemoriaMock.mockImplementation((id: string) => {
      if (id === 'ruim') throw new Error('status explodiu');
      return undefined;
    });

    await expect(vigiarCanais()).resolves.toBe(1);
    expect(conectarSpy).toHaveBeenCalledTimes(1);
  });

  it('falha ao listar canais não propaga — a próxima passada tenta de novo', async () => {
    canaisRecuperaveisMock.mockRejectedValue(new Error('banco fora'));

    await expect(vigiarCanais()).resolves.toBe(0);
  });

  it('falha ao gravar o evento não impede a reconexão — o produto é a linha de pé', async () => {
    canaisRecuperaveisMock.mockResolvedValue(['c1']);
    canalEmMemoriaMock.mockReturnValue(undefined);
    obterOuCriarCanalMock.mockResolvedValueOnce({ conectar: conectarSpy });

    await expect(vigiarCanais()).resolves.toBe(1);
    expect(conectarSpy).toHaveBeenCalledTimes(1);
  });
});

describe('posse do gateway', () => {
  it('NÃO mexe em canal nenhum quando esta instância não é a dona', async () => {
    // Durante um deploy do Render existem duas instâncias por alguns
    // segundos. A que não tem a posse reconectando sockets é exatamente o
    // duelo de sessão (440 connectionReplaced) que a posse existe para
    // impedir.
    temPosse = false;
    canaisRecuperaveisMock.mockResolvedValue(['c1']);
    canalEmMemoriaMock.mockReturnValue(undefined);

    const reconectados = await vigiarCanais();

    expect(reconectados).toBe(0);
    expect(canaisRecuperaveisMock).not.toHaveBeenCalled();
    expect(obterOuCriarCanalMock).not.toHaveBeenCalled();
    expect(conectarSpy).not.toHaveBeenCalled();
  });

  it('volta a trabalhar assim que a posse é reavida', async () => {
    // O vigia é o mecanismo de RETRY: a instância nova não reconecta no
    // boot (não é dona ainda) e, quando assume, é aqui que tudo volta.
    temPosse = false;
    canaisRecuperaveisMock.mockResolvedValue(['c1']);
    canalEmMemoriaMock.mockReturnValue(undefined);
    await vigiarCanais();
    expect(conectarSpy).not.toHaveBeenCalled();

    temPosse = true;
    await vigiarCanais();
    expect(conectarSpy).toHaveBeenCalled();
  });
});
