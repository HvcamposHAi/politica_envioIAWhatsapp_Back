// Wrapper fino sobre GCP Secret Manager (plano "Configuração de Twilio
// pelo Admin"). Primeira lib GCP do repo — sem env var pra construir o
// cliente (usa ADC automaticamente: metadata server no Cloud Run, ou
// `gcloud auth application-default login` localmente).
//
// Os secrets em si NÃO são criados por este módulo: exigiria um papel
// amplo (secretmanager.admin) a nível de projeto pra service account do
// backend. Convenção deste repo (ver PLANO_EXECUCAO_CADENCIADO.md A4.1) é
// "binding por secret, nenhum papel de projeto" — os secrets são
// pré-criados manualmente (ver plano) e sa-hub-api só ganha permissão
// nesses secrets específicos.
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

let _client: SecretManagerServiceClient | undefined;

function client(): SecretManagerServiceClient {
  if (!_client) _client = new SecretManagerServiceClient();
  return _client;
}

function projectId(): string {
  const id = process.env.GCP_PROJECT_ID;
  if (!id) {
    throw new Error('GCP_PROJECT_ID não configurado — necessário para acessar o Secret Manager.');
  }
  return id;
}

function caminhoSecret(nome: string): string {
  return `projects/${projectId()}/secrets/${nome}`;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 5;
}

/** Lê a versão mais recente do secret. `null` se o secret existe mas não
 *  tem nenhuma versão ainda, ou se o secret nem existe. */
export async function lerSecret(nome: string): Promise<string | null> {
  try {
    const [versao] = await client().accessSecretVersion({ name: `${caminhoSecret(nome)}/versions/latest` });
    const dado = versao.payload?.data;
    if (!dado) return null;
    return Buffer.isBuffer(dado) ? dado.toString('utf8') : Buffer.from(dado).toString('utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Adiciona uma nova versão a um secret JÁ EXISTENTE (ver cláusulas
 *  manuais do plano — este módulo nunca cria o secret). Erro NOT_FOUND diz
 *  claramente qual secret falta pré-criar, em vez de falhar genérico. */
export async function adicionarVersaoSecret(nome: string, valor: string): Promise<void> {
  try {
    await client().addSecretVersion({
      parent: caminhoSecret(nome),
      payload: { data: Buffer.from(valor, 'utf8') },
    });
  } catch (err) {
    if (isNotFound(err)) {
      throw new Error(
        `Secret '${nome}' não existe em ${caminhoSecret(nome)}. Pré-criar manualmente ` +
          `(gcloud secrets create ${nome} --project=${process.env.GCP_PROJECT_ID} --replication-policy=automatic) ` +
          'antes de salvar pela tela — ver plano de implementação.',
      );
    }
    throw err;
  }
}
