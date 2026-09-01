// Análise de IA por conversa — sentimento, risco de escalonamento e motivo
// provável de perda, tudo numa chamada só à Anthropic. Ver
// PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md (raiz do repo), fase 1.
//
// Alimenta quatro lugares da UI:
//   · Painel → bloco "Sentimento por atendente × setor" (conversas.sentimento
//     já existia e já era lido; até aqui nada no código o preenchia).
//   · Painel → faixa "Alertas proativos" (risco médio/alto em conversa aberta).
//   · Caixa → banner acima do campo de resposta, para o atendente ver o risco
//     ANTES de responder. Chega sozinho na tela aberta: hub.conversas está na
//     publicação Realtime, então o update feito aqui vira um evento no canal
//     "caixa" que o front já assina. Sem poll, sem WebSocket novo.
//   · Caixa → coach: respostas sugeridas clicáveis + orientações de conduta na
//     Ficha (PLANO_COACH_RESPOSTA_E_CONDUTA.md, fase 4). Vem na MESMA chamada
//     à Anthropic, não numa segunda: o prompt já carrega a conversa inteira, e
//     o atendente sob pressão não pode esperar uma ida e volta extra.
//
// Contrato de fire-and-forget, igual ao de resumoIA.ts: analisarConversa
// NUNCA relança. Quem dispara está no caminho crítico do adapter/webhook que
// grava a mensagem recebida — uma falha da Anthropic não pode derrubar nem
// atrasar isso. Falha vira conversas.analise_ia_erro, não exceção.
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../db/client.server.js';
import { linhaParaPrompt, obterCliente } from './resumoIA.js';

// Decisão registrada no §13 do plano: Opus 5 para a classificação. O volume é
// baixo (uma chamada por rajada de mensagens de cliente, com debounce) e a
// qualidade da leitura de tom é o que dá valor ao alerta. Se o volume crescer
// a ponto de o custo pesar, trocar esta constante por 'claude-haiku-4-5' é a
// única mudança necessária.
const MODELO = 'claude-opus-5';
const JANELA_DEBOUNCE_MS = 10_000;
const MAX_MENSAGENS = 50;
// Na Opus 5 o thinking é ligado por padrão, o `effort` padrão da API é `high`,
// e `max_tokens` limita thinking + resposta JUNTOS. O JSON de saída tem ~80
// tokens; todo o resto é espaço de raciocínio sobre um prompt que carrega até
// 50 mensagens.
//
// Começou em 2000 e foi elevado na auditoria: 2000 tornaria o truncamento o
// caso comum, não o excepcional — e truncar aqui é especialmente traiçoeiro
// porque o serviço é fire-and-forget: o Painel simplesmente nunca ganharia
// sentimento, com o motivo escondido numa coluna que ninguém lê. Teto alto não
// custa: cobra-se pelo que é gerado, não pelo limite.
const MAX_TOKENS = 8000;

export type Sentimento = 'positivo' | 'neutro' | 'negativo';
export type Risco = 'baixo' | 'medio' | 'alto';

const SENTIMENTOS: readonly string[] = ['positivo', 'neutro', 'negativo'];
const RISCOS: readonly string[] = ['baixo', 'medio', 'alto'];

/** Teto do texto gravado em conversas.risco_motivo. Cabe numa linha do banner
 *  da Caixa e num item da lista de alertas do Painel sem quebrar o layout. */
const RISCO_MOTIVO_MAX = 200;

/* Tetos do coach (fase 4). Aplicados no validador, NÃO como constraint no
 * banco: um check em conversas rejeitaria o UPDATE inteiro e levaria junto um
 * sentimento e um risco que estavam corretos — o mesmo tropeço que o validador
 * da fase 1 existe para evitar. Aqui o texto é aparado antes de chegar lá. */
const SUGESTAO_MAX = 300;
const ORIENTACAO_MAX = 220;
const MAX_SUGESTOES = 3;
const MAX_ORIENTACOES = 4;

export interface AnaliseConversa {
  sentimento: Sentimento;
  risco: Risco;
  riscoMotivo: string | null;
  motivoPerdaProvavel: string | null;
  /** Respostas prontas para o atendente CLICAR e revisar. Null quando o risco
   *  é baixo — conversa tranquila não precisa de coach e não paga token por ele. */
  sugestoes: string[] | null;
  orientacoes: string[] | null;
}

interface MensagemParaAnalise {
  autor: string;
  texto: string | null;
  midia_tipo: string | null;
  tipo_mensagem: string | null;
  transcricao: string | null;
  enviada_em: string;
}

interface MotivoPerda {
  id: string;
  nome: string;
}

/** Contexto de identificação que entra no cabeçalho do prompt. Sem ele as
 *  sugestões saem genéricas ("Prezado cliente"), que é exatamente o tom que
 *  irrita mais um cliente já irritado. */
export interface ContextoConversa {
  clienteNome: string | null;
  setorNome: string | null;
  atendenteNome: string | null;
}

function montarPrompt(
  mensagens: MensagemParaAnalise[],
  motivos: MotivoPerda[],
  contexto: ContextoConversa,
): string {
  // Mesma renderização do resumo (services/resumoIA.ts): uma fonte só para a
  // regra de "como uma mensagem vira linha de prompt". Duas cópias divergem — e
  // divergir aqui significaria o resumo enxergar o áudio transcrito e a análise
  // de risco continuar cega para ele.
  const linhas = mensagens.map(linhaParaPrompt);

  const listaMotivos = motivos.length
    ? motivos.map((m) => `- ${m.nome}`).join('\n')
    : '(a empresa não cadastrou motivos de perda)';

  const identificacao: string[] = [];
  if (contexto.clienteNome) identificacao.push(`- Nome do cliente: ${contexto.clienteNome}`);
  if (contexto.setorNome) identificacao.push(`- Setor que atende: ${contexto.setorNome}`);
  if (contexto.atendenteNome) identificacao.push(`- Nome do atendente: ${contexto.atendenteNome}`);
  const blocoIdentificacao = identificacao.length ? `\nContexto:\n${identificacao.join('\n')}\n` : '';

  return (
    'Você analisa conversas de atendimento via WhatsApp entre uma empresa e um cliente.\n' +
    'Leia a conversa abaixo e responda APENAS com um objeto JSON, sem texto antes ou depois, ' +
    'sem cercas de código, com exatamente estas seis chaves:\n' +
    '\n' +
    '{\n' +
    '  "sentimento": "positivo" | "neutro" | "negativo",\n' +
    '  "risco": "baixo" | "medio" | "alto",\n' +
    '  "risco_motivo": "uma frase curta em português explicando o sinal de risco, ou null se o risco for baixo",\n' +
    '  "motivo_perda_provavel": "um dos motivos da lista abaixo, copiado exatamente, ou null",\n' +
    `  "sugestoes_resposta": ["...", "...", "..."] ou null,\n` +
    '  "orientacoes": ["...", "..."] ou null\n' +
    '}\n' +
    '\n' +
    'Como classificar:\n' +
    '- sentimento: o tom do CLIENTE ao longo da conversa, não o do atendente.\n' +
    '- risco: chance de esta conversa virar um problema (cliente perdido, reclamação formal, ' +
    'escalonamento). Sinais de risco alto: irritação explícita, cobrança repetida sobre o mesmo ' +
    'assunto, menção a concorrente, ameaça de cancelar, longa espera sem resposta do atendente. ' +
    'Risco médio: insatisfação contida, urgência não atendida, dúvida repetida. ' +
    'Na dúvida, classifique como "baixo" — um alarme falso custa mais credibilidade do que um ' +
    'alerta a menos, porque o atendente para de olhar os alertas.\n' +
    '- risco_motivo: só preencha quando o risco for médio ou alto, citando o que na conversa ' +
    'sustenta isso. Seja concreto ("cliente cobrou o mesmo pedido três vezes sem resposta"), ' +
    'não genérico ("cliente parece insatisfeito").\n' +
    '- motivo_perda_provavel: só preencha se a conversa indicar que a venda foi ou será perdida ' +
    'e um dos motivos da lista se aplicar. Copie o texto do motivo exatamente como está na lista. ' +
    'Se nenhum se aplicar, ou se ainda não há sinal de perda, responda null.\n' +
    `- sugestoes_resposta: preencha SOMENTE se o risco for "medio" ou "alto"; caso contrário, null. ` +
    `Exatamente ${MAX_SUGESTOES} respostas prontas para o atendente enviar ao cliente AGORA, ` +
    'escritas na voz do atendente, em português do Brasil, no máximo ' +
    `${SUGESTAO_MAX} caracteres cada. As três devem ter ângulos DIFERENTES: (1) acolher e pedir ` +
    'o detalhe que falta para resolver; (2) reconhecer o problema e oferecer o próximo passo ' +
    'concreto; (3) oferecer escalonamento (levar a um responsável, ligar para o cliente). ' +
    'NUNCA prometa prazo, desconto, reembolso, troca, crédito ou qualquer compromisso que não ' +
    'esteja escrito nas mensagens — o atendente não tem como saber se a empresa consegue cumprir. ' +
    'Nada de campos para preencher tipo [nome] ou [data], nada de emoji, nada de saudação genérica ' +
    'do tipo "Prezado cliente" quando o nome do cliente está no contexto.\n' +
    `- orientacoes: preencha SOMENTE se o risco for "medio" ou "alto"; caso contrário, null. ` +
    `De 2 a ${MAX_ORIENTACOES} itens, no máximo ${ORIENTACAO_MAX} caracteres cada, dirigidos ao ` +
    'ATENDENTE (não ao cliente), sobre COMO CONDUZIR esta conversa: que tom usar, o que evitar ' +
    'dizer, o que reconhecer antes de explicar, quando escalar. Cada item preso ao que aconteceu ' +
    'nESTA conversa. Não escreva conselho genérico como "seja educado" ou "mantenha a calma" — ' +
    'isso já é mostrado ao atendente por outro caminho e repetir só ocupa espaço.\n' +
    '\n' +
    'Motivos de perda cadastrados pela empresa:\n' +
    `${listaMotivos}\n` +
    blocoIdentificacao +
    '\n' +
    'Não invente informação que não está nas mensagens. Sempre produza o JSON completo, mesmo ' +
    'com pouca conversa — uma conversa curta e cordial é {"sentimento":"neutro","risco":"baixo",' +
    '"risco_motivo":null,"motivo_perda_provavel":null,"sugestoes_resposta":null,"orientacoes":null}. ' +
    'Nunca recuse nem peça mais mensagens.\n' +
    '\n' +
    'Conversa:\n' +
    linhas.join('\n')
  );
}

/**
 * Extrai e valida o JSON da resposta do modelo.
 *
 * Deliberadamente defensivo em duas camadas, porque o SDK instalado
 * (@anthropic-ai/sdk 0.71.2) ainda não expõe structured outputs
 * (`output_config.format`), então o formato é pedido por prompt e não
 * garantido pela API:
 *
 *   1. Recorte: pega do primeiro `{` ao último `}`, o que sobrevive a cercas
 *      de código ou a uma frase de preâmbulo que o modelo tenha adicionado.
 *   2. Validação por campo: qualquer valor fora do domínio esperado cai no
 *      default seguro (`neutro`/`baixo`) em vez de propagar lixo para o banco
 *      — onde os constraints conversas_risco_valido rejeitariam o update
 *      INTEIRO, levando o sentimento junto.
 *
 * Devolve null só quando não há JSON algum de onde tirar nada; nesse caso
 * quem chama trata como erro e grava analise_ia_erro.
 */
export function interpretarAnalise(texto: string): AnaliseConversa | null {
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio === -1 || fim <= inicio) return null;

  let bruto: unknown;
  try {
    bruto = JSON.parse(texto.slice(inicio, fim + 1));
  } catch {
    return null;
  }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;

  const obj = bruto as Record<string, unknown>;
  const normalizar = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

  const sentimentoBruto = normalizar(obj.sentimento);
  const riscoBruto = normalizar(obj.risco);

  const sentimento = (SENTIMENTOS.includes(sentimentoBruto) ? sentimentoBruto : 'neutro') as Sentimento;
  const risco = (RISCOS.includes(riscoBruto) ? riscoBruto : 'baixo') as Risco;

  const textoOuNulo = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const limpo = v.trim();
    if (!limpo || limpo.toLowerCase() === 'null') return null;
    return limpo.slice(0, max);
  };

  /* Lista de texto saneada. Qualquer coisa que não seja um array vira null, e
   * itens ruins são descartados um a um — a degradação é POR CAMPO. Uma chave
   * de coach quebrada não pode derrubar o sentimento e o risco junto com ela:
   * são eles que sustentam o Painel e o banner, features que já estão no ar. */
  const listaOuNulo = (v: unknown, maxItens: number, maxChars: number): string[] | null => {
    if (!Array.isArray(v)) return null;
    const itens = v
      .map((item) => textoOuNulo(item, maxChars))
      .filter((item): item is string => item !== null)
      .slice(0, maxItens);
    return itens.length ? itens : null;
  };

  // Motivo de risco sem risco é ruído no banner — o front mostraria uma
  // justificativa para um alerta que não existe. Mesma regra para o coach:
  // sugestão de resposta numa conversa tranquila é ruído que treina o
  // atendente a ignorar a faixa justamente quando ela importa.
  const semRisco = risco === 'baixo';

  return {
    sentimento,
    risco,
    riscoMotivo: semRisco ? null : textoOuNulo(obj.risco_motivo, RISCO_MOTIVO_MAX),
    motivoPerdaProvavel: textoOuNulo(obj.motivo_perda_provavel, 120),
    sugestoes: semRisco ? null : listaOuNulo(obj.sugestoes_resposta, MAX_SUGESTOES, SUGESTAO_MAX),
    orientacoes: semRisco ? null : listaOuNulo(obj.orientacoes, MAX_ORIENTACOES, ORIENTACAO_MAX),
  };
}

/**
 * Última orientação da lista: para quem escalar.
 *
 * Montada em CÓDIGO, de propósito — nome de pessoa é exatamente o tipo de dado
 * que um modelo preenche com algo plausível e errado, e um atendente mandando
 * o cliente falar com um supervisor que não existe é pior do que não sugerir
 * nada. O nome vem de hub.supervisao, lido com service_role: a policy de RLS
 * daquela tabela (`supervisor_id = meu_atendente_id()`) impede o próprio
 * operador de descobrir quem é o supervisor dele, então o front não teria como.
 */
export function orientacaoEscalonamento(supervisorNome: string | null, setorNome: string | null): string {
  const fim = ' — não improvise resposta em nome da empresa.';
  if (!supervisorNome) {
    return `Se o cliente insistir em falar com um responsável, transfira o chamado ao seu supervisor${fim}`;
  }
  const doSetor = setorNome ? ` (supervisor de ${setorNome})` : '';
  return `Se o cliente insistir em falar com um responsável, transfira o chamado ou chame ${supervisorNome}${doSetor}${fim}`;
}

/** Compara ignorando caixa, acentos e espaço extra — o modelo copia o nome do
 *  motivo do prompt, mas pode variar em maiúscula/acentuação. Sem match, a
 *  sugestão simplesmente não é gravada (null): melhor não sugerir do que
 *  sugerir o motivo errado, que o atendente confirmaria no piloto automático. */
export function resolverMotivoPerdaId(nome: string | null, motivos: MotivoPerda[]): string | null {
  if (!nome) return null;
  const chave = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const alvo = chave(nome);
  return motivos.find((m) => chave(m.nome) === alvo)?.id ?? null;
}

interface ConversaParaAnalise {
  id: string;
  fechada_em: string | null;
  setor_id: string | null;
  cliente_id: string | null;
  atendente_id: string | null;
  canais: { empresa_id: string } | null;
}

/** Nome do cliente só quando ele foi realmente identificado. Contato sem nome
 *  é gravado com `nome = telefone` (ver lib/identificacao.ts no front), e mandar
 *  o modelo tratar o cliente por "554198638874" é pior que não ter nome nenhum. */
function nomeDoCliente(nome: string | null | undefined, telefone: string | null | undefined): string | null {
  const limpo = nome?.trim();
  if (!limpo) return null;
  return limpo === telefone?.trim() ? null : limpo;
}

/** Primeiro nome do atendente — é como ele assina no WhatsApp. */
function primeiroNome(nome: string | null | undefined): string | null {
  const limpo = nome?.trim();
  return limpo ? limpo.split(/\s+/)[0] : null;
}

/** Um nome de coluna, por id, sem embed. Nunca relança: identificação é enfeite
 *  de prompt — se faltar, a sugestão sai mais impessoal e a análise segue. */
async function nomePorId(tabela: string, id: string | null, colunas = 'nome'): Promise<Record<string, string | null> | null> {
  if (!id) return null;
  const { data, error } = await supabaseAdmin.from(tabela).select(colunas).eq('id', id).maybeSingle();
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao ler ${tabela}(${id}) para o prompt da análise:`, error.message);
    return null;
  }
  return (data ?? null) as Record<string, string | null> | null;
}

/**
 * Nome do cliente, do setor e do atendente para o cabeçalho do prompt.
 *
 * Três consultas por id em vez de um embed, em paralelo. É mais verboso e
 * custa mais uma ida ao banco, e é de propósito: embed depende de o PostgREST
 * conseguir escolher a FK sozinho, e uma FK nova em QUALQUER lugar do schema
 * pode tornar isso ambíguo — foi assim que a análise inteira parou em
 * 08/08/2026. Aqui, o pior caso é uma consulta falhar e o prompt ficar sem um
 * nome.
 */
async function buscarContextoConversa(conversa: ConversaParaAnalise): Promise<ContextoConversa> {
  const [cliente, setor, atendente] = await Promise.all([
    nomePorId('clientes', conversa.cliente_id, 'nome, telefone'),
    nomePorId('setores', conversa.setor_id),
    nomePorId('atendentes', conversa.atendente_id),
  ]);
  return {
    clienteNome: nomeDoCliente(cliente?.nome, cliente?.telefone),
    setorNome: setor?.nome?.trim() || null,
    atendenteNome: primeiroNome(atendente?.nome),
  };
}

/** Nome de um supervisor do setor, ou null. Duas consultas por id, pelo mesmo
 *  motivo de buscarContextoConversa: `supervisao` tem só uma FK para atendentes
 *  hoje, mas depender disso é a aposta que já custou uma parada da IA. Roda com
 *  service_role e fora do caminho quente — só quando já se sabe que há risco. */
async function buscarSupervisor(setorId: string | null): Promise<string | null> {
  if (!setorId) return null;
  const { data, error } = await supabaseAdmin
    .from('supervisao')
    .select('supervisor_id')
    .eq('setor_id', setorId)
    .limit(1);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao buscar supervisor do setor ${setorId}:`, error.message);
    return null;
  }
  const supervisorId = ((data ?? [])[0] as { supervisor_id: string } | undefined)?.supervisor_id ?? null;
  const supervisor = await nomePorId('atendentes', supervisorId);
  return supervisor?.nome?.trim() || null;
}

async function gravar(conversaId: string, campos: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from('conversas').update(campos).eq('id', conversaId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao gravar análise de IA em hub.conversas (${conversaId}):`, error.message);
  }
}

/**
 * Classifica uma conversa a partir das últimas MAX_MENSAGENS e grava
 * sentimento, risco, motivo de perda sugerido e o coach (respostas sugeridas +
 * orientações de conduta). Sempre resolve — erro de qualquer etapa (Anthropic,
 * banco, JSON) vira analise_ia_erro, nunca uma rejeição.
 */
export async function analisarConversa(conversaId: string): Promise<void> {
  try {
    // empresa_id vem do canal, não do setor: é assim que o resto do inbound
    // resolve empresa (buscarContextoCanal em services/mensagens.ts), e a
    // conversa pode estar sem setor atribuído.
    /* Só o ESSENCIAL entra nesta consulta, e o único embed é `canais`, que já
     * estava aqui desde a fase 1.
     *
     * Incidente 08/08/2026: a primeira versão desta feature trouxe
     * `clientes(nome, telefone), setores(nome), atendentes(nome)` no mesmo
     * select. A migration da nota de atendimento, aplicada no mesmo dia, criou
     * `conversas.nota_atendimento_por` — uma SEGUNDA FK para hub.atendentes —
     * e o PostgREST passou a recusar o embed por ambiguidade. Como este select
     * é a primeira coisa que a função faz, o erro derrubou a análise INTEIRA:
     * sentimento e risco pararam de ser gravados em todas as conversas, e só
     * apareceu porque a coluna analise_ia_erro foi consultada — o serviço é
     * fire-and-forget e não reclama sozinho.
     *
     * Desambiguar com `atendentes!conversas_atendente_id_fkey` resolveria hoje
     * e continuaria refém da próxima FK que alguém adicionasse. Os nomes são
     * enfeite de prompt; sentimento e risco são o produto. Então os nomes saem
     * daqui e vão para uma consulta separada que NÃO derruba nada ao falhar. */
    const { data: conversa, error: erroConversa } = await supabaseAdmin
      .from('conversas')
      .select('id, fechada_em, setor_id, cliente_id, atendente_id, canais(empresa_id)')
      .eq('id', conversaId)
      .single<ConversaParaAnalise>();
    if (erroConversa || !conversa) throw new Error(erroConversa?.message ?? 'conversa não encontrada');

    const empresaId = conversa.canais?.empresa_id ?? null;
    // A análise é disparada com a conversa aberta, mas o debounce de 10s dá
    // tempo do atendente finalizar o chamado nesse meio. Sentimento continua
    // valendo (alimenta a matriz histórica do Painel); RISCO, não — risco é
    // sobre o que ainda pode ser evitado. Gravá-lo aqui deixaria resíduo em
    // conversa fechada, que só não aparece na tela porque a faixa de alertas
    // filtra por `fechada_em is null`.
    const conversaFechada = !!conversa.fechada_em;

    const { data: mensagensDesc, error: erroMensagens } = await supabaseAdmin
      .from('mensagens')
      .select('autor, texto, midia_tipo, tipo_mensagem, transcricao, enviada_em')
      .eq('conversa_id', conversaId)
      .order('enviada_em', { ascending: false })
      .limit(MAX_MENSAGENS);
    if (erroMensagens) throw new Error(erroMensagens.message);

    // Busca desc (mais recentes primeiro, para o limit pegar as últimas
    // MAX_MENSAGENS) — o prompt precisa da ordem cronológica normal.
    const mensagens = [...((mensagensDesc ?? []) as MensagemParaAnalise[])].reverse();
    // Conversa sem nenhuma mensagem não tem o que classificar. Sai em silêncio:
    // não é erro, e gravar analise_ia_erro aqui poluiria a métrica R1 do plano.
    if (mensagens.length === 0) return;

    let motivos: MotivoPerda[] = [];
    if (empresaId) {
      const { data } = await supabaseAdmin
        .from('motivos_perda')
        .select('id, nome')
        .eq('empresa_id', empresaId)
        .eq('ativo', true)
        .order('ordem');
      motivos = (data ?? []) as MotivoPerda[];
    }

    // Uma vez só: o nome do setor volta a ser usado na orientação de
    // escalonamento lá embaixo.
    const contexto = await buscarContextoConversa(conversa);

    const anthropic = await obterCliente();
    const resposta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: montarPrompt(mensagens, motivos, contexto) }],
    });

    // Na Opus 5 os classificadores de segurança podem recusar (HTTP 200 com
    // stop_reason 'refusal' e content vazio) — ler content[0] direto quebraria.
    if (resposta.stop_reason === 'refusal') throw new Error('análise recusada pelos classificadores da Anthropic');
    if (resposta.stop_reason === 'max_tokens') throw new Error('resposta truncada por max_tokens');

    const bloco = resposta.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const texto = bloco?.text?.trim();
    if (!texto) throw new Error('resposta da Anthropic sem bloco de texto');

    const analise = interpretarAnalise(texto);
    if (!analise) throw new Error('resposta da Anthropic sem JSON interpretável');

    /* INVARIANTE do coach: as três colunas se movem JUNTAS. Ou existe coach
     * (sugestões, orientações e timestamp preenchidos) ou não existe (as três
     * nulas). Meio-termo — timestamp sem lista, orientação sem sugestão — seria
     * um estado que a UI teria de adivinhar como exibir, e é exatamente o que a
     * consulta de reconciliação R7 do plano procura.
     *
     * Sem sugestão não há coach: a orientação sozinha não dá ao atendente nada
     * para clicar, que é o ponto da feature. As orientações fixas ("respire",
     * "aja com profissionalismo") vivem no front e continuam aparecendo de
     * qualquer jeito — não dependem desta linha nem da Anthropic estar de pé. */
    const temCoach = !conversaFechada && analise.risco !== 'baixo' && analise.sugestoes !== null;
    const orientacoes = temCoach
      ? [
          ...(analise.orientacoes ?? []),
          orientacaoEscalonamento(await buscarSupervisor(conversa.setor_id), contexto.setorNome),
        ]
      : null;

    const agora = new Date().toISOString();
    await gravar(conversaId, {
      sentimento: analise.sentimento,
      sentimento_atualizado_em: agora,
      coach_sugestoes: temCoach ? analise.sugestoes : null,
      coach_orientacoes: orientacoes,
      coach_atualizado_em: temCoach ? agora : null,
      // Conversa fechada no meio do debounce: zera o risco em vez de gravar o
      // classificado. Zerar (e não omitir) é o certo — se a conversa já
      // carregava risco alto de um ciclo anterior, deixá-lo lá manteria um
      // alerta vivo para um chamado que acabou.
      risco: conversaFechada ? null : analise.risco,
      risco_motivo: conversaFechada ? null : analise.riscoMotivo,
      risco_atualizado_em: agora,
      motivo_perda_sugerido_id: resolverMotivoPerdaId(analise.motivoPerdaProvavel, motivos),
      analise_ia_modelo: MODELO,
      analise_ia_erro: null,
    });
  } catch (err) {
    const mensagemErro = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`falha ao analisar conversa (conversa=${conversaId}):`, mensagemErro);
    // Mesmo tratamento de 401 do resumo: a mensagem crua do SDK não ajuda
    // quem for olhar a coluna depois; o detalhe técnico já foi pro console.
    const status = (err as { status?: number } | null)?.status;
    const mensagemExibida =
      status === 401
        ? 'Chave da Anthropic não configurada ou inválida. Peça a um administrador para configurar em Configurações → Integrações.'
        : mensagemErro;
    await gravar(conversaId, { analise_ia_erro: mensagemExibida });
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Agenda analisarConversa com debounce de 10s por conversa — absorve rajadas
 * de mensagens numa única chamada à Anthropic. Timer independente do debounce
 * do resumo de propósito: as duas análises são disparadas juntas mas falham,
 * reagendam e evoluem separadamente.
 *
 * Chamar sempre sem await (fire-and-forget) a partir de quem recebe mensagem
 * de entrada — nunca no caminho síncrono do webhook.
 */
export function agendarAnaliseDebounced(conversaId: string): void {
  const existente = timers.get(conversaId);
  if (existente) clearTimeout(existente);
  timers.set(
    conversaId,
    setTimeout(() => {
      timers.delete(conversaId);
      void analisarConversa(conversaId);
    }, JANELA_DEBOUNCE_MS),
  );
}
