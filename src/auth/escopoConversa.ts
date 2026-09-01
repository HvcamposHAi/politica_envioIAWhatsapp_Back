// Extraído de routes/mensagens.ts (Fase 7, resumo de IA — ver plano "Resumo
// de IA no Kanban") no momento em que uma segunda rota (routes/resumo.ts)
// passou a precisar da mesma checagem. Nenhuma rota deve reimplementar isto
// por conta própria — duas cópias divergem silenciosamente com o tempo.
import { supabaseAdmin } from '../db/client.server.js';

export interface AtendenteRow {
  id: string;
  perfil: string;
}

interface ConversaEscopoFields {
  setores: { empresa_id: string | null } | null;
  canais: { empresa_id: string | null } | null;
  /* Dono e setor da conversa. Passaram a ser obrigatórios em 2026-08-17: o
   * escopo deixou de ser "é da minha empresa" e virou "é minha, ou é de um
   * setor que eu supervisiono". Toda rota que chama `conversaNoEscopo` precisa
   * trazer estas duas colunas no select. */
  atendente_id: string | null;
  setor_id: string | null;
}

/** Exportado para services/alice.ts, que precisa montar o contexto da conversa
 *  com a IA já escopado — o front nunca informa de quais empresas quer dados,
 *  o servidor decide. */
export async function empresasDoAtendente(atendenteId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('atendente_empresas')
    .select('empresa_id')
    .eq('atendente_id', atendenteId);
  if (error) throw new Error(`Falha ao buscar hub.atendente_empresas: ${error.message}`);
  return new Set((data ?? []).map((linha: { empresa_id: string }) => linha.empresa_id));
}

/** Setores que este atendente supervisiona. Espelho de
 *  `hub.meus_setores_supervisionados()`; existe pelo mesmo motivo que
 *  `empresasDoAtendente`: as rotas usam service_role e não passam por policy.
 *
 *  O gate de perfil mora aqui, num lugar só — supervisor rebaixado a operador
 *  perde a visão na hora, sem depender de alguém lembrar de limpar
 *  hub.supervisao. */
export async function setoresSupervisionados(atendente: AtendenteRow): Promise<Set<string>> {
  if (atendente.perfil !== 'supervisor') return new Set();
  const { data, error } = await supabaseAdmin
    .from('supervisao')
    .select('setor_id')
    .eq('supervisor_id', atendente.id);
  if (error) throw new Error(`Falha ao buscar hub.supervisao: ${error.message}`);
  return new Set((data ?? []).map((linha: { setor_id: string }) => linha.setor_id));
}

// Reimplementação, em código de aplicação, de `hub.minhas_conversas()`
// (RLS) — necessária porque rotas que gravam com supabaseAdmin
// (service_role, ignora RLS) não passam pela policy.
//
// MUDOU EM 2026-08-17. Antes a regra aqui era só "o setor OU o canal pertence
// a uma empresa vinculada ao atendente", igual à policy da época — e a policy
// da época era o bug: qualquer atendente da empresa podia agir sobre a
// conversa de qualquer colega. Um operador conseguia responder, pedir resumo e
// gerar coach numa conversa que nem aparecia na tela dele, bastando o id.
// Ver PLANO_GOVERNANCA_ACESSOS.md.
//
// A regra agora, espelhando a RLS nova:
//   admin      -> tudo (hub.sou_admin() curto-circuita a policy)
//   qualquer um-> a conversa é minha (conversas.atendente_id)
//   supervisor -> a conversa está num setor que eu supervisiono
// O escopo de empresa continua valendo por baixo: um setor supervisionado é,
// por construção, de uma empresa vinculada.
export async function conversaNoEscopo(atendente: AtendenteRow, conversa: ConversaEscopoFields): Promise<boolean> {
  if (atendente.perfil === 'admin') return true;

  // Minha, em qualquer perfil.
  if (conversa.atendente_id && conversa.atendente_id === atendente.id) return true;

  if (atendente.perfil === 'supervisor') {
    if (!conversa.setor_id) return false;
    const supervisionados = await setoresSupervisionados(atendente);
    if (!supervisionados.has(conversa.setor_id)) return false;
    // Redundante na prática (setor supervisionado é de empresa vinculada), mas
    // barato e fecha o caso de um vínculo de supervisão órfão sobrevivendo a
    // uma troca de empresa.
    const empresas = await empresasDoAtendente(atendente.id);
    const empresaSetor = conversa.setores?.empresa_id;
    const empresaCanal = conversa.canais?.empresa_id;
    return (!!empresaSetor && empresas.has(empresaSetor)) || (!!empresaCanal && empresas.has(empresaCanal));
  }

  // Operador: só as dele, e a checagem já falhou acima. Perfil desconhecido
  // cai aqui também — fail-closed.
  return false;
}

/**
 * Canal no escopo do atendente. Mesma regra de `conversaNoEscopo` — admin vê
 * tudo, os demais só a empresa vinculada — e existe pelo mesmo motivo: as rotas
 * de canal gravam/comandam com `supabaseAdmin` (service_role, ignora RLS), então
 * a policy não é aplicada e a checagem precisa ser reimplementada aqui.
 *
 * Diferente de `conversaNoEscopo`, esta função LÊ a linha: as rotas de canal
 * recebem só o id na URL e não carregam o canal antes.
 *
 * `null` = canal não existe (a rota traduz para 404, e não para 403: negar por
 * escopo um id que não existe esconderia um erro de digitação do admin).
 */
export async function canalNoEscopo(
  atendente: AtendenteRow,
  canalId: string,
): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin
    .from('canais')
    .select('empresa_id')
    .eq('id', canalId)
    .maybeSingle<{ empresa_id: string | null }>();
  if (error) throw new Error(`Falha ao buscar hub.canais: ${error.message}`);
  if (!data) return null;
  if (atendente.perfil === 'admin') return true;
  if (!data.empresa_id) return false;
  const empresas = await empresasDoAtendente(atendente.id);
  return empresas.has(data.empresa_id);
}

// REGRA DE OURO do plano-base: atendente resolvido por tabela
// (user_id = req.auth.userId), nunca por e-mail nem por claim do JWT.
export async function buscarAtendenteAutenticado(userId: string): Promise<AtendenteRow | null> {
  const { data, error } = await supabaseAdmin
    .from('atendentes')
    .select('id, perfil')
    .eq('user_id', userId)
    .eq('ativo', true)
    .maybeSingle<AtendenteRow>();
  if (error) throw new Error(`Falha ao buscar hub.atendentes: ${error.message}`);
  return data;
}
