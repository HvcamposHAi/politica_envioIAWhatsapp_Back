// Teste pontual: wrapper do Secret Manager. Mocka o SDK inteiro — não
// toca rede nem GCP real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accessSecretVersionMock = vi.fn();
const addSecretVersionMock = vi.fn();

vi.mock('@google-cloud/secret-manager', () => ({
  // function, não arrow — arrow function não tem [[Construct]], `new` nela
  // lança "is not a constructor" (SecretManagerServiceClient é instanciada
  // com `new` em secretManager.ts).
  SecretManagerServiceClient: vi.fn(function SecretManagerServiceClientMock() {
    return { accessSecretVersion: accessSecretVersionMock, addSecretVersion: addSecretVersionMock };
  }),
}));

const { lerSecret, adicionarVersaoSecret } = await import('./secretManager.js');

function erroGrpc(code: number): Error {
  const err = new Error('erro grpc simulado') as Error & { code: number };
  err.code = code;
  return err;
}

describe('secretManager', () => {
  beforeEach(() => {
    process.env.GCP_PROJECT_ID = 'projeto-teste';
    accessSecretVersionMock.mockReset();
    addSecretVersionMock.mockReset();
  });

  // process.env é global do processo, não isolado por arquivo de teste —
  // sem isto, GCP_PROJECT_ID vaza pra outros arquivos de teste rodando no
  // mesmo worker (ex.: webhooks/twilio.test.ts, que espera o modo dev/env
  // var por padrão).
  afterEach(() => {
    delete process.env.GCP_PROJECT_ID;
  });

  describe('lerSecret', () => {
    it('retorna o valor decodificado da última versão', async () => {
      accessSecretVersionMock.mockResolvedValue([{ payload: { data: Buffer.from('valor-secreto', 'utf8') } }]);

      const valor = await lerSecret('hub-twilio-account-sid');

      expect(valor).toBe('valor-secreto');
      expect(accessSecretVersionMock).toHaveBeenCalledWith({
        name: 'projects/projeto-teste/secrets/hub-twilio-account-sid/versions/latest',
      });
    });

    it('retorna null quando o secret não existe (NOT_FOUND, code 5)', async () => {
      accessSecretVersionMock.mockRejectedValue(erroGrpc(5));

      const valor = await lerSecret('hub-twilio-account-sid');

      expect(valor).toBeNull();
    });

    it('relança erros que não são NOT_FOUND', async () => {
      accessSecretVersionMock.mockRejectedValue(erroGrpc(7)); // PERMISSION_DENIED

      await expect(lerSecret('hub-twilio-account-sid')).rejects.toThrow('erro grpc simulado');
    });
  });

  describe('adicionarVersaoSecret', () => {
    it('adiciona uma versão nova com os bytes certos', async () => {
      addSecretVersionMock.mockResolvedValue([{}]);

      await adicionarVersaoSecret('hub-twilio-auth-token', 'novo-token');

      expect(addSecretVersionMock).toHaveBeenCalledWith({
        parent: 'projects/projeto-teste/secrets/hub-twilio-auth-token',
        payload: { data: Buffer.from('novo-token', 'utf8') },
      });
    });

    it('NOT_FOUND vira mensagem clara apontando pro passo manual de pré-criação', async () => {
      addSecretVersionMock.mockRejectedValue(erroGrpc(5));

      await expect(adicionarVersaoSecret('hub-twilio-auth-token', 'x')).rejects.toThrow(
        /hub-twilio-auth-token.*não existe/i,
      );
    });
  });
});
