// Teste pontual: incidente 2026-08-07 (falha transitória "fetch failed" ao
// gravar hub.canal_sessoes derrubava o processo Node inteiro, no meio do
// handshake de pareamento por QR — confirmado em produção via gcloud
// logging read). persistir() não pode mais lançar: precisa reter (blip
// passageiro) e, na pior hipótese, logar e desistir sem derrubar o
// processo.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let upsertMock: ReturnType<typeof vi.fn>;
let selectResultado: { data: unknown; error: null };

vi.mock('../db/client.server.js', () => ({
  get supabaseAdmin() {
    return {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockImplementation(async () => selectResultado),
          })),
        })),
        upsert: upsertMock,
      })),
    };
  },
}));

const { usePostgresAuthState } = await import('./auth-state.postgres.js');

describe('usePostgresAuthState — resiliência de persistir() (incidente 2026-08-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    selectResultado = { data: null, error: null }; // sessão nova, sem creds salvos
  });

  it('falha transitória (1x) seguida de sucesso: saveCreds() resolve sem lançar, upsert chamado 2x', async () => {
    upsertMock = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: 'fetch failed' } })
      .mockResolvedValueOnce({ error: null });

    const { saveCreds } = await usePostgresAuthState('canal-1');

    const promessa = saveCreds();
    await vi.runAllTimersAsync();
    await expect(promessa).resolves.toBeUndefined();

    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  it('falha persistente (3x): saveCreds() resolve mesmo assim, sem lançar — não pode derrubar o processo', async () => {
    upsertMock = vi.fn().mockResolvedValue({ error: { message: 'fetch failed' } });
    const erroConsole = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { saveCreds } = await usePostgresAuthState('canal-2');

    const promessa = saveCreds();
    await vi.runAllTimersAsync();
    await expect(promessa).resolves.toBeUndefined();

    expect(upsertMock).toHaveBeenCalledTimes(3);
    expect(erroConsole).toHaveBeenCalledWith(expect.stringContaining('falha ao persistir hub.canal_sessoes'));
    erroConsole.mockRestore();
  });

  it('sucesso na primeira tentativa: upsert chamado só 1x', async () => {
    upsertMock = vi.fn().mockResolvedValue({ error: null });

    const { saveCreds } = await usePostgresAuthState('canal-3');
    await saveCreds();

    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});
