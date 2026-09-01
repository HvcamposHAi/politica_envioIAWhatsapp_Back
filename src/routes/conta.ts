// Conta do próprio usuário autenticado (plano "Senha no cadastro, reset e
// troca no primeiro acesso" §3.2).
//
//   · POST /conta/senha — o usuário troca a própria senha.
//
// POR QUE ESTA ROTA EXISTE, se o front consegue chamar
// supabase.auth.updateUser({ password }) sozinho com a anon key:
// a troca precisa apagar `app_metadata.must_change_password`, e
// app_metadata só é gravável por service_role. Se o front trocasse a senha
// pelo client e chamasse uma segunda rota "já troquei, limpe a flag",
// bastaria chamar a segunda rota direto (curl, devtools) para escapar da
// troca obrigatória. Aqui as duas coisas são a MESMA chamada
// (updateUserById com password + app_metadata), e ainda exigem a senha
// atual — quem não sabe a senha vigente não limpa a flag, e quem sabe só
// limpa trocando de verdade (senha nova diferente da atual é validada).
//
// A senha nunca é logada nem auditada — hub.auditoria recebe só o
// metadado da ação, mesmo padrão de configuracoes.ts.
import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { createSupabaseFetch, requireSupabaseAuth } from '../auth/middleware.js';
import { mensagemErroSenha, validarSenha } from '../auth/senha.js';
import { supabaseAdmin } from '../db/client.server.js';
import type { Database } from '../db/types.js';

export const contaRouter = Router();
contaRouter.use(requireSupabaseAuth());

/**
 * Confere a senha atual tentando um login real contra o GoTrue. Não há API
 * de "verificar senha" no Supabase — signInWithPassword é o caminho
 * suportado. O client é efêmero e `persistSession: false`, então a sessão
 * criada não é guardada em lugar nenhum; ainda assim ela é revogada logo
 * depois (signOut) para não deixar refresh tokens acumulando a cada
 * tentativa.
 *
 * `realtime.transport`: mesma armadilha documentada em auth/middleware.ts —
 * em Node 20 o construtor do SupabaseClient monta um RealtimeClient que
 * resolve o WebSocket de forma eager, e sem WebSocket global createClient()
 * lança na hora (incidente 2026-08-07).
 */
async function senhaAtualConfere(email: string, senha: string): Promise<boolean> {
  const SUPABASE_URL = process.env.SUPABASE_URL!;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY!;

  const cliente = createClient<Database, 'hub'>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    db: { schema: 'hub' },
    global: { fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY) },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as any },
  });

  const { data, error } = await cliente.auth.signInWithPassword({ email, password: senha });
  if (error || !data?.session) return false;

  try {
    await cliente.auth.signOut();
  } catch {
    // Revogar é higiene, não requisito: o token não foi persistido em
    // lugar nenhum e expira sozinho. Falhar aqui não pode derrubar a troca.
  }
  return true;
}

contaRouter.post('/conta/senha', async (req, res) => {
  try {
    const email = req.auth!.claims.email as string | undefined;
    if (!email) {
      return res.status(400).json({ error: 'Token sem claim de e-mail — não é possível trocar a senha.' });
    }

    const senhaAtual = req.body?.senha_atual;
    if (typeof senhaAtual !== 'string' || senhaAtual.length === 0) {
      return res.status(400).json({ error: 'Informe a senha atual.' });
    }

    const senhaNova = validarSenha(req.body?.senha_nova);
    if (!senhaNova.ok) return res.status(400).json({ error: senhaNova.motivo });

    // Antes de gastar uma ida ao GoTrue: trocar a senha por ela mesma
    // seria o caminho óbvio para limpar a flag sem trocar nada.
    if (senhaNova.senha === senhaAtual) {
      return res.status(400).json({ error: 'A nova senha precisa ser diferente da atual.' });
    }

    if (!(await senhaAtualConfere(email, senhaAtual))) {
      return res.status(400).json({ error: 'Senha atual incorreta.' });
    }

    const { error: erroUpdate } = await supabaseAdmin.auth.admin.updateUserById(req.auth!.userId, {
      password: senhaNova.senha,
      app_metadata: { must_change_password: false },
    });

    if (erroUpdate) {
      const motivoSenha = mensagemErroSenha(erroUpdate);
      if (motivoSenha) return res.status(400).json({ error: motivoSenha });
      return res.status(502).json({ error: `Falha ao trocar a senha: ${erroUpdate.message}` });
    }

    // Auditoria best-effort: o atendente pode nem estar vinculado ainda
    // (`user_id` nulo), e isso não é motivo para falhar uma troca de senha
    // já efetivada no Auth.
    const { data: atendente } = await supabaseAdmin
      .from('atendentes')
      .select('id, empresa_id')
      .eq('user_id', req.auth!.userId)
      .maybeSingle<{ id: string; empresa_id: string | null }>();

    const { error: erroAuditoria } = await supabaseAdmin.from('auditoria').insert({
      acao: 'acesso.senha_trocada_pelo_usuario',
      entidade: 'atendente',
      entidade_id: atendente?.id ?? null,
      empresa_id: atendente?.empresa_id ?? null,
      atendente_id: atendente?.id ?? null,
      depois: { user_id: req.auth!.userId },
      origem: 'front',
    });
    if (erroAuditoria) {
      // eslint-disable-next-line no-console
      console.error('falha ao gravar auditoria de troca de senha:', erroAuditoria.message);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
