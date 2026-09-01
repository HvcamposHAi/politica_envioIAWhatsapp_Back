// Handler central do fluxo de mensagem (Fase 5, miolo). É isto que
// transforma um EventoRecebido do ChannelPort em linha em hub.mensagens —
// único lugar que sabe resolver cliente/conversa a partir de um evento de
// canal. Adapters e rotas não duplicam esta lógica.
//
// Usado nos dois sentidos: mensagem de cliente (origem='cliente') e eco de
// mensagem que o próprio atendente mandou direto pelo celular pareado
// (origem='atendente', `fromMe` do Baileys) — ver channels/registry.ts.

import { supabaseAdmin } from '../db/client.server.js';
import type { EventoRecebido } from '../channels/port.js';
import { TIPOS_COM_MIDIA } from '../channels/mensagemWhatsApp.js';
import { agendarResumoDebounced } from './resumoIA.js';
import { agendarAnaliseDebounced } from './analiseIA.js';
import { TEXTO_AGRADECIMENTO, mensagemJaRegistrada, tentarRegistrarAvaliacao } from './avaliacao.js';
import { obterOuCriarCanal } from '../channels/registry.js';
import { enfileirarMidia } from './filaMidia.js';
import { apagar as apagarObjeto } from './midiaStorage.js';

const UNIQUE_VIOLATION = '23505';

// NOTA: o plano previa `hub.normalizar_telefone` via rpc, mas essa função
// não existe em nenhuma migration do schema `hub` (conferido em
// supabase/migrations/*.sql). Normalizando aqui com a mesma regra: 10/11
// dígitos é DDD + número local (sem código de país) e ganha o prefixo 55;
// 12/13 dígitos já vem completo. Contagem de dígitos, não prefixo — DDD 55
// (Santa Maria/RS) faria um match por prefixo errar.
export function normalizarTelefone(bruto: string): string {
  const digitos = bruto.replace(/\D/g, '');
  return digitos.length === 10 || digitos.length === 11 ? `55${digitos}` : digitos;
}

/**
 * A data/hora em que a mensagem foi enviada DE VERDADE — não a hora em que nós
 * a processamos.
 *
 * O adapter já resolvia isto do `messageTimestamp` do WhatsApp
 * (channels/baileys.adapter.ts) e punha em `EventoRecebido.recebidoEm`, e o
 * valor era jogado fora: o insert não mencionava `enviada_em`, que caía no
 * `default now()` do DDL. Enquanto tudo chega em tempo real a diferença é de
 * milissegundos; o problema é o BACKLOG. O Baileys entrega de uma vez o que
 * chegou enquanto a sessão esteve fora, e este processo reinicia a cada deploy
 * do Cloud Run — então a tarde inteira do cliente entrava com o mesmo carimbo,
 * o da reconexão. Isso empilhava o fio fora de ordem, congelava os indicadores
 * de espera e fazia a IA ler uma janela que não existiu.
 *
 * CLAMP no futuro, nunca no passado. O timestamp vem do relógio do APARELHO do
 * cliente: passado antigo é legítimo (é o backlog), futuro nunca é — e um
 * celular adiantado pregaria a conversa no topo da Caixa até o mundo alcançar
 * o relógio dele. A mesma regra é repetida em hub.tocar_conversa porque esta
 * função não é a única porta de escrita.
 */
export function instanteDaMensagem(recebidoEm: Date | undefined, agora = new Date()): string {
  const t = recebidoEm?.getTime();
  if (!t || !Number.isFinite(t) || t <= 0) return agora.toISOString();
  return new Date(Math.min(t, agora.getTime())).toISOString();
}

interface CanalContexto {
  id: string;
  empresaId: string;
  setorId: string | null;
  /** Linha pessoal: quando o canal tem atendente responsável, toda conversa
   *  nova nasce com ele como dono (aba "Meus"), em vez de "Sem dono" no
   *  setor. NULL = linha de equipe (comportamento clássico). */
  atendenteId: string | null;
}

async function buscarContextoCanal(canalId: string): Promise<CanalContexto> {
  const { data, error } = await supabaseAdmin
    .from('canais')
    .select('id, empresa_id, setor_id, atendente_id')
    .eq('id', canalId)
    .single();

  if (error || !data) {
    throw new Error(`Canal ${canalId} não encontrado em hub.canais: ${error?.message ?? 'sem dados'}`);
  }
  if (!data.empresa_id) {
    throw new Error(`Canal ${canalId} sem empresa_id em hub.canais — não dá para resolver cliente.`);
  }
  return {
    id: data.id,
    empresaId: data.empresa_id,
    setorId: data.setor_id ?? null,
    atendenteId: data.atendente_id ?? null,
  };
}

/** Acima deste tamanho, `telefone` não é um número BR real — é o resíduo de
 *  um ID `@lid` cru gravado antes do fix de identificação (PLANO_CORRECAO_
 *  IDENTIFICACAO_LID_WHATSAPP.md §5.3). BR completo (55+DDD+número) tem no
 *  máximo 13 dígitos, mesma regra de `normalizarTelefone`. */
const TAMANHO_MAXIMO_TELEFONE_BR = 13;

async function aplicarCorrecoes(
  clienteId: string,
  patch: Record<string, string>,
): Promise<void> {
  if (!Object.keys(patch).length) return;
  const { error } = await supabaseAdmin.from('clientes').update(patch).eq('id', clienteId);
  if (error) {
    // Log, não throw: não perder a mensagem por causa de uma correção de
    // cadastro que pode ser tentada de novo na próxima mensagem.
    // eslint-disable-next-line no-console
    console.error(`falha ao corrigir hub.clientes (${clienteId}): ${error.message}`);
  }
}

async function resolverCliente(
  empresaId: string,
  telefone: string,
  nomeContatoBruto: string | undefined,
  waJidOrigem: string | undefined,
): Promise<string> {
  // Trim defensivo aqui, não só nos adapters: esta função é o único funil
  // que grava hub.clientes (comentário no topo do arquivo) — um adapter
  // futuro que esqueça de aparar espaço não deve conseguir gravar um nome
  // "   " como se fosse válido.
  const nomeContato = nomeContatoBruto?.trim() || undefined;

  // 1) Contato já visto por este JID técnico — cobre tanto um cliente @lid
  // já corrigido quanto um histórico marcado pelo backfill manual (§5.3).
  // Precisa vir ANTES da busca por telefone: é o que evita que um contato
  // @lid conhecido vire um cliente novo assim que o telefone real aparecer
  // pela primeira vez (senderPn), fragmentando o histórico da conversa.
  if (waJidOrigem) {
    const { data: porJid, error: erroPorJid } = await supabaseAdmin
      .from('clientes')
      .select('id, nome, telefone')
      .eq('empresa_id', empresaId)
      .eq('wa_jid', waJidOrigem)
      .maybeSingle();

    if (erroPorJid) throw new Error(`Falha ao buscar hub.clientes por wa_jid: ${erroPorJid.message}`);

    if (porJid) {
      const patch: Record<string, string> = {};
      if (nomeContato && porJid.nome === porJid.telefone) patch.nome = nomeContato;
      // Só corrige o telefone quando o valor salvo ainda "parece" um lid
      // cru — nunca sobrescreve um telefone real já correto.
      if (telefone && telefone !== porJid.telefone && porJid.telefone.length > TAMANHO_MAXIMO_TELEFONE_BR) {
        patch.telefone = telefone;
      }
      if (!patch.telefone) {
        await aplicarCorrecoes(porJid.id, patch);
        return porJid.id;
      }

      // O patch de telefone pode violar clientes_telefone_empresa: o
      // telefone real JÁ existe como outro cadastro (visto em produção
      // 2026-08-08 — o resíduo @lid e o dono do telefone coexistiam e toda
      // mensagem nova ficava presa no resíduo, invisível para quem procura
      // pelo número). Nesse caso o dono do telefone é quem representa o
      // contato daqui em diante: leva o wa_jid e é o id retornado. O
      // resíduo fica órfão de propósito — mover o histórico dele é
      // operação de dados (SQL de merge), não deste fluxo.
      const { error: erroPatch } = await supabaseAdmin
        .from('clientes')
        .update(patch)
        .eq('id', porJid.id);
      if (!erroPatch) return porJid.id;
      if (erroPatch.code !== UNIQUE_VIOLATION) {
        // Log, não throw: mesma razão de aplicarCorrecoes — a mensagem não
        // pode se perder por causa de uma correção de cadastro adiável.
        // eslint-disable-next-line no-console
        console.error(`falha ao corrigir hub.clientes (${porJid.id}): ${erroPatch.message}`);
        return porJid.id;
      }

      const { data: dono, error: erroDono } = await supabaseAdmin
        .from('clientes')
        .select('id, nome, wa_jid')
        .eq('empresa_id', empresaId)
        .eq('telefone', telefone)
        .maybeSingle();
      // Corrida rara (o dono sumiu entre o update e este select): segue com
      // o resíduo; a próxima mensagem tenta o patch de novo.
      if (erroDono || !dono) return porJid.id;

      // wa_jid é único por (empresa_id, wa_jid) — solta do resíduo ANTES de
      // gravar no dono, senão a transferência viola o índice.
      const { error: erroSoltar } = await supabaseAdmin
        .from('clientes')
        .update({ wa_jid: null })
        .eq('id', porJid.id);
      const patchDono: Record<string, string> = {};
      if (!erroSoltar && !dono.wa_jid) patchDono.wa_jid = waJidOrigem;
      if (nomeContato && dono.nome === telefone) patchDono.nome = nomeContato;
      await aplicarCorrecoes(dono.id, patchDono);
      return dono.id;
    }
  }

  // 2) Fluxo por telefone (caminho normal, e fallback para quando ainda não
  // há wa_jid salvo para este contato).
  const { data: existente, error: erroSelect } = await supabaseAdmin
    .from('clientes')
    .select('id, nome, wa_jid')
    .eq('empresa_id', empresaId)
    .eq('telefone', telefone)
    .maybeSingle();

  if (erroSelect) throw new Error(`Falha ao buscar hub.clientes: ${erroSelect.message}`);

  if (existente) {
    // Só corrige o placeholder (nome ainda igual ao telefone, ver comentário
    // no ramo de insert abaixo) — nunca sobrescreve um nome já resolvido,
    // seja de um pushName anterior, seja de um enriquecimento futuro por
    // CRM/ERP direto na tabela. Mesma regra para wa_jid: só grava se ainda
    // não tinha (não sobrescreve um JID técnico já capturado).
    const patch: Record<string, string> = {};
    if (nomeContato && existente.nome === telefone && nomeContato !== existente.nome) {
      patch.nome = nomeContato;
    }
    if (waJidOrigem && !existente.wa_jid) {
      patch.wa_jid = waJidOrigem;
    }
    await aplicarCorrecoes(existente.id, patch);
    return existente.id;
  }

  // Nome do canal (pushName/ProfileName) quando o provedor manda; senão,
  // placeholder até enriquecer por CRM/ERP (fora do escopo desta fase).
  // `nome` é NOT NULL no schema.
  const { data: criado, error: erroInsert } = await supabaseAdmin
    .from('clientes')
    .insert({ empresa_id: empresaId, telefone, nome: nomeContato || telefone, wa_jid: waJidOrigem ?? null })
    .select('id')
    .single();

  if (!erroInsert && criado) return criado.id;

  // Corrida: dois eventos do mesmo cliente quase simultâneos podem cair
  // aqui os dois. `clientes_telefone_empresa` é unique (empresa_id, telefone)
  // — quem perder a corrida do insert só precisa reler o que o outro criou.
  if (erroInsert?.code === UNIQUE_VIOLATION) {
    const { data: corrida, error: erroCorrida } = await supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('empresa_id', empresaId)
      .eq('telefone', telefone)
      .single();
    if (!erroCorrida && corrida) return corrida.id;
  }
  throw new Error(`Falha ao criar hub.clientes: ${erroInsert?.message ?? 'sem dados'}`);
}

/**
 * Resolve (ou cria) o "cliente-grupo" — a linha de hub.clientes com
 * `tipo_chat='grupo'` que representa um chat @g.us.
 *
 * Separada de resolverCliente() de propósito: NADA do fluxo de contato
 * individual vale aqui. Não há telefone (o campo guarda o ID do JID), não há
 * @lid para corrigir, não há merge de resíduo, e `nomeContato` é o assunto do
 * grupo — não o nome de quem falou.
 *
 * O nome só é gravado enquanto ainda é placeholder, mesma regra do contato
 * individual: um atendente que renomeou o card na Ficha não pode ver o nome
 * dele ser sobrescrito pela próxima mensagem.
 */
async function resolverGrupo(
  empresaId: string,
  idGrupo: string,
  jidGrupo: string,
  assunto: string | undefined,
): Promise<string> {
  const { data: existente, error: erroSelect } = await supabaseAdmin
    .from('clientes')
    .select('id, nome, telefone, grupo_assunto_em')
    .eq('empresa_id', empresaId)
    .eq('wa_jid', jidGrupo)
    .maybeSingle<{ id: string; nome: string; telefone: string; grupo_assunto_em: string | null }>();

  if (erroSelect) throw new Error(`Falha ao buscar grupo em hub.clientes: ${erroSelect.message}`);

  if (existente) {
    if (assunto && existente.nome === existente.telefone) {
      await aplicarCorrecoes(existente.id, { nome: assunto, grupo_assunto_em: new Date().toISOString() });
    }
    return existente.id;
  }

  const { data: criado, error: erroInsert } = await supabaseAdmin
    .from('clientes')
    .insert({
      empresa_id: empresaId,
      telefone: idGrupo,
      nome: assunto || idGrupo,
      wa_jid: jidGrupo,
      tipo_chat: 'grupo',
      grupo_assunto_em: assunto ? new Date().toISOString() : null,
    })
    .select('id')
    .single<{ id: string }>();

  if (!erroInsert && criado) return criado.id;

  // Corrida: duas mensagens do mesmo grupo quase simultâneas. Mesmo padrão de
  // resolverCliente — quem perde só relê o que o outro criou.
  if (erroInsert?.code === UNIQUE_VIOLATION) {
    const { data: corrida } = await supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('empresa_id', empresaId)
      .eq('wa_jid', jidGrupo)
      .maybeSingle<{ id: string }>();
    if (corrida) return corrida.id;
  }
  throw new Error(`Falha ao criar grupo em hub.clientes: ${erroInsert?.message ?? 'sem dados'}`);
}

async function buscarConversaAberta(clienteId: string, canalId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('conversas')
    .select('id')
    .eq('cliente_id', clienteId)
    .eq('canal_id', canalId)
    .is('fechada_em', null)
    .order('aberta_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Falha ao buscar hub.conversas: ${error.message}`);
  return data?.id ?? null;
}

/** `abertaConhecida` evita repetir `buscarConversaAberta` no caminho quente:
 *  quem já consultou (ver processarEventoRecebido, que precisa saber disso
 *  antes, para o CSAT) passa o resultado adiante. Passar `undefined` mantém o
 *  comportamento original de consultar aqui. */
async function resolverConversaAberta(
  clienteId: string,
  canal: CanalContexto,
  abertaConhecida?: string | null,
): Promise<string> {
  const aberta =
    abertaConhecida !== undefined ? abertaConhecida : await buscarConversaAberta(clienteId, canal.id);
  if (aberta) return aberta;

  const { data: criada, error: erroInsert } = await supabaseAdmin
    .from('conversas')
    .insert({
      cliente_id: clienteId,
      canal_id: canal.id,
      setor_id: canal.setorId,
      // Linha pessoal (hub.canais.atendente_id): a conversa já nasce com
      // dono — cai direto na aba "Meus" do responsável. Linha de equipe
      // (null): nasce "Sem dono" no setor, como sempre.
      atendente_id: canal.atendenteId,
      ura_estado: 'nao_iniciada',
    })
    .select('id')
    .single();

  if (!erroInsert && criada) return criada.id;

  // Corrida: `conversas_aberta_por_cliente_canal` (unique parcial em
  // cliente_id/canal_id where fechada_em is null) barrou uma segunda
  // conversa aberta para o mesmo par — outro evento quase simultâneo
  // venceu a corrida entre o select e este insert. Quem perdeu só precisa
  // reler o que o outro criou, mesmo padrão de resolverCliente().
  if (erroInsert?.code === UNIQUE_VIOLATION) {
    const existente = await buscarConversaAberta(clienteId, canal.id);
    if (existente) return existente;
  }
  throw new Error(`Falha ao criar hub.conversas: ${erroInsert?.message ?? 'sem dados'}`);
}

/** Agradecimento após a nota. Melhor esforço: se o envio falhar, a nota já
 *  está gravada e o cliente apenas não recebe o "obrigado" — não vale
 *  derrubar o processamento da mensagem por causa disso.
 *
 *  Recebe a conversa avaliada para que `EnvioMensagem.conversaId` carregue um
 *  id real. Nenhum adapter usa esse campo hoje, mas mandar string vazia num
 *  campo declarado obrigatório é uma mentira que o próximo adapter a usá-lo
 *  herda. */
async function agradecerAvaliacao(
  conversaId: string,
  canalId: string,
  telefone: string,
  waJid?: string,
): Promise<void> {
  try {
    const canal = await obterOuCriarCanal(canalId);
    const resultado = await canal.enviar({
      conversaId,
      telefone,
      waJidDestino: waJid,
      texto: TEXTO_AGRADECIMENTO,
    });

    // O histórico do chamado fica com a pergunta e a nota; sem isto, o
    // "Obrigado" que o cliente vê no WhatsApp não existiria na conversa —
    // quem abrisse o chamado depois veria um fim de diálogo que não bate com
    // o que aconteceu de verdade.
    if (resultado.status === 'enviada') {
      const { error } = await supabaseAdmin.from('mensagens').insert({
        conversa_id: conversaId,
        wa_message_id: resultado.waMessageId || null,
        autor: 'atendente',
        direcao: 'saida',
        texto: TEXTO_AGRADECIMENTO,
        status_entrega: 'enviada',
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.error(`falha ao gravar agradecimento em hub.mensagens (conversa=${conversaId}):`, error.message);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('falha ao enviar agradecimento de avaliação:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Marca atividade na conversa — é o que faz a Caixa e o Kanban reordenarem.
 *
 * `atualizado_em` vem de 20260805120000_hub_conversas_atualizado_em.sql; a
 * função `hub.tocar_conversa` vem do plano de ordenação cronológica
 * (PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md §5.2) e faz duas coisas que não dá para
 * fazer daqui:
 *
 * 1. `greatest(atualizado_em, …)` DENTRO do UPDATE. Passamos o instante da
 *    mensagem, não `now()`, e num backlog de reconexão esse instante é passado.
 *    Com atribuição simples a conversa DESCERIA na lista ao receber mensagem —
 *    o oposto do que se pede dela. Com `now()`, um backlog de ontem subiria
 *    como se fosse de agora. `greatest` é a única forma que atende os dois.
 *
 * 2. Incremento atômico de `nao_lidas`. O que existia aqui era um select
 *    seguido de update: duas mensagens simultâneas liam 3 e ambas gravavam 4 —
 *    uma delas desaparecia da contagem.
 */
async function marcarConversaAtualizada(
  conversaId: string,
  incrementarNaoLidas: boolean,
  em: string,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('tocar_conversa', {
    p_conversa_id: conversaId,
    p_em: em,
    p_incrementar: incrementarNaoLidas,
  });
  if (error) throw new Error(`Falha ao atualizar hub.conversas: ${error.message}`);
}

/**
 * Marca a primeira resposta do atendente numa conversa.
 *
 * ÚNICO produtor de `hub.conversas.primeira_resposta_em` (auditoria 2026-08-09,
 * item 4). Antes existiam dois no front que discordavam — a Caixa gravava só
 * quando a mensagem saía de verdade, a Fila gravava ao ATRIBUIR, sem mensagem
 * nenhuma — e o eco `fromMe` do celular pareado não gravava nunca. O Painel
 * inteiro ("Tempo até 1ª resposta" e "SLA de 1ª resposta") lê só desta coluna.
 *
 * Escrita CONDICIONAL: `.is('primeira_resposta_em', null)` torna a operação
 * idempotente e imune a corrida — dois caminhos marcando ao mesmo tempo
 * resultam num só carimbo, o primeiro. Sem `.select()` de propósito: aqui não
 * precisamos SABER se o filtro barrou (diferente da reserva de avaliação em
 * routes/avaliacao.ts, onde barrar significa "não mande a pesquisa de novo").
 *
 * `.is('fechada_em', null)`: o eco de uma pesquisa de satisfação ou de um
 * agradecimento é mensagem de saída numa conversa JÁ FECHADA e não é resposta a
 * ninguém — sem esta guarda, um chamado que nunca foi respondido entraria no
 * Painel como respondido dentro do prazo.
 *
 * Log, não throw: é bookkeeping de indicador. A mensagem já saiu e já foi
 * gravada; perder o carimbo não pode derrubar o fluxo que a entregou.
 */
export async function marcarPrimeiraResposta(conversaId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('conversas')
    .update({ primeira_resposta_em: new Date().toISOString() })
    .eq('id', conversaId)
    .is('primeira_resposta_em', null)
    .is('fechada_em', null);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao marcar primeira_resposta_em (conversa=${conversaId}): ${error.message}`);
  }
}

interface LinhaAlvoEfeito {
  id: string;
  reacoes: Array<{ jid?: string; nome?: string; emoji?: string; em?: string }> | null;
  midia_objeto: string | null;
  midia_thumb_objeto: string | null;
}

/**
 * Aplica reação, edição ou "apagar para todos" numa mensagem que JÁ EXISTE.
 *
 * Estes eventos NÃO criam linha nova — é assim no WhatsApp e é assim que o
 * atendente espera ver. Criar uma bolha "fulano reagiu com 👍" encheria a
 * thread de ruído que o cliente não vê do lado dele.
 *
 * Melhor esforço: efeito sobre mensagem que nunca foi gravada (anterior ao
 * pareamento, ou de um chat que a linha não ingere) simplesmente não acha
 * alvo e sai em silêncio. Não é erro.
 */
async function aplicarEfeito(evento: EventoRecebido): Promise<void> {
  const efeito = evento.efeito;
  if (!efeito?.alvoWaId) return;

  const { data, error } = await supabaseAdmin
    .from('mensagens')
    .select('id, reacoes, midia_objeto, midia_thumb_objeto')
    .eq('wa_message_id', efeito.alvoWaId);
  if (error) throw new Error(`Falha ao buscar alvo do efeito em hub.mensagens: ${error.message}`);

  const alvos = (data ?? []) as LinhaAlvoEfeito[];
  if (!alvos.length) return;

  for (const alvo of alvos) {
    if (efeito.tipo === 'apagar') {
      // Apagar para todos apaga DE VERDADE. Guardar o texto original numa
      // coluna que ninguém lê seria manter, no nosso banco, exatamente o que
      // o cliente pediu para sumir.
      const { error: erroApagar } = await supabaseAdmin
        .from('mensagens')
        .update({
          apagada_em: new Date().toISOString(),
          texto: '',
          conteudo_extra: null,
          midia_objeto: null,
          midia_thumb_objeto: null,
          midia_status: 'nao_aplicavel',
          midia_ref: null,
          transcricao: null,
          transcricao_status: 'nao_aplicavel',
        })
        .eq('id', alvo.id);
      if (erroApagar) {
        // eslint-disable-next-line no-console
        console.error(`falha ao marcar mensagem apagada (${alvo.id}): ${erroApagar.message}`);
        continue;
      }
      // O binário no bucket também sai. Fire-and-forget: a linha já está
      // limpa, e um objeto órfão é varrido pela regra de ciclo de vida.
      for (const objeto of [alvo.midia_objeto, alvo.midia_thumb_objeto]) {
        if (objeto) void apagarObjeto(objeto).catch(() => undefined);
      }
      continue;
    }

    if (efeito.tipo === 'editar') {
      if (!efeito.texto) continue;
      await supabaseAdmin
        .from('mensagens')
        .update({ texto: efeito.texto, editada_em: new Date().toISOString() })
        .eq('id', alvo.id);
      continue;
    }

    // Reagir. Read-modify-write porque o jsonb é uma lista por pessoa: uma
    // reação nova do mesmo jid SUBSTITUI a anterior (o WhatsApp só deixa uma
    // por pessoa), e emoji vazio significa que a pessoa removeu a dela.
    const jid = evento.autorWaJid ?? 'desconhecido';
    const atuais = (alvo.reacoes ?? []).filter((r) => r.jid !== jid);
    if (efeito.texto) {
      atuais.push({ jid, nome: evento.autorNome, emoji: efeito.texto, em: new Date().toISOString() });
    }
    await supabaseAdmin.from('mensagens').update({ reacoes: atuais }).eq('id', alvo.id);
  }
}

/**
 * Handler passado para `ChannelPort.aoReceber` (ver registry.ts). Resolve
 * cliente e conversa aberta, grava a mensagem e trata idempotência de
 * `wa_message_id` como no-op — Baileys reemite `messages.upsert` depois de
 * reconexão, e reemissão não pode virar linha duplicada.
 */
export async function processarEventoRecebido(canalId: string, evento: EventoRecebido): Promise<void> {
  // Efeito (reação/edição/apagar) altera uma linha existente e não precisa de
  // cliente nem de conversa — sai antes de todo o resto.
  if (evento.efeito) {
    await aplicarEfeito(evento);
    return;
  }

  const canal = await buscarContextoCanal(canalId);
  const ehGrupo = !!evento.ehGrupo;
  // Grupo NÃO passa por normalizarTelefone: o "telefone" ali é o ID do JID
  // (18+ dígitos), e a regra de 10/11 dígitos prefixaria 55 num número que
  // não é número de ninguém.
  const telefone = ehGrupo ? evento.telefone : normalizarTelefone(evento.telefone);

  const clienteId = ehGrupo
    ? await resolverGrupo(canal.empresaId, telefone, evento.waJidOrigem ?? '', evento.nomeGrupo)
    : // Guard de segurança: nomeContato só é confiável quando a mensagem veio
      // do cliente. Em origem 'atendente' (eco de fromMe no Baileys, atendente
      // respondendo direto pelo celular pareado), o pushName do evento é do
      // PRÓPRIO atendente/empresa — usá-lo aqui sobrescreveria o nome do
      // cliente pelo nome de quem pareou o celular.
      await resolverCliente(
        canal.empresaId,
        telefone,
        evento.origem === 'cliente' ? evento.nomeContato : undefined,
        evento.waJidOrigem,
      );
  // Consultado UMA vez e reaproveitado abaixo: o CSAT precisa saber se existe
  // conversa aberta antes de decidir, e resolverConversaAberta precisaria da
  // mesma informação logo em seguida.
  const conversaAbertaId = await buscarConversaAberta(clienteId, canal.id);

  // CSAT (fase 2): a resposta à pesquisa de satisfação chega como mensagem
  // comum, e o comportamento padrão daqui pra frente é abrir conversa nova.
  // Por isso a captura roda ANTES de resolverConversaAberta — mas só para
  // mensagem de CLIENTE, e só quando nenhuma conversa aberta existe: com
  // conversa em andamento, um "5" é parte do assunto em curso, não nota.
  // Conservadora por contrato: qualquer dúvida devolve capturada=false e o
  // fluxo normal segue (ver services/avaliacao.ts).
  //
  // `!ehGrupo` é guarda de contenção, não detalhe (FA-17 do plano): num grupo,
  // um "5" solto é alguém falando do preço, da quantidade ou da hora — nunca
  // uma nota de satisfação. Sem esta guarda, uma conversa de grupo criaria
  // avaliações fantasma que entram direto no CSAT do Painel.
  if (!ehGrupo && evento.origem === 'cliente' && !conversaAbertaId) {
    const captura = await tentarRegistrarAvaliacao(clienteId, canal.id, evento.texto, evento.waMessageId);
    if (captura.capturada) {
      // Reentrega do Baileys: a nota já foi registrada e o cliente já foi
      // agradecido na primeira vez. Consome a mensagem em silêncio.
      //
      // Sem `await`: o adapter processa `messages.upsert` em série, então
      // esperar um envio de WhatsApp aqui deixaria uma rajada de mensagens
      // presa atrás dele. Mesmo tratamento do resumo e da análise.
      if (!captura.reentrega && captura.conversaId) {
        void agradecerAvaliacao(captura.conversaId, canal.id, telefone, evento.waJidOrigem);
      }
      return;
    }
  }

  // Eco `fromMe` de mensagem que NÓS enviamos a um chamado já fechado (auditoria
  // 2026-08-09, item 6b). O comentário histórico logo abaixo dizia que "a
  // idempotência por wa_message_id cobre o eco do que o backend já enviou" — era
  // verdade sob o índice único GLOBAL, e deixou de ser em
  // 20260808180000_hub_mensagens_wa_message_id_por_conversa.sql, que passou a
  // unicidade para (conversa_id, wa_message_id).
  //
  // Sem esta guarda, o eco da pesquisa de satisfação (enviada a uma conversa
  // FECHADA por routes/avaliacao.ts) não acha conversa aberta, cria uma nova, e
  // o insert seguinte não colide porque o conversa_id é outro: nasce uma
  // conversa fantasma na Caixa contendo só o texto da pesquisa. Mesmo caso do
  // "Obrigado pela sua avaliação!" e de qualquer reemissão pós-reconexão de uma
  // saída cuja conversa já foi fechada.
  //
  // A guarda só age quando o `wa_message_id` JÁ EXISTE em hub.mensagens, ou
  // seja, quando é comprovadamente eco de algo nosso. Mensagem que o vendedor
  // mandou pelo celular para um cliente sem chamado aberto tem id inédito e
  // continua abrindo conversa, como sempre.
  if (evento.origem === 'atendente' && !conversaAbertaId && evento.waMessageId) {
    if (await mensagemJaRegistrada(evento.waMessageId)) return;
  }

  const conversaId = await resolverConversaAberta(clienteId, canal, conversaAbertaId);

  const deAtendente = evento.origem === 'atendente';

  // Citação: o WhatsApp manda o id DELE da mensagem citada; a FK
  // respondendo_a aponta para o nosso id. Best-effort e restrito à MESMA
  // conversa — citar mensagem de outro chamado não faria sentido na tela, e
  // desde 20260808180000 o mesmo wa_message_id pode existir em conversas
  // diferentes (espelho entre duas linhas da própria base).
  let respondendoA: string | null = null;
  if (evento.citandoWaId) {
    const { data: citada } = await supabaseAdmin
      .from('mensagens')
      .select('id')
      .eq('conversa_id', conversaId)
      .eq('wa_message_id', evento.citandoWaId)
      .maybeSingle<{ id: string }>();
    respondendoA = citada?.id ?? null;
  }

  const temMidia = !!evento.midia && TIPOS_COM_MIDIA.has(evento.tipo ?? 'texto');

  // UMA vez, reaproveitado no insert e no carimbo da conversa: as duas tabelas
  // precisam concordar sobre quando esta mensagem aconteceu, e dois
  // `new Date()` em pontos diferentes do fluxo já não concordariam.
  const enviadaEm = instanteDaMensagem(evento.recebidoEm);

  const { data: inserida, error } = await supabaseAdmin
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      wa_message_id: evento.waMessageId,
      // A hora do WhatsApp, não a nossa. `criada_em` (default now()) continua
      // guardando quando a linha nasceu, para as varreduras operacionais.
      enviada_em: enviadaEm,
      autor: deAtendente ? 'atendente' : 'cliente',
      direcao: deAtendente ? 'saida' : 'entrada',
      texto: evento.texto ?? '',
      midia_url: evento.midiaUrl ?? null,
      // `midia_tipo` é o MIME e é NECESSÁRIO pela constraint
      // mensagens_midia_objeto_check assim que o objeto for gravado — por isso
      // vai já no insert, antes do download terminar.
      midia_tipo: evento.midia?.tipoMime ?? evento.midiaTipo ?? null,
      midia_nome: evento.midia?.nome ?? null,
      midia_tamanho: evento.midia?.tamanho ?? null,
      midia_duracao_seg: evento.midia?.duracaoSeg ?? null,
      midia_largura: evento.midia?.largura ?? null,
      midia_altura: evento.midia?.altura ?? null,
      // 'pendente' é o que faz a bolha aparecer AGORA como "carregando" e
      // virar imagem depois, por UPDATE de Realtime (decisão D1 do plano).
      // 'ignorada' cobre o caso da Twilio, que anuncia a mídia por URL
      // autenticada que ainda não sabemos buscar: a bolha diz o que chegou e
      // por que não está aqui, em vez de virar uma mensagem vazia.
      midia_status: temMidia ? 'pendente' : evento.midiaUrl ? 'ignorada' : 'nao_aplicavel',
      midia_erro:
        !temMidia && evento.midiaUrl
          ? 'Arquivo recebido pela linha oficial (Twilio) — download ainda não disponível no Hub.'
          : null,
      midia_ref: temMidia ? (evento.midia?.ref ?? null) : null,
      transcricao_status:
        temMidia && (evento.tipo === 'audio' || evento.tipo === 'voz') ? 'pendente' : 'nao_aplicavel',
      tipo_mensagem: evento.tipo ?? 'texto',
      conteudo_extra: evento.conteudoExtra ?? null,
      respondendo_a: respondendoA,
      respondendo_a_wa_id: evento.citandoWaId ?? null,
      autor_wa_jid: evento.autorWaJid ?? null,
      autor_nome: evento.autorNome ?? null,
      status_entrega: deAtendente ? 'enviada' : 'entregue',
    })
    .select('id')
    .single<{ id: string }>();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return; // idempotência: no-op
    throw new Error(`Falha ao inserir hub.mensagens: ${error.message}`);
  }

  // Download do binário: fire-and-forget, FORA do caminho serial que entrega
  // as mensagens. Um `await` aqui travaria a fila da linha inteira enquanto um
  // vídeo de 16 MB baixa (decisão D1 — é a razão de a fila existir).
  if (temMidia && inserida && evento.midia) {
    enfileirarMidia({
      mensagemId: inserida.id,
      empresaId: canal.empresaId,
      conversaId,
      waMessageId: evento.waMessageId,
      tipo: evento.tipo ?? 'texto',
      midia: evento.midia,
      ref: evento.midia.ref,
      reobterRef: evento.reobterRefMidia,
    });
  }

  await marcarConversaAtualizada(conversaId, !deAtendente, enviadaEm);

  // Eco de resposta dada pelo celular pareado, fora do app. Era o furo do item
  // 4 da auditoria: o vendedor respondia pelo telefone (o caso que este eco
  // existe para cobrir) e a conversa seguia como "sem 1ª resposta" — depois de
  // 15 min, contada como violação de SLA no Painel.
  if (deAtendente) await marcarPrimeiraResposta(conversaId);

  // Resumo de IA do caso (plano "Resumo de IA no Kanban") e análise de
  // sentimento/risco (PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md) — só em
  // mensagem de entrada (cliente), sem await: fire-and-forget, nunca atrasa
  // nem derruba o processamento da mensagem em si. Cada um tem seu próprio
  // debounce e seu próprio tratamento de erro; um falhar não afeta o outro
  // (ver services/resumoIA.ts e services/analiseIA.ts).
  //
  // GRUPO NÃO PASSA POR AQUI (premissa P11 do plano). Dois motivos: custo por
  // token de um grupo tagarela, e principalmente sentido — "sentimento do
  // cliente" e "risco de perder a venda" não têm significado num chat com 30
  // pessoas falando de assuntos diferentes. Ligar isso é decisão futura, com
  // prompt próprio, não um efeito colateral desta feature.
  if (!deAtendente && !ehGrupo) {
    agendarResumoDebounced(conversaId);
    agendarAnaliseDebounced(conversaId);
  }
}

// Rank de avanço de `status_entrega` (constraint mensagens_status_entrega_check
// em 20260731000300_hub_operacao.sql). Twilio não garante ordem de entrega dos
// callbacks de status — um 'lida' pode chegar antes do 'entregue' que o
// precede logicamente. Só escreve se o novo status for mais avançado que o
// atual, senão um callback atrasado regride um estado que já avançou.
const RANK_STATUS_ENTREGA: Record<string, number> = {
  pendente: 0,
  enviada: 1,
  entregue: 2,
  lida: 3,
  falhou: 4,
};

/**
 * Atualiza hub.mensagens.status_entrega a partir de um callback de status de
 * provedor (hoje só Twilio; Baileys não tem webhook de status, só o insert
 * síncrono em routes/mensagens.ts). Busca por wa_message_id — mesma chave de
 * idempotência do fluxo de entrada.
 *
 * "0 linhas afetadas" (mensagem ainda não commitada, ou wa_message_id nunca
 * existiu) não é erro: retorna false e quem chamou decide o que fazer — no
 * caso do webhook, isso vira um 200 mesmo assim, para não gerar retry da
 * Twilio por algo que vai se resolver sozinho no próximo callback da mesma
 * mensagem.
 */
export async function atualizarStatusEntregaPorWaMessageId(
  waMessageId: string,
  novoStatus: string,
  detalheErro?: string | null,
): Promise<boolean> {
  // Sem maybeSingle: desde 20260808180000 o unique de wa_message_id é por
  // (conversa_id, wa_message_id) — uma mensagem trocada entre duas linhas da
  // própria base existe uma vez em CADA conversa espelhada, e maybeSingle
  // estouraria com 2 linhas. Hoje só a Twilio chama isto (SIDs globalmente
  // únicos, 1 linha), mas o código não deve depender dessa coincidência.
  const { data, error: erroSelect } = await supabaseAdmin
    .from('mensagens')
    .select('id, status_entrega')
    .eq('wa_message_id', waMessageId);

  if (erroSelect) throw new Error(`Falha ao buscar hub.mensagens por wa_message_id: ${erroSelect.message}`);
  const linhas = (data ?? []) as { id: string; status_entrega: string }[];
  if (!linhas.length) return false;

  const rankNovo = RANK_STATUS_ENTREGA[novoStatus] ?? -1;
  let avancou = false;
  for (const atual of linhas) {
    const rankAtual = RANK_STATUS_ENTREGA[atual.status_entrega] ?? -1;
    if (rankNovo <= rankAtual) continue; // não regride nem reescreve o mesmo estado

    const { error: erroUpdate } = await supabaseAdmin
      .from('mensagens')
      .update({ status_entrega: novoStatus, erro: detalheErro ?? null })
      .eq('id', atual.id);

    if (erroUpdate) throw new Error(`Falha ao atualizar status_entrega em hub.mensagens: ${erroUpdate.message}`);
    avancou = true;
  }
  return avancou;
}
