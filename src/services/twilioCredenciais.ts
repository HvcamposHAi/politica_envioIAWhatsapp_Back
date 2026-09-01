// Resolve as credenciais Twilio (Account SID + Auth Token) e mantém um
// cache em memória — plano "Configuração de Twilio pelo Admin". Quem lê
// isto: TwilioChannel (via registry.ts) e o middleware de assinatura do
// webhook (webhooks/twilio.ts).
//
// GCP_PROJECT_ID setado = modo produção: fonte de verdade é SÓ o Secret
// Manager, sem fallback silencioso pra env var (mascarar secret mal
// configurado é pior do que falhar alto). GCP_PROJECT_ID ausente = modo
// dev local/teste: lê TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN de process.env
// como antes desta mudança — não exige ADC configurado pra `npm run dev`
// nem `npm test`.
import { lerSecret } from '../gcp/secretManager.js';

export interface CredenciaisTwilio {
  accountSid: string;
  authToken: string;
}

const TTL_MS = 5 * 60_000;

let cache: { valor: CredenciaisTwilio; expiraEm: number } | undefined;

export async function obterCredenciaisTwilio(): Promise<CredenciaisTwilio> {
  if (cache && cache.expiraEm > Date.now()) return cache.valor;

  if (!process.env.GCP_PROJECT_ID) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN não configurados (dev local, GCP_PROJECT_ID ausente).');
    }
    cache = { valor: { accountSid, authToken }, expiraEm: Date.now() + TTL_MS };
    return cache.valor;
  }

  const [accountSid, authToken] = await Promise.all([lerSecret('hub-twilio-account-sid'), lerSecret('hub-twilio-auth-token')]);
  if (!accountSid || !authToken) {
    throw new Error('Credenciais Twilio não configuradas. Configure em Configurações > Integrações.');
  }
  cache = { valor: { accountSid, authToken }, expiraEm: Date.now() + TTL_MS };
  return cache.valor;
}

/** Chamado depois de um salvamento bem-sucedido em POST /configuracoes/twilio
 *  — faz a próxima leitura (envio/webhook) pegar a credencial nova na hora,
 *  sem esperar o TTL nem um redeploy. */
export function invalidarCacheCredenciaisTwilio(): void {
  cache = undefined;
}
