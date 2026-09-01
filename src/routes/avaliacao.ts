// POST /conversas/:id/avaliacao — dispara a pesquisa de satisfação ao cliente
// depois que o chamado foi finalizado.
// PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md, fase 2.
//
// Por que existe uma rota, se finalizar acontece no front direto no Supabase:
// enviar mensagem exige o socket vivo do canal (registry/Baileys), que só o
// hub-api tem. É a mesma divisão do envio normal — dado vai pelo Supabase,
// comando de processo vivo vem pra cá.
import { Router } from 'express';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { obterOuCriarCanal } from '../channels/registry.js';
import { buscarAtendenteAutenticado, conversaNoEscopo } from '../auth/escopoConversa.js';
import { TEXTO_PESQUISA } from '../services/avaliacao.js';

export const avaliacaoRouter = Router();
avaliacaoRouter.use(requireSupabaseAuth());

interface ConversaAvaliacao {
  id: string;
  canal_id: string;
  cliente_id: string;
  fechada_em: string | null;
  avaliacao_solicitada_em: string | null;
  origem_chat: string | null;
  /* Dono e setor: o escopo passou a ser por atendente, não por empresa
   * (2026-08-17). conversaNoEscopo() exige as duas. */
  atendente_id: string | null;
  setor_id: string | null;
  setores: { empresa_id: string | null } | null;
  canais: { empresa_id: string | null } | null;
}

avaliacaoRouter.post('/conversas/:id/avaliacao', async (req, res) => {
  try {
    const conversaId = req.params.id;

    const atendente = await buscarAtendenteAutenticado(req.auth!.userId);
    if (!atendente) {
      return res.status(403).json({ error: 'Usuário autenticado não corresponde a um atendente ativo em hub.atendentes.' });
    }

    const { data: conversa, error: erroConversa } = await supabaseAdmin
      .from('conversas')
      .select(
        'id, canal_id, cliente_id, fechada_em, avaliacao_solicitada_em, origem_chat, atendente_id, setor_id, setores(empresa_id), canais(empresa_id)',
      )
      .eq('id', conversaId)
      .maybeSingle<ConversaAvaliacao>();

    if (erroConversa) return res.status(500).json({ error: erroConversa.message });
    if (!conversa) return res.status(404).json({ error: 'Conversa não encontrada.' });

    if (!(await conversaNoEscopo(atendente, conversa))) {
      return res.status(403).json({ error: 'Conversa fora do escopo deste atendente.' });
    }

    // Pesquisa é sobre atendimento CONCLUÍDO. Pedir nota no meio da conversa
    // seria confuso para o cliente e envenenaria a captura: um "5" respondido
    // com a conversa aberta é assunto em curso, não nota (ver services/avaliacao.ts).
    if (!conversa.fechada_em) {
      return res.status(409).json({ error: 'A conversa ainda não foi finalizada.' });
    }

    // Idempotência: o front dispara isto depois da janela de "Desfazer", e um
    // clique duplo ou um retry de rede não pode render duas pesquisas.
    if (conversa.avaliacao_solicitada_em) {
      return res.status(409).json({ error: 'A pesquisa de satisfação já foi enviada para esta conversa.' });
    }

    const { data: cliente, error: erroCliente } = await supabaseAdmin
      .from('clientes')
      .select('telefone, wa_jid, tipo_chat')
      .eq('id', conversa.cliente_id)
      .single<{ telefone: string; wa_jid: string | null; tipo_chat: string | null }>();

    if (erroCliente || !cliente) {
      return res.status(500).json({ error: erroCliente?.message ?? 'Cliente da conversa não encontrado.' });
    }

    // GRUPO NÃO RECEBE PESQUISA — e esta é a única guarda que faltava no CSAT.
    //
    // As outras automações já excluem grupo (resumo/sentimento em
    // services/mensagens.ts, Alice em services/alice.ts, e a CAPTURA da nota
    // pelo `!ehGrupo` de mensagens.ts). O ENVIO não excluía: finalizar uma
    // conversa de grupo mandava "de 1 a 5, como você avalia..." para dentro do
    // grupo do cliente, na frente de todo mundo — e a resposta nem seria
    // captada, porque a captura ignora grupo. Pesquisa que ninguém pode
    // responder, publicada para uma plateia.
    //
    // Três checagens porque cada fonte falha de um jeito diferente:
    // `origem_chat` é coluna desnormalizada por trigger (pode faltar em linha
    // antiga), `tipo_chat` é a fonte da verdade em hub.clientes, e o sufixo
    // @g.us é o próprio endereço para onde a mensagem iria. Basta uma acusar
    // grupo para barrar.
    const ehGrupo =
      conversa.origem_chat === 'grupo' ||
      cliente.tipo_chat === 'grupo' ||
      (cliente.wa_jid?.endsWith('@g.us') ?? false);

    // 200, não erro: para quem finalizou o chamado não houve falha nenhuma —
    // grupo simplesmente não é atendimento avaliável. Devolver 4xx aqui faria o
    // front mostrar "não foi possível enviar a pesquisa" (lib/finalizacao.ts)
    // toda vez que alguém fechasse um grupo, treinando o time a ignorar o
    // aviso que existe para o caso real de canal caído.
    if (ehGrupo) {
      return res.status(200).json({ status: 'nao_aplicavel', motivo: 'grupo' });
    }

    // RESERVA ANTES DE ENVIAR — a ordem aqui é a defesa contra corrida.
    //
    // O check da linha acima (avaliacao_solicitada_em já preenchido) resolve o
    // caso sequencial, mas não o simultâneo: dois cliques ou um retry de rede
    // passam os dois pela leitura antes de qualquer escrita. Enviar primeiro e
    // marcar depois faria os DOIS mandarem pesquisa ao cliente — e mensagem
    // enviada não se desfaz.
    //
    // O `.select()` é o que torna a guarda real: sem ele, o supabase-js devolve
    // `{data: null, error: null}` tanto para "1 linha atualizada" quanto para
    // "0 linhas, o filtro barrou". Lista vazia = outra requisição chegou antes.
    const agora = new Date().toISOString();
    const { data: reserva, error: erroReserva } = await supabaseAdmin
      .from('conversas')
      .update({ avaliacao_solicitada_em: agora, atualizado_em: agora })
      .eq('id', conversaId)
      .is('avaliacao_solicitada_em', null)
      .select('id');

    if (erroReserva) {
      return res.status(500).json({ error: `Falha ao registrar a pesquisa: ${erroReserva.message}` });
    }
    if (!reserva || reserva.length === 0) {
      return res.status(409).json({ error: 'A pesquisa de satisfação já foi enviada para esta conversa.' });
    }

    const canal = await obterOuCriarCanal(conversa.canal_id);
    const resultado = await canal.enviar({
      conversaId,
      telefone: cliente.telefone,
      waJidDestino: cliente.wa_jid ?? undefined,
      texto: TEXTO_PESQUISA,
    });

    // Envio falhou (canal caído, número inválido): DEVOLVE a reserva. Deixá-la
    // marcada criaria um limbo — pesquisa que o cliente nunca recebeu, que a
    // idempotência impediria de reenviar, e que ainda entraria no denominador
    // da taxa de resposta do Painel.
    if (resultado.status !== 'enviada') {
      const { error: erroDesfazer } = await supabaseAdmin
        .from('conversas')
        .update({ avaliacao_solicitada_em: null })
        .eq('id', conversaId);
      if (erroDesfazer) {
        // eslint-disable-next-line no-console
        console.error(
          `pesquisa não enviada e reserva não desfeita (conversa=${conversaId}) — reenvio ficará bloqueado:`,
          erroDesfazer.message,
        );
      }
      return res.status(502).json({
        error: `Não foi possível enviar a pesquisa pelo canal: ${resultado.erro ?? 'falha no envio'}`,
      });
    }

    // A pergunta entra no histórico do chamado, como qualquer mensagem de
    // saída — é o que dá contexto à nota quando alguém abrir a conversa depois.
    const { error: erroMensagem } = await supabaseAdmin.from('mensagens').insert({
      conversa_id: conversaId,
      wa_message_id: resultado.waMessageId || null,
      autor: 'atendente',
      atendente_id: atendente.id,
      direcao: 'saida',
      texto: TEXTO_PESQUISA,
      status_entrega: 'enviada',
    });
    if (erroMensagem) {
      // eslint-disable-next-line no-console
      console.error(`pesquisa enviada mas falhou ao gravar mensagem (conversa=${conversaId}):`, erroMensagem.message);
    }

    res.status(202).json({ status: 'accepted', solicitadaEm: agora });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
