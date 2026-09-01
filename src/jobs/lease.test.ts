// Posse do gateway. O comportamento que mais importa aqui é a FALHA
// FECHADA: qualquer dúvida sobre ser o dono resolve para "não sou".
// Preferimos um minuto sem reconexão automática a duas instâncias abrindo
// a mesma sessão de WhatsApp.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: { rpc: (nome: string, args: unknown) => rpcMock(nome, args) },
}));

const { INSTANCIA_ID, iniciarLease, liberarLease, souODonoDoGateway, tentarTomarLease, _forcarDono } =
  await import('./lease.js');

beforeEach(() => {
  vi.clearAllMocks();
  _forcarDono(false);
});

describe('identidade da instância', () => {
  it('inclui o hostname e um sufixo aleatório', () => {
    // Hostname sozinho não serve: duas instâncias do Render num deploy
    // podem ter o mesmo. Aleatório sozinho não diz nada no log.
    expect(INSTANCIA_ID).toMatch(/.+-[0-9a-f]{8}$/);
    expect(INSTANCIA_ID.length).toBeGreaterThan(9);
  });
});

describe('tentarTomarLease', () => {
  it('devolve true quando o banco concede a posse', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    await expect(tentarTomarLease()).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      'tomar_lease',
      expect.objectContaining({ p_instancia: INSTANCIA_ID }),
    );
  });

  it('devolve false quando outra instância é a dona', async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });
    await expect(tentarTomarLease()).resolves.toBe(false);
  });

  it('FALHA FECHADA: erro do banco vira "não sou dono"', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'conexão caiu' } });
    await expect(tentarTomarLease()).resolves.toBe(false);
  });

  it('FALHA FECHADA: exceção de rede vira "não sou dono"', async () => {
    rpcMock.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(tentarTomarLease()).resolves.toBe(false);
  });

  it('resposta ambígua não vale como posse', async () => {
    // Qualquer coisa que não seja um `true` explícito é dúvida, e dúvida
    // resolve para não.
    for (const ambigua of [null, undefined, 'true', 1, {}]) {
      rpcMock.mockResolvedValue({ data: ambigua, error: null });
      await expect(tentarTomarLease()).resolves.toBe(false);
    }
  });
});

describe('iniciarLease', () => {
  it('assume e dispara o gancho uma vez só', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    const gancho = vi.fn();

    iniciarLease(gancho);
    await vi.waitFor(() => expect(souODonoDoGateway()).toBe(true));
    expect(gancho).toHaveBeenCalledTimes(1);

    // Renovar não é assumir de novo — o gancho reconecta canais, e
    // reconectar a cada 15 segundos seria o oposto do que se quer.
    await tentarTomarLease();
    expect(gancho).toHaveBeenCalledTimes(1);

    await liberarLease();
  });

  it('não dispara o gancho enquanto outra instância é a dona', async () => {
    // É o caso do deploy: a instância nova sobe, serve /health e espera.
    rpcMock.mockResolvedValue({ data: false, error: null });
    const gancho = vi.fn();

    iniciarLease(gancho);
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalled());

    expect(souODonoDoGateway()).toBe(false);
    expect(gancho).not.toHaveBeenCalled();

    await liberarLease();
  });

  it('falha no gancho não derruba a posse', async () => {
    // O vigia de canais tenta de novo na passada seguinte; largar a posse
    // por causa de uma reconexão que falhou seria trocar um problema
    // pequeno por um grande.
    rpcMock.mockResolvedValue({ data: true, error: null });
    iniciarLease(() => {
      throw new Error('falha ao reconectar');
    });
    await vi.waitFor(() => expect(souODonoDoGateway()).toBe(true));
    await liberarLease();
  });
});

describe('liberarLease', () => {
  it('entrega a posse e para de se dizer dono', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });
    iniciarLease();
    await vi.waitFor(() => expect(souODonoDoGateway()).toBe(true));

    rpcMock.mockClear();
    await liberarLease();

    expect(souODonoDoGateway()).toBe(false);
    expect(rpcMock).toHaveBeenCalledWith('liberar_lease', { p_instancia: INSTANCIA_ID });
  });

  it('não chama o banco se nunca foi dona', async () => {
    _forcarDono(false);
    await liberarLease();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('falha ao liberar não trava o desligamento', async () => {
    // A posse vence sozinha em segundos. Atrasar o shutdown por causa
    // disso seria pior.
    rpcMock.mockResolvedValue({ data: true, error: null });
    iniciarLease();
    await vi.waitFor(() => expect(souODonoDoGateway()).toBe(true));

    rpcMock.mockRejectedValue(new Error('banco fora'));
    await expect(liberarLease()).resolves.toBeUndefined();
    expect(souODonoDoGateway()).toBe(false);
  });
});
