// Importador de eleitores a partir de XLSX/CSV (Fase 2 do
// PLANO_CAMPANHA_INDIARA.md).
//
// Este módulo é DETERMINÍSTICO e não fala com o banco: recebe o buffer do
// arquivo e o mapeamento de colunas, devolve o que é aceito e o que é
// rejeitado, com o motivo de cada rejeição. A parte que fala com o banco
// (dedupe contra a base, opt-out, insert) vive em routes/importacao.ts.
//
// A separação não é purismo — é o que permite testar as regras de
// telefone e de mapeamento sem Postgres, que é onde os erros caros moram.
// Uma linha aceita por engano vira mensagem para a pessoa errada.

import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { normalizarTelefone } from './mensagens.js';

/** Campos que uma planilha pode alimentar. `telefone` e `nome` são os
 *  únicos obrigatórios: o resto melhora a personalização, mas a ausência
 *  não impede o envio. */
export const CAMPOS_IMPORTAVEIS = [
  'nome',
  'telefone',
  'bairro',
  'cidade',
  'zona_eleitoral',
  'tags',
] as const;

export type CampoImportavel = (typeof CAMPOS_IMPORTAVEIS)[number];

/** De coluna do arquivo (o cabeçalho literal) para campo do cadastro. */
export type Mapeamento = Partial<Record<string, CampoImportavel>>;

export interface EleitorLido {
  /** Número da linha NO ARQUIVO, contando o cabeçalho como 1. É o que a
   *  pessoa vê ao abrir a planilha para corrigir — índice de array aqui
   *  seria inútil para ela. */
  linha: number;
  nome: string;
  telefone: string;
  bairro?: string;
  cidade?: string;
  zonaEleitoral?: string;
  tags: string[];
}

export interface LinhaRejeitada {
  linha: number;
  motivo: string;
  /** O valor problemático, para a pessoa achar a linha na planilha. Nunca
   *  a linha inteira: o relatório vai para o banco e não precisa carregar
   *  o cadastro completo de quem foi rejeitado. */
  valor?: string;
}

export interface ResultadoLeitura {
  colunas: string[];
  /** Linhas cruas, já casadas com o cabeçalho. */
  linhas: Record<string, string>[];
}

export interface ResultadoAnalise {
  aceitos: EleitorLido[];
  rejeitados: LinhaRejeitada[];
  /** Duplicados DENTRO do arquivo. Contados à parte de `rejeitados`
   *  porque não são erro de quem montou a planilha — lista de campanha
   *  com o mesmo número duas vezes é o caso comum, não a exceção. */
  duplicadosNoArquivo: LinhaRejeitada[];
}

/** DDDs que existem no Brasil. A lista é fechada de propósito: um DDD
 *  inventado (11 virando 1, 47 virando 470) passa em qualquer validação
 *  que só conte dígitos, e o número resultante é de OUTRA PESSOA. */
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

const TETO_LINHAS = 200_000;

/**
 * Lê XLSX ou CSV e devolve cabeçalho + linhas casadas.
 *
 * O formato é decidido pela extensão, não por adivinhação de conteúdo:
 * quem sobe o arquivo sabe o que subiu, e um XLSX lido como CSV produz
 * lixo silencioso em vez de erro.
 */
export async function lerPlanilha(buffer: Buffer, nomeArquivo: string): Promise<ResultadoLeitura> {
  const wb = new ExcelJS.Workbook();
  const ehCsv = /\.csv$/i.test(nomeArquivo);

  if (ehCsv) {
    await wb.csv.read(Readable.from(buffer));
  } else {
    // exceljs declara o PRÓPRIO `Buffer` na primeira linha do index.d.ts
    // (`declare interface Buffer extends ArrayBuffer {}`), que não é o
    // Buffer do Node e não é compatível com ele. O valor em runtime é o
    // Buffer certo — quem está errado é o tipo da biblioteca. O cast fica
    // aqui, na fronteira, em vez de contaminar a assinatura desta função.
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  }

  const planilha = wb.worksheets[0];
  if (!planilha) {
    throw new Error('O arquivo não tem nenhuma planilha legível.');
  }

  const linhaCabecalho = planilha.getRow(1);
  const colunas: string[] = [];
  linhaCabecalho.eachCell({ includeEmpty: true }, (cell, col) => {
    colunas[col - 1] = textoDaCelula(cell.value).trim();
  });

  // Coluna sem cabeçalho não é descartada: vira "Coluna 3". Descartar
  // silenciosamente esconde do admin que existe dado ali.
  for (let i = 0; i < colunas.length; i += 1) {
    if (!colunas[i]) colunas[i] = `Coluna ${i + 1}`;
  }

  const linhas: Record<string, string>[] = [];
  planilha.eachRow({ includeEmpty: false }, (row, numero) => {
    if (numero === 1) return;
    if (linhas.length >= TETO_LINHAS) return;

    const registro: Record<string, string> = { __linha: String(numero) };
    let temAlgo = false;
    for (let i = 0; i < colunas.length; i += 1) {
      const valor = textoDaCelula(row.getCell(i + 1).value).trim();
      registro[colunas[i]] = valor;
      if (valor) temAlgo = true;
    }
    // Linha totalmente vazia no meio da planilha é ruído de edição, não
    // dado. Não conta como lida nem como rejeitada.
    if (temAlgo) linhas.push(registro);
  });

  return { colunas, linhas };
}

/** ExcelJS devolve tipos ricos (data, fórmula, hyperlink, rich text). Tudo
 *  vira string aqui, porque o cadastro é texto — e porque telefone lido
 *  como número perde o zero à esquerda, que é o defeito clássico de
 *  planilha de campanha. */
function textoDaCelula(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  if (typeof valor === 'object') {
    const o = valor as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.result === 'string' || typeof o.result === 'number') return String(o.result);
    if (Array.isArray(o.richText)) {
      return o.richText.map((p) => String((p as { text?: string }).text ?? '')).join('');
    }
    if (typeof o.hyperlink === 'string') return o.hyperlink;
  }
  return String(valor);
}

/** Palpite de mapeamento, para o admin não casar 8 colunas na mão toda
 *  vez. É PALPITE: a UI mostra o resultado e exige confirmação, porque
 *  errar "telefone do titular" por "telefone do contato de emergência"
 *  manda a campanha inteira para o lugar errado. */
export function sugerirMapeamento(colunas: string[]): Mapeamento {
  const pistas: Array<[CampoImportavel, RegExp]> = [
    ['telefone', /^(telefone|celular|whatsapp|whats|fone|tel|contato|numero|n[uú]mero)/i],
    ['nome', /^(nome|eleitor|pessoa|contato_nome|nome_completo)/i],
    ['bairro', /^(bairro|regi[aã]o|localidade|comunidade)/i],
    ['cidade', /^(cidade|munic[ií]pio|munic[ií]pio_?res)/i],
    ['zona_eleitoral', /^(zona|se[cç][aã]o|zona_?eleitoral|t[ií]tulo)/i],
    ['tags', /^(tags?|pauta|interesse|assunto|tema|grupo)/i],
  ];

  const mapa: Mapeamento = {};
  const jaUsados = new Set<CampoImportavel>();

  for (const [campo, padrao] of pistas) {
    const achada = colunas.find((c) => padrao.test(c.trim()) && !mapa[c]);
    if (achada && !jaUsados.has(campo)) {
      mapa[achada] = campo;
      jaUsados.add(campo);
    }
  }
  return mapa;
}

export interface ProblemaMapeamento {
  campo: CampoImportavel;
  mensagem: string;
}

/** O mapeamento precisa cobrir os obrigatórios e não pode mandar duas
 *  colunas para o mesmo campo — a segunda sobrescreveria a primeira sem
 *  aviso. */
export function conferirMapeamento(mapa: Mapeamento): ProblemaMapeamento[] {
  const problemas: ProblemaMapeamento[] = [];
  const destinos = Object.values(mapa).filter(Boolean) as CampoImportavel[];

  for (const obrigatorio of ['nome', 'telefone'] as const) {
    if (!destinos.includes(obrigatorio)) {
      problemas.push({
        campo: obrigatorio,
        mensagem: `Nenhuma coluna do arquivo foi apontada para "${obrigatorio}".`,
      });
    }
  }

  const vistos = new Set<CampoImportavel>();
  for (const d of destinos) {
    if (vistos.has(d)) {
      problemas.push({
        campo: d,
        mensagem: `Duas colunas diferentes apontam para "${d}". Escolha uma.`,
      });
    }
    vistos.add(d);
  }
  return problemas;
}

export interface TelefoneValidado {
  ok: boolean;
  normalizado: string;
  motivo?: string;
}

/**
 * Valida o telefone JÁ normalizado.
 *
 * Aceita só o que é entregável no WhatsApp brasileiro:
 *   55 + DDD(2) + 9 dígitos começando em 9  (celular)
 *   55 + DDD(2) + 8 dígitos começando em 2-5 (fixo)
 *
 * Fixo é aceito de propósito, mesmo raramente tendo WhatsApp: rejeitar
 * aqui esconderia do admin que a planilha veio cheia de fixo. O envio
 * falha depois, com o motivo registrado por linha — e aí a informação é
 * útil, porque é sobre o número real e não sobre um palpite nosso.
 */
export function validarTelefone(bruto: string): TelefoneValidado {
  const normalizado = normalizarTelefone(bruto);

  if (!normalizado) {
    return { ok: false, normalizado, motivo: 'Telefone vazio.' };
  }
  if (!normalizado.startsWith('55')) {
    return {
      ok: false,
      normalizado,
      motivo: `Telefone com ${normalizado.length} dígitos, fora do padrão brasileiro (esperado DDD + número).`,
    };
  }

  const semDdi = normalizado.slice(2);
  if (semDdi.length !== 10 && semDdi.length !== 11) {
    return {
      ok: false,
      normalizado,
      motivo: `Telefone com ${normalizado.length} dígitos — esperado 12 (fixo) ou 13 (celular) com o 55.`,
    };
  }

  const ddd = Number(semDdi.slice(0, 2));
  if (!DDDS_VALIDOS.has(ddd)) {
    return { ok: false, normalizado, motivo: `DDD ${semDdi.slice(0, 2)} não existe.` };
  }

  const assinante = semDdi.slice(2);
  if (assinante.length === 9 && !assinante.startsWith('9')) {
    return {
      ok: false,
      normalizado,
      motivo: 'Celular de 9 dígitos precisa começar com 9.',
    };
  }
  if (assinante.length === 8 && !/^[2-5]/.test(assinante)) {
    return {
      ok: false,
      normalizado,
      motivo: 'Fixo de 8 dígitos precisa começar entre 2 e 5.',
    };
  }

  return { ok: true, normalizado };
}

/**
 * Aplica o mapeamento, normaliza, valida e deduplica DENTRO do arquivo.
 *
 * Não fala com o banco: dedupe contra a base e checagem de opt-out são do
 * chamador, que tem a conexão.
 */
export function analisar(linhas: Record<string, string>[], mapa: Mapeamento): ResultadoAnalise {
  const aceitos: EleitorLido[] = [];
  const rejeitados: LinhaRejeitada[] = [];
  const duplicadosNoArquivo: LinhaRejeitada[] = [];
  const vistos = new Map<string, number>();

  const colunaDe = (campo: CampoImportavel): string | undefined =>
    Object.keys(mapa).find((c) => mapa[c] === campo);

  const colNome = colunaDe('nome');
  const colTelefone = colunaDe('telefone');
  const colBairro = colunaDe('bairro');
  const colCidade = colunaDe('cidade');
  const colZona = colunaDe('zona_eleitoral');
  const colTags = colunaDe('tags');

  for (const linha of linhas) {
    const numero = Number(linha.__linha) || 0;
    const nome = (colNome ? linha[colNome] : '')?.trim() ?? '';
    const telefoneBruto = (colTelefone ? linha[colTelefone] : '')?.trim() ?? '';

    if (!nome) {
      rejeitados.push({ linha: numero, motivo: 'Sem nome.', valor: telefoneBruto || undefined });
      continue;
    }

    const tel = validarTelefone(telefoneBruto);
    if (!tel.ok) {
      rejeitados.push({ linha: numero, motivo: tel.motivo!, valor: telefoneBruto || undefined });
      continue;
    }

    const primeira = vistos.get(tel.normalizado);
    if (primeira !== undefined) {
      duplicadosNoArquivo.push({
        linha: numero,
        motivo: `Mesmo telefone da linha ${primeira}.`,
        valor: telefoneBruto,
      });
      continue;
    }
    vistos.set(tel.normalizado, numero);

    aceitos.push({
      linha: numero,
      nome,
      telefone: tel.normalizado,
      bairro: valorOuIndefinido(colBairro ? linha[colBairro] : undefined),
      cidade: valorOuIndefinido(colCidade ? linha[colCidade] : undefined),
      zonaEleitoral: valorOuIndefinido(colZona ? linha[colZona] : undefined),
      tags: separarTags(colTags ? linha[colTags] : undefined),
    });
  }

  return { aceitos, rejeitados, duplicadosNoArquivo };
}

function valorOuIndefinido(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Tags numa célula só, separadas por vírgula, ponto e vírgula ou barra —
 *  os três jeitos que aparecem em planilha montada à mão. */
export function separarTags(bruto: string | undefined): string[] {
  if (!bruto) return [];
  return Array.from(
    new Set(
      bruto
        .split(/[,;/|]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}
