// Pesquisa de satisfação (CSAT) enviada ao cliente quando o chamado é
// finalizado, e captura da nota que ele responde.
// PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md, fase 2.
//
// A nota alimenta hub.conversas.nota_satisfacao — coluna que já existia e já
// era lida pelo Painel ("Nota média") desde sempre, sem nunca ter tido produtor.
//
// O ponto delicado desta feature é a CAPTURA. A resposta do cliente chega como
// uma mensagem comum de WhatsApp, no mesmo pipeline de qualquer outra, e o
// comportamento padrão desse pipeline é abrir uma conversa nova. Por isso a
// captura roda ANTES de resolverConversaAberta() e é deliberadamente
// conservadora: na dúvida, devolve o controle ao fluxo normal e a mensagem
// vira conversa. Perder uma nota é barato; sequestrar uma mensagem de negócio
// ("quero fazer um pedido") para dentro de um chamado fechado, não.

import { supabaseAdmin } from '../db/client.server.js';

/** Janela em que a resposta do cliente ainda é lida como nota. Depois disso,
 *  um "5" solto é muito mais provavelmente o começo de um assunto novo do que
 *  a resposta a uma pesquisa de dois dias atrás. */
export const JANELA_AVALIACAO_HORAS = 48;

export const TEXTO_PESQUISA =
  'Obrigado pelo contato! De 1 a 5, como você avalia este atendimento? Responda apenas com o número.';

export const TEXTO_AGRADECIMENTO = 'Obrigado pela sua avaliação!';

/**
 * Converte a resposta do cliente em nota, ou null se não for uma nota.
 *
 * Regra estreita de propósito: **um único dígito de 1 a 5, isolado**. Aceita
 * espaço em volta e nada mais. "nota 4", "4 estrelas", "10", "5." e "4/5"
 * devolvem null e seguem como mensagem comum.
 *
 * A tentação aqui é extrair o primeiro dígito que aparecer no texto. Isso
 * transformaria "quero 2 sacas de milho" em nota 2 e engoliria um pedido.
 */
export function parseNotaAvaliacao(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpo = texto.trim();
  if (!/^[1-5]$/.test(limpo)) return null;
  return Number(limpo);
}

interface AvaliacaoPendente {
  id: string;
  avaliacao_solicitada_em: string;
}

/** Conversa fechada deste cliente/canal que pediu avaliação, ainda não
 *  respondeu e está dentro da janela. Usa o índice parcial
 *  conversas_avaliacao_pendente_idx. */
async function buscarPendente(clienteId: string, canalId: string): Promise<AvaliacaoPendente | null> {
  const limite = new Date(Date.now() - JANELA_AVALIACAO_HORAS * 3600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('conversas')
    .select('id, avaliacao_solicitada_em')
    .eq('cliente_id', clienteId)
    .eq('canal_id', canalId)
    .not('avaliacao_solicitada_em', 'is', null)
    .is('nota_satisfacao', null)
    .gte('avaliacao_solicitada_em', limite)
    .order('avaliacao_solicitada_em', { ascending: false })
    .limit(1)
    .maybeSingle<AvaliacaoPendente>();

  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao buscar avaliação pendente (cliente=${clienteId}):`, error.message);
    return null;
  }
  return data ?? null;
}

export interface ResultadoCaptura {
  /** true = a mensagem foi consumida como nota; quem chamou deve PARAR e não
   *  abrir conversa nova. false = segue o fluxo normal. */
  capturada: boolean;
  conversaId?: string;
  nota?: number;
  /** true quando esta mensagem é REENTREGA de uma nota já registrada. Também
   *  consome a mensagem (capturada=true), mas quem chamou não deve agradecer
   *  de novo — o cliente já recebeu o agradecimento na primeira entrega. */
  reentrega?: boolean;
}

/** O Baileys reemite `messages.upsert` depois de reconectar. No fluxo normal
 *  isso é inofensivo: o unique de `wa_message_id` transforma o insert repetido
 *  em no-op. O fluxo de avaliação não tem essa proteção — se a reentrega
 *  cair no caminho normal, `resolverConversaAberta` cria uma CONVERSA
 *  FANTASMA (vazia, porque o insert da mensagem em seguida vira no-op) para
 *  um cliente que só respondeu uma pesquisa. Esta checagem fecha isso.
 *
 *  Exportada para services/mensagens.ts, que precisa da MESMA pergunta para o
 *  eco `fromMe` de mensagem enviada a chamado já fechado (auditoria
 *  2026-08-09, item 6b). A direção do import é mensagens.ts -> avaliacao.ts,
 *  que já existe (TEXTO_AGRADECIMENTO, tentarRegistrarAvaliacao) — não cria
 *  ciclo. Consulta deliberadamente GLOBAL (sem conversa_id): a pergunta é
 *  "este id já foi visto em algum lugar", não "nesta conversa". */
export async function mensagemJaRegistrada(waMessageId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('mensagens')
    .select('id')
    .eq('wa_message_id', waMessageId)
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao checar reentrega de mensagem (wa_message_id=${waMessageId}):`, error.message);
    return false;
  }
  return !!data;
}

/**
 * Tenta interpretar uma mensagem de entrada como resposta à pesquisa de
 * satisfação.
 *
 * Devolve `{capturada: false}` em todos os casos duvidosos — sem pendência,
 * texto que não é nota, janela expirada, erro de banco. A mensagem nunca é
 * descartada: ou vira nota (e é gravada na conversa fechada, preservando o
 * histórico), ou volta para o pipeline e vira conversa.
 *
 * Nunca relança: uma falha aqui não pode impedir a mensagem do cliente de ser
 * processada.
 */
export async function tentarRegistrarAvaliacao(
  clienteId: string,
  canalId: string,
  texto: string | null | undefined,
  waMessageId?: string,
): Promise<ResultadoCaptura> {
  try {
    // Ordem importa por custo: o parse é local e descarta a esmagadora
    // maioria das mensagens antes de qualquer ida ao banco.
    const nota = parseNotaAvaliacao(texto);
    if (nota === null) return { capturada: false };

    const pendente = await buscarPendente(clienteId, canalId);
    if (!pendente) {
      // Sem pendência e o texto é uma nota: ou o cliente mandou "5" do nada
      // (segue o fluxo normal e vira conversa, correto), ou é a reentrega de
      // uma nota que já foi registrada — e aí a pendência sumiu justamente
      // porque nós a resolvemos. Distinguir os dois exige olhar se esta
      // mensagem já está no banco.
      if (waMessageId && (await mensagemJaRegistrada(waMessageId))) {
        return { capturada: true, reentrega: true };
      }
      return { capturada: false };
    }

    const agora = new Date().toISOString();
    // O `.select()` é o que faz a guarda de corrida valer: sem ele o
    // supabase-js devolve `{data: null, error: null}` tanto quando gravou
    // quanto quando o filtro `.is(null)` barrou. Sem distinguir os dois, duas
    // respostas simultâneas resultariam em dois agradecimentos ao cliente e um
    // insert duplicado de mensagem.
    const { data: gravadas, error: erroUpdate } = await supabaseAdmin
      .from('conversas')
      .update({
        nota_satisfacao: nota,
        avaliacao_registrada_em: agora,
        atualizado_em: agora,
      })
      .eq('id', pendente.id)
      .is('nota_satisfacao', null)
      .select('id');

    if (erroUpdate) {
      // eslint-disable-next-line no-console
      console.error(`falha ao gravar nota_satisfacao (conversa=${pendente.id}):`, erroUpdate.message);
      return { capturada: false };
    }

    // Outra entrega da mesma resposta venceu a corrida: a nota está gravada
    // (por ela), então consumimos a mensagem sem agradecer de novo.
    if (!gravadas || gravadas.length === 0) {
      return { capturada: true, conversaId: pendente.id, reentrega: true };
    }

    // A mensagem do cliente entra no histórico da conversa fechada — sem
    // isso, a nota apareceria no Painel sem rastro de onde veio.
    const { error: erroMensagem } = await supabaseAdmin.from('mensagens').insert({
      conversa_id: pendente.id,
      wa_message_id: waMessageId ?? null,
      autor: 'cliente',
      direcao: 'entrada',
      texto: String(nota),
      status_entrega: 'entregue',
    });
    if (erroMensagem) {
      // Nota já gravada; o histórico é secundário. Loga e segue.
      // eslint-disable-next-line no-console
      console.error(`nota gravada mas falhou ao inserir mensagem (conversa=${pendente.id}):`, erroMensagem.message);
    }

    return { capturada: true, conversaId: pendente.id, nota };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('falha inesperada ao registrar avaliação:', err instanceof Error ? err.message : String(err));
    return { capturada: false };
  }
}
