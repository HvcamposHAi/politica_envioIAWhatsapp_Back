// Teste pontual: cache + régua "modo GCP vs modo env var" de
// obterCredenciaisTwilio(). Mocka gcp/secretManager.js — não toca GCP real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lerSecretMock = vi.fn();

vi.mock('../gcp/secretManager.js', () => ({ lerSecret: lerSecretMock }));

const { obterCredenciaisTwilio, invalidarCacheCredenciaisTwilio } = await import('./twilioCredenciais.js');

describe('obterCredenciaisTwilio', () => {
  beforeEach(() => {
    lerSecretMock.mockReset();
    invalidarCacheCredenciaisTwilio();
  });

  afterEach(() => {
    delete process.env.GCP_PROJECT_ID;
  });

  describe('modo GCP (GCP_PROJECT_ID setado)', () => {
    beforeEach(() => {
      process.env.GCP_PROJECT_ID = 'projeto-teste';
    });

    it('lê do Secret Manager e devolve as credenciais', async () => {
      lerSecretMock.mockImplementation((nome: string) =>
        Promise.resolve(nome === 'hub-twilio-account-sid' ? 'ACabc' : 'token123'),
      );

      const credenciais = await obterCredenciaisTwilio();

      expect(credenciais).toEqual({ accountSid: 'ACabc', authToken: 'token123' });
    });

    it('usa cache — segunda chamada não bate no Secret Manager de novo', async () => {
      lerSecretMock.mockImplementation((nome: string) =>
        Promise.resolve(nome === 'hub-twilio-account-sid' ? 'ACabc' : 'token123'),
      );

      await obterCredenciaisTwilio();
      lerSecretMock.mockClear();
      await obterCredenciaisTwilio();

      expect(lerSecretMock).not.toHaveBeenCalled();
    });

    it('invalidarCacheCredenciaisTwilio() força nova leitura', async () => {
      lerSecretMock.mockImplementation((nome: string) =>
        Promise.resolve(nome === 'hub-twilio-account-sid' ? 'ACabc' : 'token123'),
      );

      await obterCredenciaisTwilio();
      invalidarCacheCredenciaisTwilio();
      lerSecretMock.mockImplementation((nome: string) =>
        Promise.resolve(nome === 'hub-twilio-account-sid' ? 'ACnovo' : 'tokenNovo'),
      );
      const credenciais = await obterCredenciaisTwilio();

      expect(credenciais).toEqual({ accountSid: 'ACnovo', authToken: 'tokenNovo' });
    });

    it('lança erro claro quando algum secret não tem valor', async () => {
      lerSecretMock.mockResolvedValue(null);

      await expect(obterCredenciaisTwilio()).rejects.toThrow(/não configuradas/i);
    });
  });

  describe('modo dev local (GCP_PROJECT_ID ausente)', () => {
    it('lê de process.env.TWILIO_* sem tocar no Secret Manager', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'ACenv';
      process.env.TWILIO_AUTH_TOKEN = 'tokenEnv';

      const credenciais = await obterCredenciaisTwilio();

      expect(credenciais).toEqual({ accountSid: 'ACenv', authToken: 'tokenEnv' });
      expect(lerSecretMock).not.toHaveBeenCalled();

      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
    });
  });
});
