// Configurações administrativas expostas ao front (plano "Configuração de
// Twilio pelo Admin"). Hoje só a credencial Twilio; escrita usa
// supabaseAdmin (service_role, ignora RLS) então a checagem de admin é
// reimplementada aqui em código de aplicação — mesma regra de
// atendentes.ts/mensagens.ts.
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { criarClienteTwilio } from '../channels/twilio.adapter.js';
import { adicionarVersaoSecret } from '../gcp/secretManager.js';
import { obterCredenciaisTwilio, invalidarCacheCredenciaisTwilio } from '../services/twilioCredenciais.js';
import { statusChaveAnthropic, invalidarCacheClienteAnthropic } from '../services/resumoIA.js';

export const configuracoesRouter = Router();
configuracoesRouter.use(requireSupabaseAuth());

interface AtendenteRow {
  id: string;
  perfil: string;
}

async function exigirAdmin(userId: string): Promise<AtendenteRow | { erro: number; mensagem: string }> {
  const { data: atendente, error } = await supabaseAdmin
    .from('atendentes')
    .select('id, perfil')
    .eq('user_id', userId)
    .eq('ativo', true)
    .maybeSingle<AtendenteRow>();
  if (error) return { erro: 500, mensagem: error.message };
  if (!atendente) return { erro: 403, mensagem: 'Usuário autenticado não corresponde a um atendente ativo em hub.atendentes.' };
  if (atendente.perfil !== 'admin') return { erro: 403, mensagem: 'Somente administradores podem configurar integrações.' };
  return atendente;
}

function mascararAccountSid(sid: string): string {
  if (sid.length <= 10) return sid;
  return `${sid.slice(0, 6)}…${sid.slice(-4)}`;
}

configuracoesRouter.get('/configuracoes/twilio', async (req, res) => {
  try {
    const admin = await exigirAdmin(req.auth!.userId);
    if ('erro' in admin) return res.status(admin.erro).json({ error: admin.mensagem });

    // Mesmo accessor que TwilioChannel/webhook usam — nenhuma lógica de
    // "modo GCP vs modo env var" duplicada aqui (ela mora só em
    // services/twilioCredenciais.ts). Erro (nada configurado ainda, ou
    // secret ausente) vira "não configurado", não 500.
    try {
      const { accountSid } = await obterCredenciaisTwilio();
      res.status(200).json({ configurado: true, accountSidMascarado: mascararAccountSid(accountSid) });
    } catch {
      res.status(200).json({ configurado: false });
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface SalvarTwilioBody {
  accountSid?: string;
  authToken?: string;
}

configuracoesRouter.post('/configuracoes/twilio', async (req, res) => {
  try {
    const admin = await exigirAdmin(req.auth!.userId);
    if ('erro' in admin) return res.status(admin.erro).json({ error: admin.mensagem });

    const { accountSid, authToken } = (req.body ?? {}) as SalvarTwilioBody;
    if (!accountSid || !authToken) {
      return res.status(400).json({ error: 'Informe accountSid e authToken.' });
    }
    if (!/^AC[a-f0-9]{32}$/i.test(accountSid)) {
      return res.status(400).json({ error: 'Account SID inválido — deve começar com "AC" e ter 34 caracteres.' });
    }
    if (!/^[a-f0-9]{32}$/i.test(authToken)) {
      return res.status(400).json({ error: 'Auth Token inválido — deve ter 32 caracteres.' });
    }

    // Valida ao vivo contra a Twilio antes de gravar — evita persistir
    // credencial digitada errada e só descobrir no próximo envio.
    try {
      await criarClienteTwilio(accountSid, authToken).api.v2010.accounts(accountSid).fetch();
    } catch (err) {
      return res.status(400).json({ error: `Credencial rejeitada pela Twilio: ${err instanceof Error ? err.message : String(err)}` });
    }

    if (!process.env.GCP_PROJECT_ID) {
      return res.status(500).json({
        error: 'GCP_PROJECT_ID não configurado neste ambiente — não é possível salvar no Secret Manager (modo dev usa TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN no .env).',
      });
    }

    await adicionarVersaoSecret('hub-twilio-account-sid', accountSid);
    await adicionarVersaoSecret('hub-twilio-auth-token', authToken);
    invalidarCacheCredenciaisTwilio();

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Chave da Anthropic (Claude) — usada só por services/resumoIA.ts (resumo de
// IA do card no Kanban). Mesmo molde da Twilio acima: valida ao vivo antes
// de gravar, nunca devolve o valor, grava no Secret Manager (nunca em
// Postgres). Ver plano "Ambiente de Configuração da Chave Anthropic".
configuracoesRouter.get('/configuracoes/anthropic', async (req, res) => {
  try {
    const admin = await exigirAdmin(req.auth!.userId);
    if ('erro' in admin) return res.status(admin.erro).json({ error: admin.mensagem });

    const status = await statusChaveAnthropic();
    res.status(200).json(status);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface SalvarAnthropicBody {
  chave?: string;
}

configuracoesRouter.post('/configuracoes/anthropic', async (req, res) => {
  try {
    const admin = await exigirAdmin(req.auth!.userId);
    if ('erro' in admin) return res.status(admin.erro).json({ error: admin.mensagem });

    const chave = (req.body as SalvarAnthropicBody | undefined)?.chave?.trim();
    if (!chave) {
      return res.status(400).json({ error: 'Informe a chave.' });
    }
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(chave)) {
      return res.status(400).json({ error: 'Chave em formato inválido — deve começar com "sk-ant-".' });
    }

    // Valida ao vivo contra a Anthropic antes de gravar — mesmo racional da
    // Twilio acima. models.list() só exige autenticação e não depende do
    // MODELO usado na geração real de resumos, então um id de modelo errado
    // em produção não aparece aqui como "chave inválida".
    try {
      await new Anthropic({ apiKey: chave, timeout: 10_000 }).models.list();
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 401) {
        return res.status(422).json({ error: 'Chave rejeitada pela Anthropic — confira se está correta e ativa.' });
      }
      return res.status(503).json({
        error: `Não foi possível validar a chave agora (tente de novo): ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!process.env.GCP_PROJECT_ID) {
      return res.status(500).json({
        error:
          'GCP_PROJECT_ID não configurado neste ambiente — não é possível salvar no Secret Manager (modo dev usa ANTHROPIC_API_KEY no .env).',
      });
    }

    await adicionarVersaoSecret('hub-anthropic-api-key', chave);
    invalidarCacheClienteAnthropic();

    // Auditoria (hub.auditoria): nunca grava o valor da chave, só o
    // metadado de que o secret foi trocado. Falha aqui não desfaz o
    // salvamento — só fica registrada em log.
    const { error: erroAuditoria } = await supabaseAdmin.from('auditoria').insert({
      acao: 'segredo.atualizado',
      entidade: 'secret',
      atendente_id: admin.id,
      depois: { secret: 'hub-anthropic-api-key' },
      origem: 'front',
    });
    if (erroAuditoria) {
      // eslint-disable-next-line no-console
      console.error('falha ao gravar auditoria de troca de secret:', erroAuditoria.message);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
