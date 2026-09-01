// Personalização do disparo por IA — Fase 4.1 do PLANO_CAMPANHA_INDIARA.md.
//
// A IA NÃO ESCREVE A MENSAGEM. Ela reescreve, para cada eleitor, um
// texto-base que a candidata aprovou — mudando tratamento e ordem, citando
// o bairro, encurtando ou alongando um pouco. O conteúdo é o mesmo.
//
// A distinção não é estilística, é jurídica: promessa de campanha inventada
// por um modelo é problema de quem assina a campanha, não bug de qualidade.
// Por isso este módulo tem duas guardas, e a segunda não depende da
// primeira:
//
//   1. O PROMPT proíbe criar fato, número, data, promessa ou nome próprio
//      que não esteja no texto-base.
//   2. O VALIDADOR (validarVariacao) é determinístico e confere o
//      resultado. Prompt é pedido; validador é regra. Uma variação que
//      introduza dígito, data ou verbo de compromisso ausente do original
//      é DESCARTADA e o texto-base entra no lugar dela.
//
// Pré-geração, nunca no meio do envio: gerar durante o disparo faria a
// latência do modelo virar o intervalo entre mensagens — irregular, caro, e
// tirando do worker o controle do ritmo que a Fase 3 construiu.

import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { obterCliente } from './resumoIA.js';
import { aplicarCampos } from './ritmoDisparo.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/**
 * Sonnet 5, não Opus.
 *
 * Decisão do plano aprovado (§5, linha de custo de IA): a personalização
 * roda uma vez por eleitor — dezenas de milhares de chamadas — e a tarefa é
 * reescrita curta com regras estritas, não raciocínio aberto. O Opus fica
 * no painel analítico, onde a pergunta é aberta e há uma pessoa esperando.
 */
const MODELO = 'claude-sonnet-5';

/** Eleitores por chamada. Alto o bastante para o custo por eleitor cair
 *  (o prompt de regras é rateado), baixo o bastante para uma resposta
 *  truncada não perder o lote inteiro. */
export const TAMANHO_DO_LOTE = 20;

/** Teto por chamada. No Sonnet 5 o thinking adaptativo entra por padrão
 *  quando `thinking` é omitido, e `max_tokens` limita thinking + resposta
 *  juntos — daí a folga sobre o tamanho do texto visível. */
const MAX_TOKENS = 8000;

export interface EleitorParaPersonalizar {
  alvoId: string;
  nome: string;
  primeiroNome: string;
  bairro?: string | null;
  cidade?: string | null;
  tags?: string[] | null;
}

export interface VariacaoGerada {
  alvoId: string;
  texto: string;
  /** `false` quando a variação foi descartada e o texto-base entrou no
   *  lugar. A UI mostra esse número: se for alto, o texto-base é que está
   *  induzindo o modelo a inventar. */
  personalizada: boolean;
  motivoDescarte?: string;
}

// ---------------------------------------------------------------------
// O validador — a guarda que não depende do prompt
// ---------------------------------------------------------------------

/** Verbos e locuções de compromisso. Uma variação que introduza qualquer um
 *  deles está prometendo algo que a candidata não escreveu. */
const COMPROMISSO =
  /\b(vou|vamos|irei|iremos|prometo|prometemos|garanto|garantimos|asseguro|construir(?:ei|emos)?|far(?:ei|emos)|entregar(?:ei|emos)?|criar(?:ei|emos)?|reduzir(?:ei|emos)?|acabar(?:ei|emos)?)\b/gi;

/** Datas por extenso e numéricas. */
const DATA =
  /\b(\d{1,2}\s*\/\s*\d{1,2}(\s*\/\s*\d{2,4})?|\d{1,2}\s+de\s+(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro))\b/gi;

function normalizar(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function digitosDe(t: string): Set<string> {
  return new Set((t.match(/\d+/g) ?? []).map((d) => d.replace(/^0+(?=\d)/, '')));
}

function conjuntoDe(t: string, padrao: RegExp): Set<string> {
  return new Set((normalizar(t).match(padrao) ?? []).map((m) => m.trim()));
}

export interface ResultadoValidacao {
  ok: boolean;
  motivo?: string;
}

/**
 * A variação pode ter dito algo que o texto-base não disse?
 *
 * Compara CONJUNTOS, não posições: reordenar a frase é permitido, é a razão
 * de existir da personalização. O que não é permitido é aparecer um
 * elemento novo.
 *
 * Os campos substituídos (nome, bairro, cidade) são passados como
 * `permitidos` — eles não estão no texto-base literal e não podem ser
 * confundidos com invenção.
 */
export function validarVariacao(
  textoBase: string,
  variacao: string,
  permitidos: string[] = [],
): ResultadoValidacao {
  const v = (variacao ?? '').trim();
  if (!v) return { ok: false, motivo: 'variação vazia' };

  // Tamanho: uma variação muito maior que o original quase sempre é o
  // modelo acrescentando parágrafo próprio.
  if (v.length > textoBase.length * 1.6 + 60) {
    return { ok: false, motivo: 'variação muito mais longa que o texto-base' };
  }
  if (v.length < textoBase.length * 0.4) {
    return { ok: false, motivo: 'variação curta demais — provavelmente cortou conteúdo' };
  }

  const baseComPermitidos = `${textoBase} ${permitidos.join(' ')}`;

  // Números. O caso caro: "vamos construir 3 creches" onde o original não
  // tinha número nenhum.
  const digitosBase = digitosDe(baseComPermitidos);
  for (const d of digitosDe(v)) {
    if (!digitosBase.has(d)) return { ok: false, motivo: `número "${d}" não está no texto-base` };
  }

  // Datas.
  const datasBase = conjuntoDe(baseComPermitidos, DATA);
  for (const d of conjuntoDe(v, DATA)) {
    if (!datasBase.has(d)) return { ok: false, motivo: `data "${d}" não está no texto-base` };
  }

  // Compromissos.
  const compromissosBase = conjuntoDe(baseComPermitidos, COMPROMISSO);
  for (const c of conjuntoDe(v, COMPROMISSO)) {
    if (!compromissosBase.has(c)) {
      return { ok: false, motivo: `promessa "${c}" não está no texto-base` };
    }
  }

  // Link e contato: a variação não pode inventar canal de contato.
  if (/https?:\/\/|www\.|@[a-z0-9_]+/i.test(v) && !/https?:\/\/|www\.|@[a-z0-9_]+/i.test(baseComPermitidos)) {
    return { ok: false, motivo: 'variação introduziu um link ou contato que não está no texto-base' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------
// Geração
// ---------------------------------------------------------------------

const INSTRUCOES = `Você reescreve mensagens de campanha eleitoral para soarem pessoais.

O QUE VOCÊ FAZ
Recebe UM texto-base, já aprovado pela candidata, e dados de algumas
pessoas. Devolve, para cada pessoa, uma versão do MESMO texto — com o
tratamento adaptado, a ordem das frases variada, e o bairro citado quando
fizer sentido.

O QUE VOCÊ NUNCA FAZ
- Não invente fato, número, data, valor, estatística ou promessa. Se o
  texto-base não diz "vou construir uma creche", a sua versão também não diz.
- Não acrescente proposta, opinião política ou pedido de voto que não esteja
  no texto-base.
- Não invente link, telefone, endereço, horário ou nome de pessoa.
- Não mude o que a mensagem pede. Se o texto-base pede uma resposta, a sua
  versão pede a mesma coisa.
- Não remova a instrução de descadastro, se houver.
- Não use emoji que não esteja no texto-base.

REGISTRO
Português do Brasil, informal e direto, como uma mensagem de WhatsApp de
alguém que conhece a pessoa de vista. Sem formalidade de ofício, sem
publicidade. Comprimento parecido com o do texto-base.

SAÍDA
Só um objeto JSON, sem cerca de código e sem comentário:
{"variacoes":[{"id":"<id recebido>","texto":"<a mensagem>"}]}
Um item por pessoa recebida, na mesma ordem.`;

interface RespostaModelo {
  variacoes?: Array<{ id?: string; texto?: string }>;
}

/**
 * Gera as variações de UM lote.
 *
 * Nunca lança por causa do modelo: qualquer falha (rede, JSON quebrado,
 * resposta truncada) vira "lote inteiro cai para o texto-base". Uma
 * campanha que não sai porque o modelo está fora do ar é pior que uma
 * campanha com mensagem menos personalizada — e o texto-base é, ele
 * mesmo, uma mensagem aprovada.
 */
export async function gerarLote(
  textoBase: string,
  eleitores: EleitorParaPersonalizar[],
): Promise<VariacaoGerada[]> {
  const fallback = (motivo: string): VariacaoGerada[] =>
    eleitores.map((e) => ({
      alvoId: e.alvoId,
      texto: textoComCampos(textoBase, e),
      personalizada: false,
      motivoDescarte: motivo,
    }));

  if (!eleitores.length) return [];

  let anthropic: Anthropic;
  try {
    anthropic = await obterCliente();
  } catch (err) {
    return fallback(`IA indisponível: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pessoas = eleitores.map((e) => ({
    id: e.alvoId,
    primeiro_nome: e.primeiroNome,
    bairro: e.bairro ?? undefined,
    cidade: e.cidade ?? undefined,
    pautas: e.tags?.length ? e.tags : undefined,
  }));

  let bruto = '';
  try {
    const resposta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: MAX_TOKENS,
      system: INSTRUCOES,
      messages: [
        {
          role: 'user',
          content:
            `TEXTO-BASE (aprovado, não pode ganhar conteúdo novo):\n${textoBase}\n\n` +
            `PESSOAS:\n${JSON.stringify(pessoas, null, 2)}`,
        },
      ],
    });

    if (resposta.stop_reason === 'refusal') {
      return fallback('o modelo recusou a solicitação');
    }
    if (resposta.stop_reason === 'max_tokens') {
      return fallback('resposta truncada por max_tokens');
    }
    bruto = resposta.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    return fallback(`falha na chamada: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: RespostaModelo;
  try {
    // Tolera cerca de código, apesar de a instrução pedir para não usar.
    const limpo = bruto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(limpo) as RespostaModelo;
  } catch {
    return fallback('resposta não era JSON válido');
  }

  const porId = new Map<string, string>();
  for (const v of parsed.variacoes ?? []) {
    if (v?.id && typeof v.texto === 'string') porId.set(v.id, v.texto);
  }

  return eleitores.map((e) => {
    const base = textoComCampos(textoBase, e);
    const gerada = porId.get(e.alvoId);
    if (!gerada) {
      return { alvoId: e.alvoId, texto: base, personalizada: false, motivoDescarte: 'sem variação para este id' };
    }

    // Os campos substituídos entram como permitidos: eles não estão no
    // texto-base literal e não podem contar como invenção.
    const permitidos = [e.nome, e.primeiroNome, e.bairro ?? '', e.cidade ?? '', ...(e.tags ?? [])];
    const v = validarVariacao(textoBase, gerada, permitidos);
    if (!v.ok) {
      logger.warn({ alvoId: e.alvoId, motivo: v.motivo }, 'variação descartada pelo validador');
      return { alvoId: e.alvoId, texto: base, personalizada: false, motivoDescarte: v.motivo };
    }
    return { alvoId: e.alvoId, texto: gerada.trim(), personalizada: true };
  });
}

function textoComCampos(textoBase: string, e: EleitorParaPersonalizar): string {
  return aplicarCampos(textoBase, {
    nome: e.nome,
    primeiro_nome: e.primeiroNome,
    bairro: e.bairro,
    cidade: e.cidade,
  });
}

/** Divide em lotes de `TAMANHO_DO_LOTE`. Exportada para o teste e para a
 *  rota poder relatar progresso por lote. */
export function emLotes<T>(itens: T[], tamanho = TAMANHO_DO_LOTE): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}
