// POST /conversas/:id/resumo/gerar — regeneração manual do resumo de IA
// (botão "Gerar novamente" no dialog do Kanban, ver plano "Resumo de IA no
// Kanban de Chamados"). A geração automática por mensagem recebida já
// acontece sozinha (services/mensagens.ts -> agendarResumoDebounced); esta
// rota só cobre o atendente pedindo explicitamente uma atualização.
import { Router } from 'express';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { buscarAtendenteAutenticado, conversaNoEscopo } from '../auth/escopoConversa.js';
import { gerarResumoConversa } from '../services/resumoIA.js';

export const resumoRouter = Router();
resumoRouter.use(requireSupabaseAuth());

interface ConversaComEscopo {
  id: string;
  /* Dono e setor: o escopo passou a ser por atendente, não por empresa
   * (2026-08-17). conversaNoEscopo() exige as duas. */
  atendente_id: string | null;
  setor_id: string | null;
  setores: { empresa_id: string | null } | null;
  canais: { empresa_id: string | null } | null;
}

interface ResumoConversa {
  resumo_ia: string | null;
  resumo_ia_status: string;
  resumo_ia_gerado_em: string | null;
  resumo_ia_mensagens_count: number | null;
  resumo_ia_erro: string | null;
  // Gerado na mesma chamada do resumo (services/resumoIA.ts) — devolvido aqui
  // para o dialog do Kanban atualizar o título junto, sem recarregar o board.
  titulo_ia: string | null;
  titulo_ia_gerado_em: string | null;
}

resumoRouter.post('/conversas/:id/resumo/gerar', async (req, res) => {
  try {
    const conversaId = req.params.id;

    // Mesma REGRA DE OURO de routes/mensagens.ts: atendente por tabela, não
    // por e-mail nem claim do JWT.
    const atendente = await buscarAtendenteAutenticado(req.auth!.userId);
    if (!atendente) {
      return res.status(403).json({ error: 'Usuário autenticado não corresponde a um atendente ativo em hub.atendentes.' });
    }

    const { data: conversa, error: erroConversa } = await supabaseAdmin
      .from('conversas')
      .select('id, atendente_id, setor_id, setores(empresa_id), canais(empresa_id)')
      .eq('id', conversaId)
      .maybeSingle<ConversaComEscopo>();

    if (erroConversa) {
      return res.status(500).json({ error: erroConversa.message });
    }
    if (!conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada.' });
    }
    if (!(await conversaNoEscopo(atendente, conversa))) {
      return res.status(403).json({ error: 'Conversa fora do escopo deste atendente.' });
    }

    // Diferente do disparo automático (fire-and-forget): aqui o atendente
    // pediu explicitamente, então esperamos o resultado para devolver no
    // corpo da resposta.
    await gerarResumoConversa(conversaId);

    const { data: atualizada, error: erroAtualizada } = await supabaseAdmin
      .from('conversas')
      .select(
        'resumo_ia, resumo_ia_status, resumo_ia_gerado_em, resumo_ia_mensagens_count, resumo_ia_erro, titulo_ia, titulo_ia_gerado_em',
      )
      .eq('id', conversaId)
      .single<ResumoConversa>();

    if (erroAtualizada || !atualizada) {
      return res.status(500).json({ error: erroAtualizada?.message ?? 'Falha ao ler resumo atualizado.' });
    }

    res.status(200).json(atualizada);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
