// Painel clicável → Alice contextual.
// PLANO_PAINEL_CLICAVEL_ALICE_CONTEXTUAL.md, §3.4a.
//
// Este módulo é PURO de propósito: recebe as conversas JÁ ESCOPADAS e devolve
// texto. Não conhece Supabase, Express nem Anthropic — por isso o teste dele
// não precisa de mock nenhum, e por isso ele não tem como vazar dado de outra
// empresa: o escopo já foi decidido por quem o chamou (services/alice.ts).
//
// O que ele resolve é o problema central do §2 do plano: a resposta da Alice
// contradizer o card que o gestor acabou de clicar. Duas peças:
//
//   detalharFoco()  — o agregado específico daquele indicador, que o contexto
//                     genérico de 30 dias não tem (p90, quem violou o SLA, as
//                     conversas negativas de uma célula da matriz…).
//   conferirValor() — recalcula a métrica com a MESMA regra do front e compara
//                     com o que está na tela. Divergência vira frase explicada,
//                     nunca um número trocado em silêncio.

/** Allowlist canônica do backend. Espelha FOCOS_VALIDOS do front
 *  (multi-whats-magic/src/lib/painel-foco.ts). Os dois repos não compartilham
 *  types — é a convenção da casa —, então a duplicação é deliberada e tem item
 *  de auditoria próprio (A2): um tipo que exista só no front vira 400. */
export const FOCOS_VALIDOS = [
  // Faixa 2 — os números
  'kpi_chamados',
  'kpi_primeira_resposta',
  'kpi_atendimento',
  'kpi_espera',
  'kpi_fechamento',
  'kpi_nota',
  'kpi_sla',
  'kpi_csat',
  // Faixas 1 / 2.5 / 3 / 4 / 5
  'linha_saude',
  'alerta_risco',
  'sentimento_celula',
  'perda_motivo',
  'perda_resumo',
  'area_setor',
  'atendente_linha',
  // Faixas inteiras (o ✨ no cabeçalho)
  'faixa_saude',
  'faixa_numeros',
  'faixa_alertas',
  'faixa_sentimento',
  'faixa_perdas',
  'faixa_areas',
  'faixa_atendentes',
] as const;

export type FocoTipo = (typeof FOCOS_VALIDOS)[number];
export type PeriodoFoco = 'hoje' | '7' | '30';

export const PERIODOS_VALIDOS: readonly PeriodoFoco[] = ['hoje', '7', '30'];

/** Meta de SLA de 1ª resposta, em minutos. Precisa concordar com
 *  META_PRIMEIRA_RESPOSTA_MIN do front (src/lib/atendimento-indicadores.ts) —
 *  se divergir, a Alice chama de violação o que o card mostra como dentro da
 *  meta, que é exatamente o tipo de contradição que este módulo existe para
 *  evitar. */
export const META_PRIMEIRA_RESPOSTA_MIN = 15;

/** Teto da janela que o cliente pode pedir. `desde` vem do front (é a única
 *  forma de acertar o fuso: "hoje" no Painel é meia-noite em São Paulo, e o
 *  Cloud Run roda em UTC). Como é o cliente que manda, precisa de teto: sem
 *  ele, um `desde` de 1970 viraria uma varredura da tabela inteira. */
export const MAX_DIAS_JANELA = 90;

export interface RecorteFoco {
  setorId?: string;
  atendenteId?: string;
  canalId?: string;
  conversaId?: string;
  /** rótulo do motivo de perda — `conversas.motivo_perda` é texto livre */
  motivo?: string;
}

export interface AliceFoco {
  tipo: FocoTipo;
  titulo: string;
  valor: string;
  periodo: PeriodoFoco;
  /** Início da janela exatamente como o Painel calculou, em ISO. Clampado a
   *  MAX_DIAS_JANELA pelo servidor. */
  desde: string;
  linhas: string[];
  mock?: boolean;
  recorte?: RecorteFoco;
}

/** Shape que services/alice.ts já seleciona, mais as três colunas que só o
 *  caminho de foco pede (canal_id, titulo_ia, resumo_ia). */
export interface ConversaFoco {
  id: string;
  setor_id: string | null;
  atendente_id: string | null;
  canal_id: string | null;
  status: string;
  desfecho: string | null;
  motivo_perda: string | null;
  sentimento: string | null;
  risco: string | null;
  risco_motivo: string | null;
  titulo_ia: string | null;
  resumo_ia: string | null;
  nota_satisfacao: number | null;
  valor_venda: number | null;
  aberta_em: string;
  primeira_resposta_em: string | null;
  fechada_em: string | null;
  avaliacao_solicitada_em: string | null;
  avaliacao_registrada_em: string | null;
  setores: { id: string; nome: string; empresa_id: string | null } | null;
  canais: { empresa_id: string | null } | null;
}

export interface CanalFoco {
  id: string;
  nome: string;
  status: string | null;
  conexao_status: string | null;
  transporte: string | null;
}

export interface ContextoFoco {
  /** Conversas da janela atual, já escopadas por empresa e pelos filtros. */
  atuais: ConversaFoco[];
  /** Janela imediatamente anterior, do mesmo tamanho — base do delta. */
  anteriores: ConversaFoco[];
  nomesAtendentes: Map<string, string>;
  /** Instante único de todo o cálculo. Injetado (e não `new Date()` aqui) pela
   *  mesma razão do Painel: julgar conversas da mesma leva contra relógios
   *  diferentes produz SLA instável — e, de quebra, torna o teste determinístico. */
  agoraISO: string;
  /** Só preenchido no tipo `linha_saude`, e só depois de reescopado por empresa. */
  canal?: CanalFoco | null;
}

// ---------------------------------------------------------------------------
// janela
// ---------------------------------------------------------------------------

export function diasDoPeriodo(p: PeriodoFoco): number {
  return p === 'hoje' ? 1 : p === '7' ? 7 : 30;
}

export function rotuloPeriodo(p: PeriodoFoco): string {
  return p === 'hoje' ? 'hoje' : p === '7' ? 'últimos 7 dias' : 'últimos 30 dias';
}

/**
 * Resolve o início da janela a partir do que o front mandou.
 *
 * Por que confiar no `desde` do cliente: ele é a ÚNICA forma de a janela do
 * servidor bater com a da tela. "Hoje" no Painel é meia-noite no fuso do
 * navegador; o Cloud Run roda em UTC. Recalcular no servidor erraria em 3h
 * todo dia — e a divergência apareceria como a Alice citando um número que o
 * card não mostra, que é o defeito nº 1 deste plano.
 *
 * Por que ainda assim ele é clampado: `desde` é entrada do cliente. Sem teto,
 * um valor de 1970 viraria varredura da tabela inteira. O clamp é de janela
 * temporal apenas — não amplia escopo de empresa, setor ou atendente.
 */
export function resolverJanela(
  desdeBruto: string | undefined,
  periodo: PeriodoFoco,
  agoraISO: string,
): { desde: Date; anteriorDesde: Date; dias: number; clampado: boolean } {
  const agora = new Date(agoraISO).getTime();
  const piso = agora - MAX_DIAS_JANELA * 24 * 3600_000;

  const bruto = desdeBruto ? new Date(desdeBruto).getTime() : NaN;
  const padrao = agora - diasDoPeriodo(periodo) * 24 * 3600_000;

  let alvo = Number.isFinite(bruto) ? bruto : padrao;
  const clampado = alvo < piso || alvo > agora;
  if (alvo < piso) alvo = piso;
  if (alvo > agora) alvo = agora;

  const largura = Math.max(agora - alvo, 60_000); // nunca uma janela de zero
  return {
    desde: new Date(alvo),
    anteriorDesde: new Date(alvo - largura),
    dias: largura / (24 * 3600_000),
    clampado,
  };
}

// ---------------------------------------------------------------------------
// utilitários de cálculo — espelham painel.tsx de propósito
// ---------------------------------------------------------------------------

const minutos = (de: string, ate: string) =>
  (new Date(ate).getTime() - new Date(de).getTime()) / 60000;

const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const mediana = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const percentil = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};

/** Mesmo formato do `duracao()` do Painel — a conferência compara STRINGS
 *  formatadas, então a formatação precisa ser a mesma dos dois lados. */
export function duracao(min: number): string {
  if (!min) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}min` : `${h}h`;
}

const nomeSetor = (c: ConversaFoco) => c.setores?.nome ?? 'sem setor';

const nomeDono = (c: ConversaFoco, ctx: ContextoFoco) =>
  c.atendente_id ? (ctx.nomesAtendentes.get(c.atendente_id) ?? 'atendente') : 'sem dono';

/**
 * A regra de escopo dos KPIs do Painel, replicada com as excentricidades.
 *
 * `conversasEscopo` do front descarta conversa com `setor_id` nulo — o escopo
 * dele nasce da lista de setores. Aqui o escopo nasce da empresa (que também
 * pode vir do canal), então uma conversa sem setor ENTRA. Se eu não replicasse
 * o descarte, a Alice diria 14 onde o card diz 13 e estaria "certa" de um jeito
 * inútil. O número de descartadas vai para a conferência (invariante I6).
 */
const comSetor = (cs: ConversaFoco[]) => cs.filter((c) => !!c.setor_id);

function recortar(cs: ConversaFoco[], r: RecorteFoco | undefined): ConversaFoco[] {
  if (!r) return cs;
  return cs.filter(
    (c) =>
      (!r.setorId || c.setor_id === r.setorId) &&
      (!r.atendenteId || c.atendente_id === r.atendenteId) &&
      (!r.conversaId || c.id === r.conversaId) &&
      (!r.motivo || c.motivo_perda === r.motivo),
  );
}

/** Agrupa e devolve as linhas "- chave: n" ordenadas pelo maior. */
function ranking(pares: [string, number][], limite = 8): string[] {
  return pares
    .sort((a, b) => b[1] - a[1])
    .slice(0, limite)
    .map(([k, n]) => `- ${k}: ${n}`);
}

function contarPor(cs: ConversaFoco[], chave: (c: ConversaFoco) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const c of cs) m.set(chave(c), (m.get(chave(c)) ?? 0) + 1);
  return [...m.entries()];
}

// ---------------------------------------------------------------------------
// detalharFoco — o bloco específico do indicador clicado
// ---------------------------------------------------------------------------

/**
 * O agregado que o contexto genérico não tem. Nunca lança: um recorte que não
 * encontra nada devolve uma linha dizendo isso, e a Alice responde que não tem
 * a informação — que é melhor do que uma exceção virando 500 na cara do gestor.
 */
export function detalharFoco(foco: AliceFoco, ctx: ContextoFoco): string[] {
  const todas = recortar(ctx.atuais, foco.recorte);
  const antes = recortar(ctx.anteriores, foco.recorte);
  const kpis = comSetor(todas);

  switch (foco.tipo) {
    case 'kpi_chamados':
      return [
        `Chamados na janela: ${kpis.length}. Na janela anterior: ${comSetor(antes).length}.`,
        ...bloco('Por setor', ranking(contarPor(kpis, nomeSetor))),
        ...bloco(
          'Por dono',
          ranking(contarPor(kpis, (c) => nomeDono(c, ctx))),
        ),
        ...bloco(
          'Por status',
          ranking(contarPor(kpis, (c) => c.status)),
        ),
      ];

    case 'kpi_primeira_resposta': {
      const resp = kpis.filter((c) => c.primeira_resposta_em);
      const tempos = resp.map((c) => minutos(c.aberta_em, c.primeira_resposta_em!));
      const semResposta = kpis.filter((c) => !c.primeira_resposta_em);
      const piores = [...resp]
        .sort(
          (a, b) =>
            minutos(b.aberta_em, b.primeira_resposta_em!) -
            minutos(a.aberta_em, a.primeira_resposta_em!),
        )
        .slice(0, 5);
      return [
        `Mediana: ${duracao(mediana(tempos))}. p90: ${duracao(percentil(tempos, 0.9))}. Pior caso: ${duracao(Math.max(0, ...tempos))}.`,
        `Respondidas: ${resp.length} de ${kpis.length}. Ainda sem nenhuma resposta: ${semResposta.length}.`,
        ...bloco(
          'Piores casos (setor · dono · tempo)',
          piores.map(
            (c) =>
              `- ${nomeSetor(c)} · ${nomeDono(c, ctx)} · ${duracao(minutos(c.aberta_em, c.primeira_resposta_em!))}`,
          ),
        ),
        ...bloco(
          'Mediana por setor',
          medianaPorGrupo(resp, nomeSetor, (c) => minutos(c.aberta_em, c.primeira_resposta_em!)),
        ),
        ...bloco(
          'Sem resposta, por dono',
          ranking(contarPor(semResposta, (c) => nomeDono(c, ctx))),
        ),
      ];
    }

    case 'kpi_atendimento': {
      const fechadas = kpis.filter((c) => c.status === 'fechado' && c.fechada_em);
      const durs = fechadas.map((c) => minutos(c.aberta_em, c.fechada_em!));
      const longas = [...fechadas]
        .sort((a, b) => minutos(b.aberta_em, b.fechada_em!) - minutos(a.aberta_em, a.fechada_em!))
        .slice(0, 5);
      return [
        `Fechadas na janela: ${fechadas.length}. Média: ${duracao(media(durs))}. Mediana: ${duracao(mediana(durs))}.`,
        `Ainda abertas: ${kpis.length - kpis.filter((c) => c.status === 'fechado').length} (não entram nesta média).`,
        ...bloco(
          'Casos mais longos (setor · dono · duração)',
          longas.map(
            (c) =>
              `- ${nomeSetor(c)} · ${nomeDono(c, ctx)} · ${duracao(minutos(c.aberta_em, c.fechada_em!))}`,
          ),
        ),
        ...bloco(
          'Média por setor',
          mediaPorGrupo(fechadas, nomeSetor, (c) => minutos(c.aberta_em, c.fechada_em!)),
        ),
      ];
    }

    case 'kpi_espera':
      /* Bloco de honestidade (invariante I7). Não existe coluna que registre
       * quando a conversa foi atribuída — o número da tela sai de duas fórmulas
       * de aproximação diferentes conforme a forma do dado. Dar contexto
       * "rico" aqui só produziria conclusão operacional em cima de mock. */
      return [
        'ESTE INDICADOR É MOCK. Não existe em hub.conversas nenhuma coluna que registre',
        'o instante em que a conversa foi atribuída a um atendente, então a espera na fila',
        'não é medida: é aproximada pela média do tempo até a 1ª resposta das conversas sem',
        'dono ou, quando não há nenhuma, pela mediana geral multiplicada por 0,4.',
        'Diga isso na primeira linha da resposta e NÃO recomende nada com base neste número.',
        'O que dá para dizer com dado real: ' +
          `${kpis.filter((c) => c.status !== 'fechado' && !c.atendente_id).length} conversas abertas estão sem dono agora.`,
      ];

    case 'kpi_fechamento': {
      const fechadas = kpis.filter((c) => c.status === 'fechado');
      const vendeu = fechadas.filter((c) => c.desfecho === 'vendeu');
      const perdeu = fechadas.filter((c) => c.desfecho === 'nao_vendeu');
      return [
        `Fechadas: ${fechadas.length}. Vendeu: ${vendeu.length}. Não vendeu: ${perdeu.length}. Abertas: ${kpis.length - fechadas.length}.`,
        ...bloco(
          'Taxa por setor (vendeu/fechadas)',
          taxaPorGrupo(fechadas, nomeSetor, (c) => c.desfecho === 'vendeu'),
        ),
        ...bloco(
          'Taxa por dono (vendeu/fechadas)',
          taxaPorGrupo(
            fechadas,
            (c) => nomeDono(c, ctx),
            (c) => c.desfecho === 'vendeu',
          ),
        ),
        ...bloco(
          'Motivos do "não vendeu"',
          ranking(contarPor(perdeu, (c) => c.motivo_perda ?? 'sem motivo registrado')),
        ),
      ];
    }

    case 'kpi_nota': {
      const comNota = kpis.filter((c) => typeof c.nota_satisfacao === 'number');
      const dist = [1, 2, 3, 4, 5].map(
        (n) => `- nota ${n}: ${comNota.filter((c) => c.nota_satisfacao === n).length}`,
      );
      const ruins = comNota.filter((c) => (c.nota_satisfacao ?? 5) <= 3);
      return [
        `Conversas com nota: ${comNota.length} de ${kpis.length}. Média: ${comNota.length ? media(comNota.map((c) => c.nota_satisfacao!)).toFixed(1) : 'sem notas'}.`,
        ...bloco('Distribuição', dist),
        ...bloco(
          'Notas 3 ou menos (setor · dono · nota)',
          ruins
            .slice(0, 5)
            .map((c) => `- ${nomeSetor(c)} · ${nomeDono(c, ctx)} · ${c.nota_satisfacao}`),
        ),
      ];
    }

    case 'kpi_sla': {
      /* Denominador espelhado de painel.tsx: "decididas" exclui a conversa sem
       * resposta cujo prazo AINDA NÃO venceu — ela não é violação nem
       * cumprimento. Contá-la tornava o indicador estruturalmente pessimista
       * em "Hoje". */
      const decididas = kpis.filter(
        (c) =>
          c.primeira_resposta_em || minutos(c.aberta_em, ctx.agoraISO) > META_PRIMEIRA_RESPOSTA_MIN,
      );
      const dentro = decididas.filter(
        (c) =>
          c.primeira_resposta_em &&
          minutos(c.aberta_em, c.primeira_resposta_em) <= META_PRIMEIRA_RESPOSTA_MIN,
      );
      const violaram = decididas.filter((c) => !dentro.includes(c));
      const noPrazo = kpis.filter(
        (c) =>
          !c.primeira_resposta_em &&
          minutos(c.aberta_em, ctx.agoraISO) <= META_PRIMEIRA_RESPOSTA_MIN,
      );
      return [
        `Meta: ${META_PRIMEIRA_RESPOSTA_MIN} min. Decididas: ${decididas.length}. Dentro da meta: ${dentro.length}. Violações: ${violaram.length}.`,
        `Ainda dentro do prazo (excluídas do denominador, o relógio está correndo): ${noPrazo.length}.`,
        ...bloco(
          'Violações por setor',
          ranking(contarPor(violaram, nomeSetor)),
        ),
        ...bloco(
          'Violações por dono',
          ranking(contarPor(violaram, (c) => nomeDono(c, ctx))),
        ),
        ...bloco(
          'Piores violações (setor · dono · tempo até responder)',
          violaram
            .slice(0, 5)
            .map(
              (c) =>
                `- ${nomeSetor(c)} · ${nomeDono(c, ctx)} · ${
                  c.primeira_resposta_em
                    ? duracao(minutos(c.aberta_em, c.primeira_resposta_em))
                    : 'ainda sem resposta'
                }`,
            ),
        ),
      ];
    }

    case 'kpi_csat': {
      const solicitadas = kpis.filter((c) => c.avaliacao_solicitada_em);
      const respondidas = kpis.filter((c) => c.avaliacao_registrada_em);
      const fechadas = kpis.filter((c) => c.status === 'fechado');
      return [
        `Pesquisas enviadas: ${solicitadas.length}. Respondidas: ${respondidas.length}. Chamados fechados na janela: ${fechadas.length}.`,
        `Fechados SEM pesquisa enviada: ${fechadas.length - solicitadas.filter((c) => c.status === 'fechado').length} (a pesquisa é opcional na finalização).`,
        'A coorte é por data de ABERTURA do chamado, não de envio da pesquisa: a pesquisa sai no fechamento e a resposta pode chegar depois, então em janelas curtas este número nasce baixo.',
        ...bloco('Enviadas por setor', ranking(contarPor(solicitadas, nomeSetor))),
        ...bloco('Respondidas por setor', ranking(contarPor(respondidas, nomeSetor))),
      ];
    }

    case 'linha_saude': {
      const doCanal = foco.recorte?.canalId
        ? todas.filter((c) => c.canal_id === foco.recorte!.canalId)
        : [];
      if (!ctx.canal) {
        return [
          'Não encontrei esta linha dentro do escopo deste usuário. Diga que não tem a informação.',
        ];
      }
      return [
        `Linha: ${ctx.canal.nome}. Transporte: ${ctx.canal.transporte ?? 'não informado'}.`,
        // `hub.canais.status` saiu daqui: nenhum código escreve essa coluna,
        // ela vale 'verde' desde o insert para sempre. Mandá-la como "status
        // registrado" fazia a Alice explicar a saúde da linha a partir de uma
        // constante. `conexao_status` é o que o adapter escreve de verdade.
        `Conexão: ${ctx.canal.conexao_status ?? 'não informada'}.`,
        ctx.canal.conexao_status === 'conectado'
          ? 'A linha está recebendo mensagens.'
          : 'ATENÇÃO: a linha NÃO está recebendo mensagens neste momento.',
        `Conversas por esta linha na janela: ${doCanal.length}.`,
        'UPTIME E TAXA DE ENTREGA SÃO MOCK: não existe coluna que os meça.',
        'Diga isso na primeira linha e não trate esses percentuais como medição.',
        ...bloco('Conversas desta linha por setor', ranking(contarPor(doCanal, nomeSetor))),
      ];
    }

    case 'alerta_risco': {
      const c = todas[0];
      if (!c) {
        return [
          'Não encontrei esta conversa dentro do escopo deste usuário. Diga que não tem a informação.',
        ];
      }
      return [
        `Conversa em risco ${c.risco ?? 'não classificado'}, setor ${nomeSetor(c)}, dono ${nomeDono(c, ctx)}.`,
        `Motivo do risco registrado pela IA: ${c.risco_motivo ?? 'não registrado'}.`,
        `Assunto: ${c.titulo_ia ?? 'sem título gerado'}.`,
        `Resumo: ${c.resumo_ia ?? 'sem resumo gerado'}.`,
        `Sentimento: ${c.sentimento ?? 'não classificado'}. Status: ${c.status}.`,
        `Aberta há ${duracao(minutos(c.aberta_em, ctx.agoraISO))}. ` +
          (c.primeira_resposta_em
            ? `1ª resposta em ${duracao(minutos(c.aberta_em, c.primeira_resposta_em))}.`
            : 'AINDA SEM PRIMEIRA RESPOSTA.'),
      ];
    }

    case 'sentimento_celula': {
      const cel = kpis;
      const neg = cel.filter((c) => c.sentimento === 'negativo');
      const doSetor = comSetor(ctx.atuais).filter(
        (c) => c.setor_id === foco.recorte?.setorId && c.sentimento,
      );
      return [
        `Nesta célula: ${cel.length} conversas — positivo ${cel.filter((c) => c.sentimento === 'positivo').length}, ` +
          `neutro ${cel.filter((c) => c.sentimento === 'neutro').length}, negativo ${neg.length}.`,
        `No setor inteiro (todos os atendentes): ${doSetor.length} classificadas, ` +
          `sendo ${doSetor.filter((c) => c.sentimento === 'negativo').length} negativas.`,
        ...bloco(
          'As conversas negativas desta célula',
          neg
            .slice(0, 5)
            .map(
              (c) =>
                `- ${c.titulo_ia ?? 'sem título'} · risco ${c.risco ?? 'não classificado'} · ${c.risco_motivo ?? c.resumo_ia ?? 'sem motivo registrado'}`,
            ),
        ),
      ];
    }

    case 'perda_motivo': {
      const perdidas = kpis.filter((c) => c.desfecho === 'nao_vendeu');
      const antesPerdidas = comSetor(antes).filter((c) => c.desfecho === 'nao_vendeu');
      const vendidas = comSetor(ctx.atuais).filter((c) => c.desfecho === 'vendeu' && c.valor_venda);
      const ticket = media(vendidas.map((c) => Number(c.valor_venda)));
      return [
        `Perdas com este motivo na janela: ${perdidas.length}. Na janela anterior: ${antesPerdidas.length}.`,
        `Valor ESTIMADO (ticket médio de ${vendidas.length} vendas × ${perdidas.length} perdas): R$ ${(ticket * perdidas.length).toFixed(2)}. É estimativa, não valor contábil — o banco só grava valor no que fechou vendendo.`,
        ...bloco('Por setor', ranking(contarPor(perdidas, nomeSetor))),
        ...bloco(
          'Por dono',
          ranking(contarPor(perdidas, (c) => nomeDono(c, ctx))),
        ),
      ];
    }

    case 'perda_resumo': {
      const perdidas = kpis.filter((c) => c.desfecho === 'nao_vendeu' && c.motivo_perda);
      const vendidas = kpis.filter((c) => c.desfecho === 'vendeu' && c.valor_venda);
      const ticket = media(vendidas.map((c) => Number(c.valor_venda)));
      return [
        `Perdas na janela: ${perdidas.length}. Na anterior: ${comSetor(antes).filter((c) => c.desfecho === 'nao_vendeu' && c.motivo_perda).length}.`,
        `Valor ESTIMADO total: R$ ${(ticket * perdidas.length).toFixed(2)} (ticket médio × nº de perdas — estimativa, não valor contábil).`,
        ...bloco(
          'Ranking de motivos',
          ranking(contarPor(perdidas, (c) => c.motivo_perda!)),
        ),
        ...bloco('Perdas por setor', ranking(contarPor(perdidas, nomeSetor))),
      ];
    }

    case 'area_setor': {
      const abertas = kpis.filter((c) => c.status !== 'fechado');
      const semDono = abertas.filter((c) => !c.atendente_id);
      const maisAntiga = [...semDono].sort(
        (a, b) => new Date(a.aberta_em).getTime() - new Date(b.aberta_em).getTime(),
      )[0];
      const resp = kpis.filter((c) => c.primeira_resposta_em);
      const geral = comSetor(ctx.atuais).filter((c) => c.primeira_resposta_em);
      return [
        `Total: ${kpis.length}. Abertas: ${abertas.length}. Sem dono: ${semDono.length}. Fechadas: ${kpis.length - abertas.length}.`,
        `Mediana da 1ª resposta neste setor: ${duracao(mediana(resp.map((c) => minutos(c.aberta_em, c.primeira_resposta_em!))))} ` +
          `(média geral de todos os setores: ${duracao(mediana(geral.map((c) => minutos(c.aberta_em, c.primeira_resposta_em!))))}).`,
        maisAntiga
          ? `Mais antiga sem dono: aberta há ${duracao(minutos(maisAntiga.aberta_em, ctx.agoraISO))}${maisAntiga.titulo_ia ? ` — "${maisAntiga.titulo_ia}"` : ''}.`
          : 'Nenhuma conversa aberta sem dono neste setor.',
        ...bloco(
          'Carga por dono (só as abertas)',
          ranking(contarPor(abertas, (c) => nomeDono(c, ctx))),
        ),
      ];
    }

    case 'atendente_linha': {
      const suas = kpis;
      const equipe = comSetor(ctx.atuais);
      const respS = suas.filter((c) => c.primeira_resposta_em);
      const respE = equipe.filter((c) => c.primeira_resposta_em);
      const fechS = suas.filter((c) => c.status === 'fechado');
      const fechE = equipe.filter((c) => c.status === 'fechado');
      const taxa = (f: ConversaFoco[]) =>
        f.length ? Math.round((f.filter((c) => c.desfecho === 'vendeu').length / f.length) * 100) : 0;
      return [
        `Deste atendente: ${suas.length} chamados. Da equipe inteira na mesma janela: ${equipe.length}.`,
        `1ª resposta (média) — ele: ${duracao(media(respS.map((c) => minutos(c.aberta_em, c.primeira_resposta_em!))))} · equipe: ${duracao(media(respE.map((c) => minutos(c.aberta_em, c.primeira_resposta_em!))))}.`,
        `Fechamento — ele: ${taxa(fechS)}% de ${fechS.length} fechados · equipe: ${taxa(fechE)}% de ${fechE.length}.`,
        `Carga aberta agora: ${suas.filter((c) => c.status !== 'fechado').length}.`,
        ...bloco('Chamados dele por setor', ranking(contarPor(suas, nomeSetor))),
      ];
    }

    // ----- faixas inteiras -----
    case 'faixa_saude':
      return [
        'A faixa mostra uma caixa por linha de WhatsApp conectada à(s) empresa(s) em escopo.',
        'UPTIME E ENTREGA SÃO MOCK — não há telemetria de entrega no produto. O que é real é o status da conexão.',
        ...bloco(
          'Conversas por linha na janela',
          ranking(contarPor(kpis, (c) => c.canal_id ?? 'sem canal')),
        ),
      ];

    case 'faixa_numeros':
      return [
        `Chamados: ${kpis.length} (janela anterior: ${comSetor(antes).length}).`,
        `1ª resposta (mediana): ${duracao(mediana(kpis.filter((c) => c.primeira_resposta_em).map((c) => minutos(c.aberta_em, c.primeira_resposta_em!))))}.`,
        `Fechadas: ${kpis.filter((c) => c.status === 'fechado').length}. Sem dono e abertas: ${kpis.filter((c) => c.status !== 'fechado' && !c.atendente_id).length}.`,
        'Dois cards desta faixa são MOCK: "Espera na fila" (não há registro de atribuição).',
        'Aponte o indicador que mais destoa e o que fazer sobre ele — não descreva todos.',
      ];

    case 'faixa_alertas': {
      const emRisco = ctx.atuais.filter(
        (c) => !c.fechada_em && (c.risco === 'alto' || c.risco === 'medio'),
      );
      return [
        `Conversas abertas com risco: ${emRisco.length} (alto: ${emRisco.filter((c) => c.risco === 'alto').length}).`,
        'Esta faixa ignora o filtro de período de propósito: risco é sobre o agora.',
        ...bloco(
          'Os riscos abertos',
          emRisco
            .slice(0, 10)
            .map(
              (c) =>
                `- risco ${c.risco} · ${nomeSetor(c)} · ${nomeDono(c, ctx)} · ${c.risco_motivo ?? 'sem motivo registrado'}`,
            ),
        ),
      ];
    }

    case 'faixa_sentimento': {
      const classificadas = kpis.filter((c) => c.sentimento);
      return [
        `Classificadas: ${classificadas.length} de ${kpis.length}. ` +
          `Positivo ${classificadas.filter((c) => c.sentimento === 'positivo').length}, ` +
          `neutro ${classificadas.filter((c) => c.sentimento === 'neutro').length}, ` +
          `negativo ${classificadas.filter((c) => c.sentimento === 'negativo').length}.`,
        ...bloco(
          'Negativas por setor',
          ranking(contarPor(classificadas.filter((c) => c.sentimento === 'negativo'), nomeSetor)),
        ),
        ...bloco(
          'Negativas por dono',
          ranking(
            contarPor(
              classificadas.filter((c) => c.sentimento === 'negativo'),
              (c) => nomeDono(c, ctx),
            ),
          ),
        ),
      ];
    }

    case 'faixa_perdas':
      return detalharFoco({ ...foco, tipo: 'perda_resumo' }, ctx);

    case 'faixa_areas': {
      const linhas = [...new Set(kpis.map(nomeSetor))].map((s) => {
        const cs = kpis.filter((c) => nomeSetor(c) === s);
        const ab = cs.filter((c) => c.status !== 'fechado');
        return `- ${s}: ${cs.length} total, ${ab.length} abertos, ${ab.filter((c) => !c.atendente_id).length} sem dono`;
      });
      return [`Setores com movimento na janela: ${linhas.length}.`, ...bloco('Por setor', linhas)];
    }

    case 'faixa_atendentes': {
      const donos = [...new Set(kpis.map((c) => c.atendente_id).filter(Boolean))] as string[];
      const linhas = donos.map((id) => {
        const suas = kpis.filter((c) => c.atendente_id === id);
        const resp = suas.filter((c) => c.primeira_resposta_em);
        const fech = suas.filter((c) => c.status === 'fechado');
        return (
          `- ${ctx.nomesAtendentes.get(id) ?? 'atendente'}: ${suas.length} chamados, ` +
          `1ª resposta ${duracao(media(resp.map((c) => minutos(c.aberta_em, c.primeira_resposta_em!))))}, ` +
          `${fech.length} fechados`
        );
      });
      const semDono = kpis.filter((c) => !c.atendente_id).length;
      return [
        `Atendentes com movimento: ${linhas.length}. Chamados sem dono na janela: ${semDono}.`,
        ...bloco('Por atendente', linhas),
      ];
    }
  }
}

/** Título + linhas, ou nada quando não há linha — evita cabeçalho órfão no prompt. */
function bloco(titulo: string, linhas: string[]): string[] {
  return linhas.length ? [`${titulo}:`, ...linhas] : [];
}

function medianaPorGrupo(
  cs: ConversaFoco[],
  chave: (c: ConversaFoco) => string,
  valor: (c: ConversaFoco) => number,
): string[] {
  const m = new Map<string, number[]>();
  for (const c of cs) m.set(chave(c), [...(m.get(chave(c)) ?? []), valor(c)]);
  return [...m.entries()]
    .sort((a, b) => mediana(b[1]) - mediana(a[1]))
    .map(([k, xs]) => `- ${k}: ${duracao(mediana(xs))} (${xs.length})`);
}

function mediaPorGrupo(
  cs: ConversaFoco[],
  chave: (c: ConversaFoco) => string,
  valor: (c: ConversaFoco) => number,
): string[] {
  const m = new Map<string, number[]>();
  for (const c of cs) m.set(chave(c), [...(m.get(chave(c)) ?? []), valor(c)]);
  return [...m.entries()]
    .sort((a, b) => media(b[1]) - media(a[1]))
    .map(([k, xs]) => `- ${k}: ${duracao(media(xs))} (${xs.length})`);
}

function taxaPorGrupo(
  cs: ConversaFoco[],
  chave: (c: ConversaFoco) => string,
  acerto: (c: ConversaFoco) => boolean,
): string[] {
  const m = new Map<string, { n: number; ok: number }>();
  for (const c of cs) {
    const k = chave(c);
    const v = m.get(k) ?? { n: 0, ok: 0 };
    v.n += 1;
    if (acerto(c)) v.ok += 1;
    m.set(k, v);
  }
  return [...m.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([k, v]) => `- ${k}: ${Math.round((v.ok / v.n) * 100)}% (${v.ok}/${v.n})`);
}

// ---------------------------------------------------------------------------
// conferirValor — a invariante I4
// ---------------------------------------------------------------------------

/**
 * Recalcula a métrica focada com a MESMA regra do front e compara com o que
 * está na tela.
 *
 * Compara STRINGS FORMATADAS, não números: o card mostra "4 min", e a pergunta
 * que importa não é "os floats batem?" e sim "a Alice vai citar o mesmo texto
 * que o gestor está lendo?". Por isso os formatadores daqui espelham os do
 * Painel.
 *
 * Devolve `null` quando não há o que conferir (indicador mock, faixa inteira) —
 * nesses casos o próprio bloco de detalhes já carrega a declaração.
 */
export function conferirValor(foco: AliceFoco, ctx: ContextoFoco): string | null {
  const todas = recortar(ctx.atuais, foco.recorte);
  const kpis = comSetor(todas);
  const descartadas = todas.length - kpis.length;

  const calculado = recalcular(foco, kpis, ctx);
  if (calculado === null) return null;

  const nota =
    descartadas > 0
      ? ` ${descartadas} conversa(s) sem setor foram excluídas do cálculo, como o Painel também exclui.`
      : '';

  if (calculado === foco.valor) {
    return `Conferência: valor na tela "${foco.valor}"; recalculado no servidor "${calculado}". Sem divergência.${nota}`;
  }
  return (
    `Conferência: valor na tela "${foco.valor}"; recalculado no servidor "${calculado}". HÁ DIVERGÊNCIA.` +
    `${nota} Trate o valor da tela como o número da conversa e explique a diferença em UMA frase ` +
    `(causas prováveis: conversas criadas depois de a tela carregar, conversas sem setor, ou contexto truncado).`
  );
}

function recalcular(foco: AliceFoco, kpis: ConversaFoco[], ctx: ContextoFoco): string | null {
  switch (foco.tipo) {
    case 'kpi_chamados':
      return String(kpis.length);

    case 'kpi_primeira_resposta':
      return duracao(
        mediana(
          kpis
            .filter((c) => c.primeira_resposta_em)
            .map((c) => minutos(c.aberta_em, c.primeira_resposta_em!)),
        ),
      );

    case 'kpi_atendimento':
      return duracao(
        media(
          kpis
            .filter((c) => c.status === 'fechado' && c.fechada_em)
            .map((c) => minutos(c.aberta_em, c.fechada_em!)),
        ),
      );

    case 'kpi_fechamento': {
      const f = kpis.filter((c) => c.status === 'fechado');
      const v = f.filter((c) => c.desfecho === 'vendeu');
      return `${Math.round(f.length ? (v.length / f.length) * 100 : 0)}%`;
    }

    case 'kpi_nota': {
      const notas = kpis.map((c) => c.nota_satisfacao).filter((n): n is number => !!n);
      return notas.length ? media(notas).toFixed(1) : '—';
    }

    case 'kpi_sla': {
      const decididas = kpis.filter(
        (c) =>
          c.primeira_resposta_em || minutos(c.aberta_em, ctx.agoraISO) > META_PRIMEIRA_RESPOSTA_MIN,
      );
      if (!decididas.length) return '—';
      const dentro = decididas.filter(
        (c) =>
          c.primeira_resposta_em &&
          minutos(c.aberta_em, c.primeira_resposta_em) <= META_PRIMEIRA_RESPOSTA_MIN,
      );
      return `${Math.round((dentro.length / decididas.length) * 100)}%`;
    }

    case 'kpi_csat': {
      const sol = kpis.filter((c) => c.avaliacao_solicitada_em).length;
      if (!sol) return '—';
      const resp = kpis.filter((c) => c.avaliacao_registrada_em).length;
      return `${Math.round((resp / sol) * 100)}%`;
    }

    case 'area_setor':
      return String(kpis.length);

    case 'atendente_linha':
      return String(kpis.length);

    case 'sentimento_celula':
      return String(kpis.filter((c) => c.sentimento).length);

    /* Sem recálculo, e não é omissão:
     * - kpi_espera / linha_saude / faixa_saude: mock (I7), o bloco de detalhes
     *   já manda declarar. Recalcular um mock daria ao número uma autoridade
     *   que ele não tem.
     * - perda_*: o card mostra percentual do total de perdas, e o valor em R$ é
     *   estimado pelo ticket médio — o bloco de detalhes já traz os dois com a
     *   ressalva.
     * - alerta_risco / faixa_*: não têm um "valor" numérico único na tela. */
    default:
      return null;
  }
}
