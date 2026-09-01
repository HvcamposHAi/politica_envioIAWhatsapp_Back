// Convite/vínculo de acesso para hub.atendentes (plano de convite de
// equipe — Configurações > Equipe não tinha nenhum jeito de transformar
// um cadastro em login funcional; ver migrations_pendentes/
// 20260806140000_hub_convite_acesso.sql para o schema correspondente).
//
// Rotas com responsabilidades distintas:
//   · POST /atendentes/:id/convite — só admin, dispara convite via
//     Supabase Auth Admin API para um atendente que ainda não tem
//     `user_id`.
//   · POST /atendentes/:id/acesso — só admin, cria o login JÁ COM SENHA
//     provisória (caminho alternativo ao convite por e-mail, para quando
//     o e-mail não chega ou a pessoa está ao lado do admin).
//   · POST /atendentes/:id/reset-senha — só admin, redefine a senha de
//     quem já tem acesso. O convite não serve para isso: ele para no 409
//     de "já tem acesso".
//   · POST /atendentes/vincular — qualquer autenticado, só para si
//     mesmo: persiste `user_id` <-> `atendentes.email` (RPC
//     hub.vincular_usuario). O front chama isto em todo login onde
//     `user_id` ainda esteja nulo — idempotente, seguro repetir.
//
// As duas rotas de senha marcam `app_metadata.must_change_password` no
// usuário do Auth. É `app_metadata` e não `user_metadata` de propósito:
// só service_role escreve nele (o próprio usuário não consegue limpar a
// flag chamando updateUser do navegador) e ele viaja dentro do JWT, então
// o front decide o bloqueio de navegação sem uma query a mais. Quem apaga
// a flag é POST /conta/senha (routes/conta.ts), na mesma operação em que
// a senha muda de verdade.
//
// Mesma regra de mensagens.ts: as escritas usam supabaseAdmin
// (service_role, ignora RLS), então a checagem de admin é reimplementada
// aqui em código de aplicação — não existe policy de RLS para isto.
import { Router } from 'express';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { ehEmailJaRegistrado, mensagemErroSenha, validarSenha } from '../auth/senha.js';

export const atendentesRouter = Router();
atendentesRouter.use(requireSupabaseAuth());

const APP_BASE_URL = (process.env.APP_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');

interface AtendenteChamador {
  id: string;
  perfil: string;
}

interface AtendenteAlvo {
  id: string;
  email: string | null;
  user_id: string | null;
  empresa_id?: string | null;
}

// Registro append-only em hub.auditoria. NUNCA recebe o valor da senha —
// só o metadado de que a operação aconteceu, mesmo padrão da troca de
// secret em configuracoes.ts. Falha aqui não desfaz a operação já feita
// no Auth: fica em log e segue.
async function auditar(
  acao: string,
  alvo: AtendenteAlvo,
  chamadorId: string | null,
  depois: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin.from('auditoria').insert({
    acao,
    entidade: 'atendente',
    entidade_id: alvo.id,
    empresa_id: alvo.empresa_id ?? null,
    atendente_id: chamadorId,
    depois,
    origem: 'front',
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao gravar auditoria de ${acao}:`, error.message);
  }
}

// Carrega o alvo e aplica as guardas comuns às rotas de senha. Devolve
// `{ erro, mensagem }` em vez de responder direto para o handler manter o
// controle do fluxo (e do status) — mesmo formato de exigirAdmin() em
// configuracoes.ts.
async function carregarAlvo(id: string): Promise<AtendenteAlvo | { erro: number; mensagem: string }> {
  const { data, error } = await supabaseAdmin
    .from('atendentes')
    .select('id, email, user_id, empresa_id')
    .eq('id', id)
    .maybeSingle<AtendenteAlvo>();
  if (error) return { erro: 500, mensagem: error.message };
  if (!data) return { erro: 404, mensagem: 'Integrante não encontrado.' };
  return data;
}

// Guarda de admin comum às rotas administrativas deste arquivo.
async function exigirAdminChamador(
  req: { auth?: { userId: string; claims: Record<string, unknown> } },
  acao: string,
): Promise<AtendenteChamador | { erro: number; mensagem: string }> {
  const email = req.auth!.claims.email as string | undefined;
  const chamador = await resolverAtendenteChamador(req.auth!.userId, email);
  if (!chamador || chamador.perfil !== 'admin') {
    return { erro: 403, mensagem: `Somente administradores podem ${acao}.` };
  }
  return chamador;
}

// Resolve o atendente do chamador por user_id OU, se ainda não linkado,
// por e-mail da claim do JWT — mesma lógica dual de
// hub.meu_atendente_id() (RLS), reimplementada aqui porque esta rota usa
// supabaseAdmin e não passa pela RLS. Evita o problema do "ovo e a
// galinha": um admin cujo próprio user_id ainda não foi linkado continua
// conseguindo convidar (o link dele acontece em paralelo, via
// /atendentes/vincular, chamado pelo front em todo login).
async function resolverAtendenteChamador(
  userId: string,
  email: string | undefined,
): Promise<AtendenteChamador | null> {
  const filtro = email ? `user_id.eq.${userId},email.ilike.${email}` : `user_id.eq.${userId}`;
  const { data, error } = await supabaseAdmin
    .from('atendentes')
    .select('id, perfil')
    .eq('ativo', true)
    .or(filtro)
    .limit(1)
    .maybeSingle<AtendenteChamador>();
  if (error) throw new Error(`Falha ao resolver atendente do chamador: ${error.message}`);
  return data;
}

atendentesRouter.post('/atendentes/:id/convite', async (req, res) => {
  try {
    const emailChamador = req.auth!.claims.email as string | undefined;
    const chamador = await resolverAtendenteChamador(req.auth!.userId, emailChamador);
    if (!chamador || chamador.perfil !== 'admin') {
      return res.status(403).json({ error: 'Somente administradores podem convidar integrantes.' });
    }

    const { data: alvo, error: erroAlvo } = await supabaseAdmin
      .from('atendentes')
      .select('id, email, user_id')
      .eq('id', req.params.id)
      .maybeSingle<AtendenteAlvo>();
    if (erroAlvo) return res.status(500).json({ error: erroAlvo.message });
    if (!alvo) return res.status(404).json({ error: 'Integrante não encontrado.' });
    if (!alvo.email) return res.status(400).json({ error: 'Este integrante não tem e-mail cadastrado.' });
    if (alvo.user_id) return res.status(409).json({ error: 'Este integrante já tem acesso.' });

    const redirectTo = `${APP_BASE_URL}/definir-senha`;
    const { error: erroConvite } = await supabaseAdmin.auth.admin.inviteUserByEmail(alvo.email, { redirectTo });

    if (erroConvite) {
      // "already registered": já existe auth.users com este e-mail (ex.:
      // convite anterior ainda não confirmado). Reenviar via generateLink
      // em vez de falhar — comportamento exato do reenvio validado em
      // ambiente de teste (plano de implementação, premissa P4).
      const jaRegistrado = /already registered|already exists/i.test(erroConvite.message);
      if (!jaRegistrado) {
        return res.status(502).json({ error: `Falha ao enviar convite: ${erroConvite.message}` });
      }
      const { error: erroLink } = await supabaseAdmin.auth.admin.generateLink({
        type: 'invite',
        email: alvo.email,
        options: { redirectTo },
      });
      if (erroLink) {
        return res.status(502).json({ error: `Falha ao reenviar convite: ${erroLink.message}` });
      }
    }

    const { error: erroUpdate } = await supabaseAdmin
      .from('atendentes')
      .update({ convite_enviado_em: new Date().toISOString() })
      .eq('id', alvo.id);
    if (erroUpdate) return res.status(500).json({ error: erroUpdate.message });

    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Cria o acesso do integrante com uma senha provisória escolhida pelo
// admin. Alternativa ao convite por e-mail (não substitui: /convite segue
// igual), pensada para quando o e-mail não chega ou a pessoa está ao lado.
// A senha é obrigatoriamente descartável — nasce com
// must_change_password, e o front bloqueia a navegação até a troca.
atendentesRouter.post('/atendentes/:id/acesso', async (req, res) => {
  try {
    const chamador = await exigirAdminChamador(req, 'criar acesso de integrantes');
    if ('erro' in chamador) return res.status(chamador.erro).json({ error: chamador.mensagem });

    const alvo = await carregarAlvo(req.params.id);
    if ('erro' in alvo) return res.status(alvo.erro).json({ error: alvo.mensagem });
    if (!alvo.email) return res.status(400).json({ error: 'Este integrante não tem e-mail cadastrado.' });
    if (alvo.user_id) {
      return res.status(409).json({ error: 'Este integrante já tem acesso. Use "Resetar senha".' });
    }

    const senhaValidada = validarSenha(req.body?.senha);
    if (!senhaValidada.ok) return res.status(400).json({ error: senhaValidada.motivo });

    // `email_confirm: true`: o admin está confirmando presencialmente que
    // o e-mail é daquela pessoa. Sem isto o usuário nasce não-confirmado e
    // signInWithPassword é recusado — a senha provisória não serviria para
    // nada. O e-mail em si vem de hub.atendentes, não do corpo do request:
    // hub.meu_perfil() casa atendente por e-mail, e um e-mail divergente
    // entre auth.users e hub.atendentes quebraria a RLS em silêncio.
    const { data: criado, error: erroCriacao } = await supabaseAdmin.auth.admin.createUser({
      email: alvo.email,
      password: senhaValidada.senha,
      email_confirm: true,
      app_metadata: { must_change_password: true },
    });

    if (erroCriacao || !criado?.user) {
      const motivoSenha = mensagemErroSenha(erroCriacao);
      if (motivoSenha) return res.status(400).json({ error: motivoSenha });
      if (ehEmailJaRegistrado(erroCriacao)) {
        return res.status(409).json({
          error:
            'Já existe um usuário com este e-mail no sistema de login (convite anterior?). ' +
            'Peça para a pessoa entrar e clique em "Resetar senha" depois, ou use "Esqueci minha senha" na tela de login.',
        });
      }
      return res.status(502).json({
        error: `Falha ao criar o acesso: ${erroCriacao?.message ?? 'resposta vazia do Supabase Auth'}`,
      });
    }

    // Vínculo direto pelo id do atendente (esta rota sabe qual é), em vez
    // do RPC hub.vincular_usuario, que casa por e-mail e existe para o
    // caminho de login, onde o id não é conhecido. `.is('user_id', null)`
    // preserva a mesma guarda do RPC: não rouba um vínculo já existente.
    const { data: vinculado, error: erroVinculo } = await supabaseAdmin
      .from('atendentes')
      .update({ user_id: criado.user.id })
      .eq('id', alvo.id)
      .is('user_id', null)
      .select('id')
      .maybeSingle<{ id: string }>();

    if (erroVinculo || !vinculado) {
      // Rollback: sem o vínculo, o usuário do Auth seria um órfão — a
      // pessoa conseguiria logar e cairia num app sem atendente
      // correspondente (RLS nega tudo, tela vazia sem explicação). Melhor
      // desfazer e devolver erro do que deixar o meio-termo.
      const { error: erroRollback } = await supabaseAdmin.auth.admin.deleteUser(criado.user.id);
      if (erroRollback) {
        // eslint-disable-next-line no-console
        console.error(
          `[atendentes] ÓRFÃO no Auth: usuário ${criado.user.id} criado mas não vinculado ao atendente ` +
          `${alvo.id}, e o rollback falhou (${erroRollback.message}). Remover manualmente no painel.`,
        );
      }
      return res.status(500).json({
        error: `Falha ao vincular o acesso ao integrante: ${erroVinculo?.message ?? 'o integrante já foi vinculado por outra operação'}`,
      });
    }

    await auditar('acesso.criado_com_senha', alvo, chamador.id, { user_id: criado.user.id });

    res.status(201).json({ user_id: criado.user.id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Redefine a senha de quem JÁ tem acesso, com senha provisória escolhida
// pelo admin. É a única saída quando a pessoa perdeu a senha e o e-mail de
// redefinição não chega — o front também oferece o caminho por e-mail
// (resetPasswordForEmail, client-side, sem passar por aqui).
atendentesRouter.post('/atendentes/:id/reset-senha', async (req, res) => {
  try {
    const chamador = await exigirAdminChamador(req, 'redefinir senha de integrantes');
    if ('erro' in chamador) return res.status(chamador.erro).json({ error: chamador.mensagem });

    const alvo = await carregarAlvo(req.params.id);
    if ('erro' in alvo) return res.status(alvo.erro).json({ error: alvo.mensagem });
    if (!alvo.user_id) {
      return res.status(409).json({ error: 'Este integrante ainda não tem acesso. Use "Criar acesso com senha".' });
    }

    const senhaValidada = validarSenha(req.body?.senha);
    if (!senhaValidada.ok) return res.status(400).json({ error: senhaValidada.motivo });

    const { error: erroUpdate } = await supabaseAdmin.auth.admin.updateUserById(alvo.user_id, {
      password: senhaValidada.senha,
      app_metadata: { must_change_password: true },
    });

    if (erroUpdate) {
      const motivoSenha = mensagemErroSenha(erroUpdate);
      if (motivoSenha) return res.status(400).json({ error: motivoSenha });
      return res.status(502).json({ error: `Falha ao redefinir a senha: ${erroUpdate.message}` });
    }

    await auditar('acesso.senha_redefinida', alvo, chamador.id, { user_id: alvo.user_id });

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

atendentesRouter.post('/atendentes/vincular', async (req, res) => {
  try {
    const email = req.auth!.claims.email as string | undefined;
    if (!email) {
      return res.status(400).json({ error: 'Token sem claim de e-mail — não é possível vincular.' });
    }

    const { data: linked, error } = await supabaseAdmin.rpc('vincular_usuario', {
      p_user_id: req.auth!.userId,
      p_email: email,
    });
    if (error) return res.status(500).json({ error: error.message });

    res.status(200).json({ linked: Boolean(linked) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
