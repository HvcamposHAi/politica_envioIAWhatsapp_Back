// POST /conversas/:id/coach/gerar — regeneração manual das respostas sugeridas
// e das orientações de conduta. PLANO_COACH_RESPOSTA_E_CONDUTA.md, §3.3.
//
// A geração automática já acontece sozinha a cada rajada de mensagem do cliente
// (services/mensagens.ts -> agendarAnaliseDebounced). Esta rota cobre os três
// casos em que a automática não basta:
//   · o atendente já respondeu e as sugestões envelheceram;
//   · a conversa tem risco mas ficou sem coach (restart do Cloud Run no meio do
//     debounce — o timer vive em Map de processo);
//   · a chamada anterior à Anthropic falhou.
//
// Roda a análise INTEIRA, não só o coach: é uma chamada só à Anthropic e é o
// comportamento certo — se o risco tiver caído para baixo nesse meio-tempo, o
// banner some junto com as sugestões, em vez de sobrar um alerta obsoleto.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { buscarAtendenteAutenticado, conversaNoEscopo } from '../auth/escopoConversa.js';
import { analisarConversa } from '../services/analiseIA.js';

export const coachRouter = Router();
coachRouter.use(requireSupabaseAuth());

/* Limite próprio, além do global de 300/min do server.ts, pelo mesmo motivo do
 * /alice/chat: cada requisição aqui é uma chamada ao Opus 5. Chaveado pelo
 * usuário autenticado e não pelo IP — numa empresa todo mundo sai pelo mesmo
 * IP, e o limite global puniria o escritório inteiro por causa de um clique
 * nervoso. 6/min é folgado para o uso real (clicar "Atualizar" depois de
 * responder) e apertado para um loop acidental. */
const limitePorUsuario = rateLimit({
  windowMs: 60_000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? req.ip ?? 'anonimo',
  message: { error: 'Muitas gerações seguidas. Aguarde um minuto.' },
});

interface ConversaComEscopo {
  id: string;
  fechada_em: string | null;
  /* Dono e setor: o escopo passou a ser por atendente, não por empresa
   * (2026-08-17). conversaNoEscopo() exige as duas. */
  atendente_id: string | null;
  setor_id: string | null;
  setores: { empresa_id: string | null } | null;
  canais: { empresa_id: string | null } | null;
}

interface CoachConversa {
  risco: string | null;
  risco_motivo: string | null;
  coach_sugestoes: string[] | null;
  coach_orientacoes: string[] | null;
  coach_atualizado_em: string | null;
  analise_ia_erro: string | null;
}

coachRouter.post('/conversas/:id/coach/gerar', limitePorUsuario, async (req, res) => {
  try {
    const conversaId = req.params.id;

    const atendente = await buscarAtendenteAutenticado(req.auth!.userId);
    if (!atendente) {
      return res.status(403).json({ error: 'Usuário autenticado não corresponde a um atendente ativo em hub.atendentes.' });
    }

    const { data: conversa, error: erroConversa } = await supabaseAdmin
      .from('conversas')
      .select('id, fechada_em, atendente_id, setor_id, setores(empresa_id), canais(empresa_id)')
      .eq('id', conversaId)
      .maybeSingle<ConversaComEscopo>();

    if (erroConversa) return res.status(500).json({ error: erroConversa.message });
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });

    if (!(await conversaNoEscopo(atendente, conversa))) {
      return res.status(403).json({ error: 'Conversa fora do escopo deste atendente.' });
    }

    // Coach é sobre o que ainda dá para evitar. Em conversa fechada o serviço
    // zeraria tudo de novo logo em seguida — gastar uma chamada ao Opus 5 para
    // isso é só custo.
    if (conversa.fechada_em) {
      return res.status(409).json({ error: 'A conversa já foi finalizada.' });
    }

    // Diferente do disparo automático (fire-and-forget): aqui tem um humano
    // esperando na tela, então esperamos o resultado.
    await analisarConversa(conversaId);

    const { data: atualizada, error: erroAtualizada } = await supabaseAdmin
      .from('conversas')
      .select('risco, risco_motivo, coach_sugestoes, coach_orientacoes, coach_atualizado_em, analise_ia_erro')
      .eq('id', conversaId)
      .single<CoachConversa>();

    if (erroAtualizada || !atualizada) {
      return res.status(500).json({ error: erroAtualizada?.message ?? 'Falha ao ler o coach atualizado.' });
    }

    // analisarConversa NUNCA relança, por contrato — a falha vai para a coluna.
    // Sem esta checagem a rota responderia 200 com lista vazia, e a tela diria
    // "não há sugestões" quando o certo é "não deu para gerar". É a mesma
    // classe de erro do alerta que falhava em verde.
    if (atualizada.analise_ia_erro) {
      return res.status(502).json({ error: atualizada.analise_ia_erro });
    }

    res.status(200).json({
      risco: atualizada.risco,
      risco_motivo: atualizada.risco_motivo,
      coach_sugestoes: atualizada.coach_sugestoes,
      coach_orientacoes: atualizada.coach_orientacoes,
      coach_atualizado_em: atualizada.coach_atualizado_em,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
