// Fase 7 (comentário histórico em server.ts: "ai/anthropic.ts e a rota
// /ia/analisar") — gera o resumo de IA de um chamado (hub.conversas) para o
// dialog do Kanban, ver plano "Resumo de IA no Kanban de Chamados". Disparado
// automaticamente por services/mensagens.ts a cada mensagem de entrada
// (agendarResumoDebounced) e manualmente por routes/resumo.ts.
//
// Desde PLANO_TITULO_IA_KANBAN.md (2026-08-08) a MESMA chamada também produz
// o título curto do chamado (conversas.titulo_ia), exibido em destaque no card
// do Kanban. Uma chamada só, gravação atômica no mesmo update.
//
// Contrato de fire-and-forget: gerarResumoConversa NUNCA relança. Quem
// aciona a geração automática está no meio do caminho crítico do
// webhook/adapter que grava a mensagem — uma falha da Anthropic não pode
// derrubar nem atrasar isso. Falha vira resumo_ia_status='erro', não uma
// exceção não tratada.
import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin } from '../db/client.server.js';
import { lerSecret } from '../gcp/secretManager.js';

const MODELO = 'claude-sonnet-5';
const JANELA_DEBOUNCE_MS = 10_000;
const MAX_MENSAGENS = 50;

// Auditoria 2026-08-09, item 5. Era 350 — e 350 tornava o TRUNCAMENTO o caso
// comum, não o excepcional.
//
// No Sonnet 5 o thinking adaptativo é ligado por padrão quando o parâmetro
// `thinking` é omitido (como aqui), e `max_tokens` limita thinking + resposta
// JUNTOS. Ou seja: os mesmos 350 tokens precisavam caber raciocínio + linha de
// TÍTULO + 4 frases de resumo. É exatamente o tropeço que analiseIA.ts já
// documenta e corrigiu subindo o teto para 8000.
//
// Teto alto não custa: cobra-se pelo que é gerado, não pelo limite. O que custa
// é o resumo cortado no meio sendo gravado com status 'pronto' — ver as guardas
// de stop_reason em gerarResumoConversa.
const MAX_TOKENS = 4000;

let _client: Anthropic | undefined;

// Mesmo padrão de services/twilioCredenciais.ts: GCP_PROJECT_ID setado =
// produção, lê só do Secret Manager (hub-anthropic-api-key); ausente = dev
// local/teste, lê ANTHROPIC_API_KEY do .env, sem exigir ADC.
async function lerChaveBruta(): Promise<string | null> {
  const chave = process.env.GCP_PROJECT_ID ? await lerSecret('hub-anthropic-api-key') : (process.env.ANTHROPIC_API_KEY ?? null);
  const limpa = chave?.trim();
  return limpa || null;
}

/** Exportado para services/analiseIA.ts. Os dois serviços compartilham
 *  DELIBERADAMENTE o mesmo `_client`: é o que faz
 *  invalidarCacheClienteAnthropic() (chamada por POST /configuracoes/anthropic)
 *  valer para os dois de uma vez. Dois clientes independentes deixariam a
 *  análise presa na chave antiga depois de uma troca. */
export async function obterCliente(): Promise<Anthropic> {
  if (_client) return _client;
  const chave = await lerChaveBruta();
  if (!chave) {
    throw new Error(
      process.env.GCP_PROJECT_ID
        ? "Secret 'hub-anthropic-api-key' não configurado no Secret Manager."
        : 'ANTHROPIC_API_KEY não configurada (dev local, GCP_PROJECT_ID ausente).',
    );
  }
  _client = new Anthropic({ apiKey: chave, timeout: 20_000 });
  return _client;
}

/** Chamado depois de um salvamento bem-sucedido em POST /configuracoes/anthropic
 *  — faz a próxima geração de resumo pegar a chave nova na hora, sem esperar
 *  redeploy. Mesmo padrão de invalidarCacheCredenciaisTwilio(). */
export function invalidarCacheClienteAnthropic(): void {
  _client = undefined;
}

const PLACEHOLDER_CONHECIDO = /SUA_CHAVE/i;

/** GET /configuracoes/anthropic usa isto para saber o que mostrar — nunca
 *  devolve o valor da chave, só se está configurada (presente e sem cara de
 *  placeholder) e uma versão mascarada para conferência visual. */
export async function statusChaveAnthropic(): Promise<{ configurado: boolean; chaveMascarada?: string }> {
  const chave = await lerChaveBruta();
  const parecendoValida = !!chave && chave.length >= 40 && !PLACEHOLDER_CONHECIDO.test(chave);
  if (!parecendoValida || !chave) return { configurado: false };
  return { configurado: true, chaveMascarada: `${chave.slice(0, 10)}…${chave.slice(-4)}` };
}

interface MensagemParaResumo {
  autor: string;
  texto: string | null;
  midia_tipo: string | null;
  tipo_mensagem?: string | null;
  transcricao?: string | null;
  enviada_em: string;
}

/**
 * Uma linha da conversa como a IA a enxerga.
 *
 * Exportado para teste. A ordem de preferência importa: TRANSCRIÇÃO antes de
 * "[mídia: audio]" é o que tira o áudio do estado de buraco cego — antes desta
 * feature, um cliente que explicava o problema inteiro por nota de voz gerava
 * um resumo dizendo que ele "enviou um áudio", e o risco era classificado
 * sobre nada.
 */
export function linhaParaPrompt(m: MensagemParaResumo): string {
  const quem = m.autor === 'cliente' ? 'Cliente' : 'Atendente';
  const legenda = m.texto?.trim();
  const transcricao = m.transcricao?.trim();

  if (transcricao) {
    return `${quem} (áudio transcrito): ${transcricao}`;
  }
  if (legenda) {
    // Legenda de mídia é texto de verdade; dizer QUE tipo de mídia ela
    // acompanha muda o sentido ("segue a nota" com um PDF anexo ≠ sozinho).
    const rotulo = m.tipo_mensagem && m.tipo_mensagem !== 'texto' ? ` [${m.tipo_mensagem}]` : '';
    return `${quem}${rotulo}: ${legenda}`;
  }
  if (m.tipo_mensagem && m.tipo_mensagem !== 'texto') {
    return `${quem}: [enviou ${m.tipo_mensagem}]`;
  }
  return `${quem}: ${m.midia_tipo ? `[mídia: ${m.midia_tipo}]` : '[mensagem vazia]'}`;
}

function montarPrompt(cliente: { nome: string; cidade: string | null }, mensagens: MensagemParaResumo[]): string {
  const linhas = mensagens.map(linhaParaPrompt);
  return (
    `Resuma esta conversa de atendimento via WhatsApp entre a empresa e a cliente ${cliente.nome}` +
    `${cliente.cidade ? ` (${cliente.cidade})` : ''}, em português, em no máximo 4 frases curtas.\n` +
    'Cubra o que der para cobrir com o que está nas mensagens: motivo do contato, o que já foi feito, e o que está pendente. ' +
    'Não invente informação que não está nas mensagens — mas sempre produza um resumo com o que houver, mesmo que seja só ' +
    'uma mensagem ou pouco conteúdo (ex.: "Cliente enviou um link, sem mais interação até o momento"). ' +
    'Nunca recuse nem peça mais mensagens: resumir o pouco que existe é sempre a resposta certa.\n\n' +
    // Título do card do Kanban, pedido na MESMA chamada do resumo (custo e
    // latência adicionais ~zero, e os dois sempre coerentes entre si porque
    // são gravados no mesmo update). Se o modelo ignorar o formato,
    // extrairTituloEResumo devolve titulo=null e o resumo segue normal.
    'Comece a resposta com uma linha de título, exatamente neste formato:\n' +
    'TÍTULO: assunto da conversa em 3 a 6 palavras, no máximo 60 caracteres, sem o nome do cliente e sem ponto final\n' +
    '\n' +
    'Depois de uma linha em branco, escreva o resumo. O título é obrigatório mesmo com pouca conversa ' +
    '(ex.: "TÍTULO: Contato sem assunto definido"). Exemplo de resposta completa:\n' +
    'TÍTULO: Atraso na entrega do pedido 123\n' +
    '\n' +
    'Cliente relatou que o pedido 123 não chegou. Atendente ficou de verificar com a transportadora.\n\n' +
    'Conversa:\n' +
    linhas.join('\n')
  );
}

/** Teto do título gravado. O constraint conversas_titulo_ia_tamanho no banco
 *  aceita até 120 — a folga existe para que o truncamento aconteça aqui, de
 *  forma silenciosa, e o constraint nunca chegue a disparar (um 23514 faria o
 *  update inteiro falhar, levando o resumo junto). */
const TITULO_MAX = 80;

// Tolerante ao que o modelo costuma variar: "**TÍTULO:**", "## Titulo:",
// sem acento, sem espaço depois dos dois-pontos.
const LINHA_TITULO = /^[#*_\s]*t[íi]tulo[*_\s]*:\s*(.+)$/i;

function limparTitulo(bruto: string): string {
  const limpo = bruto
    .replace(/[*_`"']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
  return limpo.slice(0, TITULO_MAX).trim();
}

/**
 * Separa a linha "TÍTULO: ..." do corpo do resumo na resposta da Anthropic.
 *
 * Parse deliberadamente defensivo: qualquer desvio de formato (sem a linha de
 * título, título vazio, ou resposta que só tem título e nenhum resumo) devolve
 * `titulo: null` e o texto integral como resumo — ou seja, exatamente o
 * comportamento que existia antes desta feature. O resumo é o produto
 * principal e nunca pode ficar vazio nem depender do título ter dado certo.
 */
export function extrairTituloEResumo(texto: string): { titulo: string | null; resumo: string } {
  const linhas = texto.split('\n');
  const indicePrimeira = linhas.findIndex((l) => l.trim() !== '');
  if (indicePrimeira === -1) return { titulo: null, resumo: texto };

  const casamento = linhas[indicePrimeira].match(LINHA_TITULO);
  if (!casamento) return { titulo: null, resumo: texto };

  const titulo = limparTitulo(casamento[1]);
  const resumo = linhas.slice(indicePrimeira + 1).join('\n').trim();
  if (!titulo || !resumo) return { titulo: null, resumo: texto };

  return { titulo, resumo };
}

async function gravarResultado(conversaId: string, campos: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from('conversas').update(campos).eq('id', conversaId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao gravar resumo_ia em hub.conversas (${conversaId}):`, error.message);
  }
}

/**
 * Gera (ou regenera) o resumo de IA de uma conversa a partir das últimas
 * MAX_MENSAGENS. Sempre resolve — erro de qualquer etapa (Anthropic, banco)
 * vira resumo_ia_status='erro' + resumo_ia_erro, nunca uma rejeição.
 */
export async function gerarResumoConversa(conversaId: string): Promise<void> {
  await gravarResultado(conversaId, { resumo_ia_status: 'processando' });
  try {
    const { data: conversa, error: erroConversa } = await supabaseAdmin
      .from('conversas')
      .select('cliente_id')
      .eq('id', conversaId)
      .single<{ cliente_id: string }>();
    if (erroConversa || !conversa) throw new Error(erroConversa?.message ?? 'conversa não encontrada');

    const { data: cliente, error: erroCliente } = await supabaseAdmin
      .from('clientes')
      .select('nome, cidade')
      .eq('id', conversa.cliente_id)
      .single<{ nome: string; cidade: string | null }>();
    if (erroCliente || !cliente) throw new Error(erroCliente?.message ?? 'cliente não encontrado');

    const { data: mensagensDesc, error: erroMensagens } = await supabaseAdmin
      .from('mensagens')
      // Colunas simples, sem embed — regra dos selects de serviço nesta base.
      .select('autor, texto, midia_tipo, tipo_mensagem, transcricao, enviada_em')
      .eq('conversa_id', conversaId)
      .order('enviada_em', { ascending: false })
      .limit(MAX_MENSAGENS);
    if (erroMensagens) throw new Error(erroMensagens.message);

    // Busca desc (mais recentes primeiro, para o limit pegar as últimas
    // MAX_MENSAGENS) — o prompt precisa da ordem cronológica normal.
    const mensagens = [...((mensagensDesc ?? []) as MensagemParaResumo[])].reverse();

    const anthropic = await obterCliente();
    const resposta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: montarPrompt(cliente, mensagens) }],
    });

    // Mesmas duas guardas de services/analiseIA.ts, e pela mesma razão: sem
    // elas, uma recusa dos classificadores (content vazio) ou um resumo cortado
    // no meio eram gravados como `resumo_ia_status: 'pronto'` — o card do Kanban
    // exibia meia frase como se fosse o resumo completo do chamado.
    if (resposta.stop_reason === 'refusal') {
      throw new Error('resumo recusado pelos classificadores da Anthropic');
    }
    if (resposta.stop_reason === 'max_tokens') {
      throw new Error('resposta truncada por max_tokens');
    }

    const bloco = resposta.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    const texto = bloco?.text?.trim();
    if (!texto) throw new Error('resposta da Anthropic sem bloco de texto');

    const { titulo, resumo } = extrairTituloEResumo(texto);
    const agora = new Date().toISOString();
    const campos: Record<string, unknown> = {
      resumo_ia: resumo,
      resumo_ia_status: 'pronto',
      resumo_ia_gerado_em: agora,
      resumo_ia_modelo: MODELO,
      resumo_ia_mensagens_count: mensagens.length,
      resumo_ia_erro: null,
    };
    // Só grava título quando o parse deu certo — parse falho não pode
    // sobrescrever com null um título bom gerado num ciclo anterior. O card
    // do Kanban cai no nome do cliente enquanto não houver título.
    if (titulo) {
      campos.titulo_ia = titulo;
      campos.titulo_ia_gerado_em = agora;
    }
    await gravarResultado(conversaId, campos);
  } catch (err) {
    const mensagemErro = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`falha ao gerar resumo_ia (conversa=${conversaId}):`, mensagemErro);
    // 401 da Anthropic (chave ausente/inválida/placeholder) não deve vazar o
    // JSON cru do SDK pro card do Kanban — aponta direto pra onde resolver.
    // O detalhe técnico completo já foi pro console.error acima.
    const status = (err as { status?: number } | null)?.status;
    const mensagemExibida =
      status === 401
        ? 'Chave da Anthropic não configurada ou inválida. Peça a um administrador para configurar em Configurações → Integrações.'
        : mensagemErro;
    await gravarResultado(conversaId, { resumo_ia_status: 'erro', resumo_ia_erro: mensagemExibida });
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Agenda gerarResumoConversa com debounce de 10s por conversa — absorve
 * rajadas de mensagens (várias entrando em segundos) numa única chamada à
 * Anthropic. Chamar sempre sem await (fire-and-forget) a partir de quem
 * recebe mensagem de entrada — nunca no caminho síncrono do webhook.
 */
export function agendarResumoDebounced(conversaId: string): void {
  const existente = timers.get(conversaId);
  if (existente) clearTimeout(existente);
  timers.set(
    conversaId,
    setTimeout(() => {
      timers.delete(conversaId);
      void gerarResumoConversa(conversaId);
    }, JANELA_DEBOUNCE_MS),
  );
}
