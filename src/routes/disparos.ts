// Campanhas de disparo — Fase 3 do PLANO_CAMPANHA_INDIARA.md.
//
// O worker (jobs/disparador.ts) é quem envia. Estas rotas são o painel de
// controle: montar a lista, criar o disparo, ligar, pausar, retomar e —
// o botão que precisa existir ANTES do primeiro envio — parar tudo.
//
// Tudo aqui é admin. Um disparo alcança milhares de pessoas de uma vez; não
// é operação de operador, e a RLS do schema já diz o mesmo (disparos_admin_write).

import { Router } from 'express';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { buscarAtendenteAutenticado, empresasDoAtendente } from '../auth/escopoConversa.js';
import { aplicarCampos, minutosDoDia } from '../services/ritmoDisparo.js';
import { disparoHabilitado, pararTudo, primeiroNome, religarDisparos } from '../jobs/disparador.js';
import { emLotes, gerarLote, type EleitorParaPersonalizar } from '../services/personalizacaoIA.js';

export const disparosRouter = Router();
disparosRouter.use(requireSupabaseAuth());

const LOTE_ALVOS = 500;

interface Contexto {
  atendenteId: string;
  empresaId: string;
}

async function exigirAdmin(
  userId: string,
  empresaId: unknown,
): Promise<Contexto | { erro: number; mensagem: string }> {
  if (typeof empresaId !== 'string' || !empresaId) {
    return { erro: 400, mensagem: 'empresaId é obrigatório.' };
  }
  const atendente = await buscarAtendenteAutenticado(userId);
  if (!atendente) return { erro: 403, mensagem: 'Usuário autenticado não corresponde a um atendente ativo.' };
  if (atendente.perfil !== 'admin') {
    return { erro: 403, mensagem: 'Somente administradores podem operar disparos.' };
  }
  const empresas = await empresasDoAtendente(atendente.id);
  if (!empresas.has(empresaId)) return { erro: 403, mensagem: 'Empresa fora do escopo deste administrador.' };
  return { atendenteId: atendente.id, empresaId };
}

/** Confere que o disparo é da empresa do admin antes de qualquer ação. */
async function disparoDaEmpresa(disparoId: string, empresaId: string) {
  const { data } = await supabaseAdmin
    .from('disparos')
    .select('id, empresa_id, status, canal_id, lista_id, texto_base, pausado_em, amostra_aprovada_em')
    .eq('id', disparoId)
    .maybeSingle<{
      id: string;
      empresa_id: string;
      status: string;
      canal_id: string | null;
      lista_id: string | null;
      texto_base: string | null;
      pausado_em: string | null;
      amostra_aprovada_em: string | null;
    }>();
  if (!data || data.empresa_id !== empresaId) return null;
  return data;
}

// ---------------------------------------------------------------------
// Listas — o segmento que o disparo alcança
// ---------------------------------------------------------------------

interface FiltroLista {
  bairros?: string[];
  tags?: string[];
}

/**
 * POST /listas — materializa o segmento AGORA.
 *
 * A lista é congelada, não é filtro salvo. Filtro reavaliado na hora do
 * envio muda de tamanho entre a aprovação do texto e o disparo: alguém
 * importa uma planilha no meio e a campanha aprovada para 800 pessoas sai
 * para 4 mil.
 *
 * Só entra quem está `ativo`. Quem está em opt-out ou bloqueado não entra
 * nem como linha ignorada — o trigger do banco recusaria depois, e é
 * melhor a lista já nascer certa.
 */
disparosRouter.post('/listas', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const nome = String(req.body?.nome ?? '').trim();
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório.' });

    const filtro = (req.body?.filtro ?? {}) as FiltroLista;

    let q = supabaseAdmin
      .from('clientes')
      .select('id')
      .eq('empresa_id', ctx.empresaId)
      .eq('situacao', 'ativo');
    if (filtro.bairros?.length) q = q.in('bairro', filtro.bairros);
    if (filtro.tags?.length) q = q.overlaps('tags', filtro.tags);

    const { data: alvos, error: erroBusca } = await q;
    if (erroBusca) throw new Error(erroBusca.message);

    const ids = (alvos ?? []).map((c) => (c as { id: string }).id);
    if (!ids.length) {
      return res.status(400).json({ error: 'Nenhum eleitor ativo bate com este filtro.' });
    }

    const { data: lista, error: erroLista } = await supabaseAdmin
      .from('listas')
      .insert({
        empresa_id: ctx.empresaId,
        nome,
        descricao: req.body?.descricao ?? null,
        criado_por: ctx.atendenteId,
        filtro,
      })
      .select('id')
      .single<{ id: string }>();
    if (erroLista || !lista) throw new Error(erroLista?.message ?? 'sem id');

    for (let i = 0; i < ids.length; i += LOTE_ALVOS) {
      const { error } = await supabaseAdmin
        .from('lista_eleitores')
        .insert(ids.slice(i, i + LOTE_ALVOS).map((cliente_id) => ({ lista_id: lista.id, cliente_id })));
      if (error) throw new Error(`falha ao montar a lista: ${error.message}`);
    }

    res.status(201).json({ listaId: lista.id, total: ids.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------
// Disparos
// ---------------------------------------------------------------------

disparosRouter.get('/disparos', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.query?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const { data, error } = await supabaseAdmin
      .from('disparos')
      .select(
        'id, nome, status, canal_id, lista_id, texto_base, janela_inicio, janela_fim, ' +
          'intervalo_min_seg, intervalo_max_seg, teto_diario, enviados_hoje, pausado_em, ' +
          'pausa_motivo, criado_em, iniciado_em, concluido_em',
      )
      .eq('empresa_id', ctx.empresaId)
      .order('criado_em', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    res.status(200).json({ disparos: data ?? [], envioHabilitado: disparoHabilitado() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /disparos/:id/progresso — o que o painel mostra enquanto roda. */
disparosRouter.get('/disparos/:id/progresso', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.query?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });

    const { data, error } = await supabaseAdmin
      .from('disparo_alvos')
      .select('status')
      .eq('disparo_id', req.params.id);
    if (error) throw new Error(error.message);

    const contagem: Record<string, number> = {};
    for (const linha of (data ?? []) as Array<{ status: string }>) {
      contagem[linha.status] = (contagem[linha.status] ?? 0) + 1;
    }

    res.status(200).json({
      status: disparo.status,
      pausadoEm: disparo.pausado_em,
      contagem,
      total: (data ?? []).length,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /disparos — cria em rascunho. Não envia nada. */
disparosRouter.post('/disparos', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const nome = String(req.body?.nome ?? '').trim();
    const textoBase = String(req.body?.textoBase ?? '').trim();
    const canalId = req.body?.canalId;
    const listaId = req.body?.listaId;

    if (!nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    if (!textoBase) return res.status(400).json({ error: 'textoBase é obrigatório.' });
    if (typeof canalId !== 'string' || !canalId) {
      return res.status(400).json({ error: 'canalId é obrigatório.' });
    }
    if (typeof listaId !== 'string' || !listaId) {
      return res.status(400).json({ error: 'listaId é obrigatório.' });
    }

    const janelaInicio = String(req.body?.janelaInicio ?? '09:00');
    const janelaFim = String(req.body?.janelaFim ?? '20:00');
    const i = minutosDoDia(janelaInicio);
    const f = minutosDoDia(janelaFim);
    if (i === null || f === null || f <= i) {
      return res.status(400).json({
        error: 'Janela inválida. Use HH:MM com fim depois do início — a janela não atravessa a meia-noite.',
      });
    }

    const intervaloMin = Number(req.body?.intervaloMinSeg ?? 25);
    const intervaloMax = Number(req.body?.intervaloMaxSeg ?? 90);
    if (!(intervaloMin > 0) || intervaloMax < intervaloMin) {
      return res.status(400).json({ error: 'Intervalo inválido: mínimo maior que zero e máximo >= mínimo.' });
    }

    const { data, error } = await supabaseAdmin
      .from('disparos')
      .insert({
        empresa_id: ctx.empresaId,
        canal_id: canalId,
        lista_id: listaId,
        nome,
        texto_base: textoBase,
        criado_por: ctx.atendenteId,
        status: 'rascunho',
        janela_inicio: janelaInicio,
        janela_fim: janelaFim,
        intervalo_min_seg: intervaloMin,
        intervalo_max_seg: intervaloMax,
        teto_diario: req.body?.tetoDiario ?? null,
      })
      .select('id')
      .single<{ id: string }>();
    if (error || !data) throw new Error(error?.message ?? 'sem id');

    res.status(201).json({ disparoId: data.id });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /disparos/:id/preparar — materializa os alvos a partir da lista.
 *
 * Separado de "iniciar" de propósito: é aqui que dá para conferir quantas
 * pessoas vão receber, e é aqui que os guarda-corpos do banco (opt-out,
 * base legal) recusam quem não pode receber — antes de qualquer envio, não
 * no meio dele.
 */
disparosRouter.post('/disparos/:id/preparar', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });
    if (disparo.status !== 'rascunho') {
      return res.status(409).json({ error: `Disparo já está em "${disparo.status}".` });
    }
    if (!disparo.lista_id) return res.status(400).json({ error: 'Disparo sem lista.' });

    const { data: membros, error: erroMembros } = await supabaseAdmin
      .from('lista_eleitores')
      .select('cliente_id, clientes(id, telefone, situacao, opt_out_em)')
      .eq('lista_id', disparo.lista_id);
    if (erroMembros) throw new Error(erroMembros.message);

    type Membro = { clientes: { id: string; telefone: string; situacao: string; opt_out_em: string | null } | null };
    const linhas = (membros ?? []) as unknown as Membro[];

    // Filtra aqui também, além do trigger. O trigger é a garantia; este
    // filtro é o que faz a resposta dizer "3 pessoas saíram da lista porque
    // pediram descadastro" em vez de estourar um erro de banco na cara do
    // admin.
    const aptos = linhas.map((m) => m.clientes).filter((c): c is NonNullable<typeof c> => !!c);
    const podem = aptos.filter((c) => c.situacao === 'ativo' && !c.opt_out_em);
    const removidos = aptos.length - podem.length;

    if (!podem.length) {
      return res.status(400).json({ error: 'Nenhum eleitor da lista pode receber disparo agora.' });
    }

    let inseridos = 0;
    for (let i = 0; i < podem.length; i += LOTE_ALVOS) {
      const lote = podem.slice(i, i + LOTE_ALVOS).map((c) => ({
        disparo_id: disparo.id,
        cliente_id: c.id,
        telefone: c.telefone,
        status: 'pendente',
      }));
      const { error } = await supabaseAdmin.from('disparo_alvos').insert(lote);
      if (error) throw new Error(`falha ao preparar a fila: ${error.message}`);
      inseridos += lote.length;
    }

    res.status(200).json({
      preparados: inseridos,
      removidos,
      aviso: removidos
        ? `${removidos} pessoa(s) da lista não entraram: pediram descadastro ou estão bloqueadas.`
        : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /disparos/:id/iniciar — a partir daqui o worker manda. */
disparosRouter.post('/disparos/:id/iniciar', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });
    if (disparo.status !== 'rascunho' && disparo.status !== 'agendado') {
      return res.status(409).json({ error: `Disparo está em "${disparo.status}", não dá para iniciar.` });
    }

    const { count } = await supabaseAdmin
      .from('disparo_alvos')
      .select('id', { count: 'exact', head: true })
      .eq('disparo_id', disparo.id)
      .eq('status', 'pendente');
    if (!count) {
      return res.status(400).json({ error: 'Nenhum alvo pendente. Prepare a fila antes de iniciar.' });
    }

    // TRAVA DA AMOSTRA. Se a IA personalizou, uma pessoa precisa ter olhado
    // uma amostra antes de milhares de mensagens saírem com texto que
    // ninguém leu. O validador anti-invenção reduz o risco de conteúdo
    // falso; ele não substitui alguém conferindo o tom.
    const { count: personalizados } = await supabaseAdmin
      .from('disparo_alvos')
      .select('id', { count: 'exact', head: true })
      .eq('disparo_id', disparo.id)
      .not('texto_gerado', 'is', null);

    if (personalizados && !disparo.amostra_aprovada_em) {
      return res.status(409).json({
        error:
          'Este disparo tem mensagens personalizadas por IA e a amostra ainda não foi aprovada. ' +
          'Confira a amostra e aprove antes de iniciar.',
      });
    }

    const { error } = await supabaseAdmin
      .from('disparos')
      .update({
        status: 'enviando',
        iniciado_em: new Date().toISOString(),
        pausado_em: null,
        pausa_motivo: null,
      })
      .eq('id', disparo.id);
    // O trigger hub.impede_disparo_sem_base_legal recusa aqui se algum
    // destinatário estiver sem base legal. A mensagem dele é melhor que
    // qualquer coisa que a gente reescrevesse.
    if (error) return res.status(409).json({ error: error.message });

    res.status(200).json({ status: 'enviando', pendentes: count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

disparosRouter.post('/disparos/:id/pausar', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });

    await supabaseAdmin
      .from('disparos')
      .update({
        pausado_em: new Date().toISOString(),
        pausa_motivo: String(req.body?.motivo ?? 'Pausado manualmente.'),
      })
      .eq('id', disparo.id);
    res.status(200).json({ status: 'pausado' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

disparosRouter.post('/disparos/:id/retomar', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });

    await supabaseAdmin
      .from('disparos')
      .update({ pausado_em: null, pausa_motivo: null })
      .eq('id', disparo.id);
    res.status(200).json({ status: 'enviando' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /disparos/parar-tudo — o botão vermelho.
 *
 * Existe antes do primeiro envio, não depois do primeiro problema. Desliga
 * o worker E pausa no banco tudo que estava enviando: só o primeiro voltaria
 * a mandar no próximo deploy, só o segundo não interromperia a passada em
 * andamento.
 */
disparosRouter.post('/disparos/parar-tudo', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const motivo = String(req.body?.motivo ?? 'Parada manual pelo painel.');
    const pausados = await pararTudo(motivo);
    res.status(200).json({ parado: true, disparosPausados: pausados });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /disparos/religar — desfaz o parar-tudo. Não retoma disparo
 *  nenhum: cada campanha precisa ser retomada de propósito, uma a uma. */
disparosRouter.post('/disparos/religar', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    religarDisparos();
    res.status(200).json({ envioHabilitado: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /disparos/previsualizar — como a mensagem fica para uma pessoa real.
 *
 * Sem isto, o primeiro a ver o texto com os campos substituídos é o
 * eleitor. Devolve amostras de verdade do cadastro, não exemplos
 * inventados: é o jeito de descobrir que metade da base não tem bairro
 * antes de mandar "tudo bem no ?" para elas.
 */
disparosRouter.post('/disparos/previsualizar', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const textoBase = String(req.body?.textoBase ?? '');
    if (!textoBase.trim()) return res.status(400).json({ error: 'textoBase é obrigatório.' });

    const listaId = req.body?.listaId;
    let ids: string[] | null = null;
    if (typeof listaId === 'string' && listaId) {
      const { data } = await supabaseAdmin
        .from('lista_eleitores')
        .select('cliente_id')
        .eq('lista_id', listaId)
        .limit(20);
      ids = (data ?? []).map((l) => (l as { cliente_id: string }).cliente_id);
    }

    let q = supabaseAdmin
      .from('clientes')
      .select('nome, bairro, cidade')
      .eq('empresa_id', ctx.empresaId)
      .eq('situacao', 'ativo')
      .limit(5);
    if (ids?.length) q = q.in('id', ids);

    const { data: amostra, error } = await q;
    if (error) throw new Error(error.message);

    type Pessoa = { nome: string; bairro: string | null; cidade: string | null };
    const exemplos = ((amostra ?? []) as unknown as Pessoa[]).map((p) => ({
      para: p.nome,
      texto: aplicarCampos(textoBase, {
        nome: p.nome,
        primeiro_nome: p.nome.trim().split(/\s+/)[0],
        bairro: p.bairro,
        cidade: p.cidade,
      }),
    }));

    res.status(200).json({ exemplos });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------
// Personalização por IA (Fase 4.1)
// ---------------------------------------------------------------------

/**
 * POST /disparos/:id/personalizar — pré-gera a variação de cada alvo.
 *
 * PRÉ-GERAÇÃO, não geração no envio. Gerar durante o disparo faria a
 * latência do modelo virar o intervalo entre mensagens: irregular, caro, e
 * tirando do worker o controle do ritmo que a Fase 3 construiu.
 *
 * Chamar de novo REGERA tudo. É a forma de reagir a uma amostra ruim:
 * ajusta o texto-base e personaliza outra vez.
 */
disparosRouter.post('/disparos/:id/personalizar', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });
    if (disparo.status !== 'rascunho') {
      return res.status(409).json({
        error: `Disparo está em "${disparo.status}". Personalize antes de iniciar, não durante.`,
      });
    }
    if (!disparo.texto_base?.trim()) {
      return res.status(400).json({ error: 'Disparo sem texto-base.' });
    }

    const { data: alvos, error } = await supabaseAdmin
      .from('disparo_alvos')
      .select('id, cliente_id, clientes(nome, bairro, cidade, tags)')
      .eq('disparo_id', disparo.id)
      .eq('status', 'pendente');
    if (error) throw new Error(error.message);

    type Linha = {
      id: string;
      clientes: { nome: string; bairro: string | null; cidade: string | null; tags: string[] | null } | null;
    };
    const linhas = (alvos ?? []) as unknown as Linha[];
    if (!linhas.length) {
      return res.status(400).json({ error: 'Nenhum alvo pendente. Prepare a fila antes de personalizar.' });
    }

    const eleitores: EleitorParaPersonalizar[] = linhas
      .filter((l) => l.clientes)
      .map((l) => ({
        alvoId: l.id,
        nome: l.clientes!.nome,
        primeiroNome: primeiroNome(l.clientes!.nome),
        bairro: l.clientes!.bairro,
        cidade: l.clientes!.cidade,
        tags: l.clientes!.tags,
      }));

    let personalizadas = 0;
    let descartadas = 0;
    const motivos: Record<string, number> = {};

    for (const lote of emLotes(eleitores)) {
      const variacoes = await gerarLote(disparo.texto_base, lote);
      for (const v of variacoes) {
        if (v.personalizada) {
          personalizadas += 1;
        } else {
          descartadas += 1;
          if (v.motivoDescarte) motivos[v.motivoDescarte] = (motivos[v.motivoDescarte] ?? 0) + 1;
        }
        const { error: erroUpdate } = await supabaseAdmin
          .from('disparo_alvos')
          .update({ texto_gerado: v.texto })
          .eq('id', v.alvoId);
        if (erroUpdate) throw new Error(`falha ao gravar a variação: ${erroUpdate.message}`);
      }
    }

    // Personalizar de novo invalida a aprovação anterior: a amostra que a
    // pessoa aprovou não é mais a que vai sair.
    await supabaseAdmin.from('disparos').update({ amostra_aprovada_em: null }).eq('id', disparo.id);

    res.status(200).json({
      total: eleitores.length,
      personalizadas,
      descartadas,
      // Taxa alta de descarte quase sempre significa que o TEXTO-BASE está
      // induzindo o modelo a inventar (pede número, promete algo vago). É
      // informação sobre o texto, não sobre o modelo.
      motivosDeDescarte: motivos,
      proximoPasso: 'Confira a amostra e aprove antes de iniciar.',
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /disparos/:id/amostra — o que uma pessoa precisa ler antes de
 *  milhares de mensagens saírem. */
disparosRouter.get('/disparos/:id/amostra', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.query?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });

    const quantas = Math.min(Number(req.query?.quantas ?? 20) || 20, 50);
    const { data, error } = await supabaseAdmin
      .from('disparo_alvos')
      .select('id, texto_gerado, clientes(nome, bairro)')
      .eq('disparo_id', disparo.id)
      .eq('status', 'pendente')
      .limit(quantas);
    if (error) throw new Error(error.message);

    type Linha = {
      id: string;
      texto_gerado: string | null;
      clientes: { nome: string; bairro: string | null } | null;
    };
    const amostra = ((data ?? []) as unknown as Linha[]).map((l) => ({
      para: l.clientes?.nome ?? '(sem nome)',
      bairro: l.clientes?.bairro ?? null,
      texto: l.texto_gerado ?? disparo.texto_base ?? '',
      personalizada: !!l.texto_gerado,
    }));

    res.status(200).json({ amostra, aprovadaEm: disparo.amostra_aprovada_em });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /disparos/:id/aprovar-amostra — registra QUANDO a amostra foi
 *  aprovada. A trava em /iniciar consulta isto. */
disparosRouter.post('/disparos/:id/aprovar-amostra', async (req, res) => {
  try {
    const ctx = await exigirAdmin(req.auth!.userId, req.body?.empresaId);
    if ('erro' in ctx) return res.status(ctx.erro).json({ error: ctx.mensagem });

    const disparo = await disparoDaEmpresa(req.params.id, ctx.empresaId);
    if (!disparo) return res.status(404).json({ error: 'Disparo não encontrado.' });

    await supabaseAdmin
      .from('disparos')
      .update({ amostra_aprovada_em: new Date().toISOString() })
      .eq('id', disparo.id);

    res.status(200).json({ aprovada: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
