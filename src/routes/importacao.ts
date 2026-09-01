// Importação de eleitores por XLSX/CSV — Fase 2 do PLANO_CAMPANHA_INDIARA.md.
//
// Duas rotas de trabalho, e a divisão entre elas é deliberada:
//
//   POST /importacoes/analisar  — lê o arquivo e devolve as colunas e um
//     palpite de mapeamento. NÃO grava nada. É o passo em que o admin casa
//     "Celular" com `telefone`, porque o arquivo do cliente nunca vem com
//     o cabeçalho que a gente quer, e adivinhar em silêncio é como uma
//     campanha manda mensagem para a coluna errada.
//
//   POST /importacoes  — recebe o arquivo JUNTO com o mapeamento e o que
//     mais precisa, e roda a validação inteira. Com `confirmar=false`
//     grava só o relatório (prévia); com `confirmar=true` grava os
//     eleitores.
//
// O arquivo sobe duas vezes, de propósito. A alternativa seria guardar as
// linhas entre as chamadas — em memória (morre no deploy, e todo deploy
// do Cloud Run é um restart) ou no banco (200 mil linhas de jsonb para
// depois jogar fora). O arquivo já está no navegador de quem clicou;
// subir de novo custa menos que qualquer das duas.

import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { buscarAtendenteAutenticado, empresasDoAtendente } from '../auth/escopoConversa.js';
import {
  analisar,
  conferirMapeamento,
  lerPlanilha,
  sugerirMapeamento,
  type EleitorLido,
  type LinhaRejeitada,
  type Mapeamento,
} from '../services/importador.js';

export const importacaoRouter = Router();
importacaoRouter.use(requireSupabaseAuth());

/** Teto de upload da planilha. Maior que o da mídia (16 MB) porque um
 *  XLSX de 100 mil eleitores passa disso com facilidade, e menor que o
 *  limite do corpo do Express só para o erro ser explícito aqui. */
const TAMANHO_MAXIMO_MB = Number(process.env.IMPORTACAO_TAMANHO_MAX_MB ?? 32);

/** Quantas linhas rejeitadas cabem no relatório gravado. O relatório
 *  existe para a pessoa corrigir a planilha; depois de algumas centenas
 *  de linhas o problema é a planilha inteira, não a linha. */
const TETO_RELATORIO = 500;

/** Tamanho dos lotes de ida ao banco. Um `in (...)` com 50 mil telefones
 *  estoura o limite de URL do PostgREST muito antes de estourar o
 *  Postgres. */
const LOTE_CONSULTA = 1_000;
const LOTE_INSERT = 500;

const BASES_LEGAIS = [
  'consentimento',
  'contato_iniciado_pelo_titular',
  'legitimo_interesse',
  'nao_declarada',
] as const;

type BaseLegal = (typeof BASES_LEGAIS)[number];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAXIMO_MB * 1024 * 1024, files: 1 },
});

/** Multer reporta erro por `next(err)`, não lançando — sem este wrapper um
 *  arquivo grande vira 500 com HTML em vez de 413 com explicação. Mesmo
 *  padrão de routes/mensagens.ts. */
const receberArquivo: RequestHandler = (req, res, next) => {
  upload.single('arquivo')(req, res, (err: unknown) => {
    if (!err) return next();
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `Arquivo acima do limite de ${TAMANHO_MAXIMO_MB} MB.` });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : 'Falha ao receber o arquivo.' });
  });
};

interface AdminEmpresa {
  atendenteId: string;
  empresaId: string;
}

/**
 * Importação é operação de admin, e a escrita usa service_role (que
 * ignora RLS) — então a checagem tem que ser reimplementada aqui, como em
 * configuracoes.ts e atendentes.ts.
 *
 * A empresa vem do corpo, não do palpite: um admin pode responder por
 * mais de uma, e importar 40 mil eleitores na empresa errada não tem
 * desfazer barato.
 */
async function exigirAdminDaEmpresa(
  userId: string,
  empresaId: unknown,
): Promise<AdminEmpresa | { erro: number; mensagem: string }> {
  if (typeof empresaId !== 'string' || !empresaId) {
    return { erro: 400, mensagem: 'empresaId é obrigatório.' };
  }
  const atendente = await buscarAtendenteAutenticado(userId);
  if (!atendente) {
    return { erro: 403, mensagem: 'Usuário autenticado não corresponde a um atendente ativo.' };
  }
  if (atendente.perfil !== 'admin') {
    return { erro: 403, mensagem: 'Somente administradores podem importar eleitores.' };
  }
  const empresas = await empresasDoAtendente(atendente.id);
  if (!empresas.has(empresaId)) {
    return { erro: 403, mensagem: 'Empresa fora do escopo deste administrador.' };
  }
  return { atendenteId: atendente.id, empresaId };
}

function lerMapeamento(bruto: unknown): Mapeamento | { erro: string } {
  if (typeof bruto !== 'string' || !bruto.trim()) return { erro: 'mapeamento é obrigatório.' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bruto);
  } catch {
    return { erro: 'mapeamento não é um JSON válido.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { erro: 'mapeamento precisa ser um objeto { "coluna": "campo" }.' };
  }
  return parsed as Mapeamento;
}

// ---------------------------------------------------------------------
// POST /importacoes/analisar — só lê, não grava
// ---------------------------------------------------------------------
importacaoRouter.post('/importacoes/analisar', receberArquivo, async (req, res) => {
  try {
    const contexto = await exigirAdminDaEmpresa(req.auth!.userId, req.body?.empresaId);
    if ('erro' in contexto) return res.status(contexto.erro).json({ error: contexto.mensagem });

    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado (campo "arquivo").' });

    const { colunas, linhas } = await lerPlanilha(req.file.buffer, req.file.originalname);
    if (!linhas.length) {
      return res.status(400).json({ error: 'A planilha não tem nenhuma linha de dados abaixo do cabeçalho.' });
    }

    res.status(200).json({
      arquivoNome: req.file.originalname,
      colunas,
      totalLinhas: linhas.length,
      mapeamentoSugerido: sugerirMapeamento(colunas),
      // Amostra para a UI mostrar o que vai acontecer com o mapeamento
      // escolhido, antes de rodar a validação na planilha inteira.
      amostra: linhas.slice(0, 5),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface ClienteExistente {
  telefone: string;
  situacao: string;
}

/** Consulta a base em lotes e devolve o que já existe, por telefone. */
async function existentesPorTelefone(
  empresaId: string,
  telefones: string[],
): Promise<Map<string, ClienteExistente>> {
  const mapa = new Map<string, ClienteExistente>();
  for (let i = 0; i < telefones.length; i += LOTE_CONSULTA) {
    const lote = telefones.slice(i, i + LOTE_CONSULTA);
    const { data, error } = await supabaseAdmin
      .from('clientes')
      .select('telefone, situacao')
      .eq('empresa_id', empresaId)
      .in('telefone', lote);
    if (error) throw new Error(`falha ao conferir duplicados: ${error.message}`);
    for (const linha of (data ?? []) as ClienteExistente[]) {
      mapa.set(linha.telefone, linha);
    }
  }
  return mapa;
}

// ---------------------------------------------------------------------
// POST /importacoes — prévia (confirmar=false) ou gravação (confirmar=true)
// ---------------------------------------------------------------------
importacaoRouter.post('/importacoes', receberArquivo, async (req, res) => {
  try {
    const contexto = await exigirAdminDaEmpresa(req.auth!.userId, req.body?.empresaId);
    if ('erro' in contexto) return res.status(contexto.erro).json({ error: contexto.mensagem });
    const { atendenteId, empresaId } = contexto;

    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado (campo "arquivo").' });

    const origem = String(req.body?.origem ?? '').trim();
    if (!origem) {
      return res.status(400).json({
        error:
          'origem é obrigatória: de onde veio esta lista (evento, formulário, cadastro do site). ' +
          'É o que responde "por que vocês têm o meu número".',
      });
    }

    const baseLegal = String(req.body?.baseLegal ?? '') as BaseLegal;
    if (!BASES_LEGAIS.includes(baseLegal)) {
      return res.status(400).json({
        error: `baseLegal precisa ser uma de: ${BASES_LEGAIS.join(', ')}.`,
      });
    }

    const mapeamento = lerMapeamento(req.body?.mapeamento);
    if ('erro' in mapeamento) return res.status(400).json({ error: mapeamento.erro });

    const problemas = conferirMapeamento(mapeamento as Mapeamento);
    if (problemas.length) {
      return res.status(400).json({ error: 'Mapeamento incompleto.', problemas });
    }

    const confirmar = req.body?.confirmar === 'true' || req.body?.confirmar === true;

    // 1. Ler e validar o arquivo (sem banco).
    const { linhas } = await lerPlanilha(req.file.buffer, req.file.originalname);
    const analise = analisar(linhas, mapeamento as Mapeamento);

    // 2. Conferir contra a base: quem já existe e quem pediu para sair.
    const existentes = await existentesPorTelefone(
      empresaId,
      analise.aceitos.map((a) => a.telefone),
    );

    const novos: EleitorLido[] = [];
    const jaCadastrados: LinhaRejeitada[] = [];
    const emOptOut: LinhaRejeitada[] = [];

    for (const eleitor of analise.aceitos) {
      const existente = existentes.get(eleitor.telefone);
      if (!existente) {
        novos.push(eleitor);
        continue;
      }
      // Opt-out é contado à parte e NUNCA volta. Reimportar a mesma
      // planilha depois de alguém pedir para sair não pode ressuscitar
      // essa pessoa — é o modo de falha que transforma um descadastro
      // atendido numa segunda mensagem.
      if (existente.situacao === 'opt_out') {
        emOptOut.push({ linha: eleitor.linha, motivo: 'Pediu descadastro anteriormente.' });
      } else {
        jaCadastrados.push({ linha: eleitor.linha, motivo: 'Já está no cadastro.' });
      }
    }

    const relatorio = {
      rejeitados: analise.rejeitados.slice(0, TETO_RELATORIO),
      duplicadosNoArquivo: analise.duplicadosNoArquivo.slice(0, TETO_RELATORIO),
      jaCadastrados: jaCadastrados.slice(0, TETO_RELATORIO),
      emOptOut: emOptOut.slice(0, TETO_RELATORIO),
      truncado:
        analise.rejeitados.length > TETO_RELATORIO ||
        analise.duplicadosNoArquivo.length > TETO_RELATORIO ||
        jaCadastrados.length > TETO_RELATORIO ||
        emOptOut.length > TETO_RELATORIO,
    };

    const contagem = {
      linhasLidas: linhas.length,
      aceitas: novos.length,
      duplicadas: analise.duplicadosNoArquivo.length + jaCadastrados.length,
      invalidas: analise.rejeitados.length,
      optOut: emOptOut.length,
    };

    // 3. Registrar a importação — inclusive quando é só prévia. A prévia
    //    descartada também é informação: mostra que alguém tentou subir
    //    uma lista e desistiu, e com qual procedência declarada.
    const { data: importacao, error: erroImportacao } = await supabaseAdmin
      .from('importacoes')
      .insert({
        empresa_id: empresaId,
        criado_por: atendenteId,
        arquivo_nome: req.file.originalname,
        arquivo_hash: createHash('sha256').update(req.file.buffer).digest('hex'),
        arquivo_bytes: req.file.size,
        origem,
        base_legal: baseLegal,
        mapeamento,
        linhas_lidas: contagem.linhasLidas,
        linhas_aceitas: confirmar ? contagem.aceitas : 0,
        linhas_duplicadas: contagem.duplicadas,
        linhas_invalidas: contagem.invalidas,
        linhas_opt_out: contagem.optOut,
        relatorio,
        status: confirmar ? 'confirmada' : 'previa',
        confirmado_em: confirmar ? new Date().toISOString() : null,
      })
      .select('id')
      .single<{ id: string }>();

    if (erroImportacao || !importacao) {
      throw new Error(`falha ao registrar a importação: ${erroImportacao?.message ?? 'sem id'}`);
    }

    if (!confirmar) {
      return res.status(200).json({
        importacaoId: importacao.id,
        status: 'previa',
        contagem,
        relatorio,
        // O que a UI mostra antes do botão de confirmar. Deixar explícito
        // que opt-out nunca entra evita a pergunta "sumiram 40 linhas".
        aviso:
          emOptOut.length > 0
            ? `${emOptOut.length} pessoa(s) desta lista já pediram descadastro e não serão importadas.`
            : undefined,
      });
    }

    // 4. Gravar. Em lotes, e com o vínculo da importação em cada linha —
    //    é o que permite responder de onde veio cada telefone.
    let gravados = 0;
    for (let i = 0; i < novos.length; i += LOTE_INSERT) {
      const lote = novos.slice(i, i + LOTE_INSERT).map((e) => ({
        empresa_id: empresaId,
        nome: e.nome,
        telefone: e.telefone,
        bairro: e.bairro ?? null,
        cidade: e.cidade ?? null,
        zona_eleitoral: e.zonaEleitoral ?? null,
        tags: e.tags,
        origem,
        base_legal: baseLegal,
        consentimento_em: baseLegal === 'consentimento' ? new Date().toISOString() : null,
        importacao_id: importacao.id,
        // Base legal não declarada entra BLOQUEADA. O cadastro fica, para
        // a campanha poder buscar o consentimento depois; o disparo não
        // alcança. É a constraint clientes_sem_base_legal_bloqueado
        // dizendo a mesma coisa no banco.
        situacao: baseLegal === 'nao_declarada' ? 'bloqueado' : 'ativo',
      }));

      const { error } = await supabaseAdmin.from('clientes').insert(lote);
      if (error) {
        // A importação já está registrada; marcá-la como erro é o que
        // impede um relatório mentindo "confirmada" com metade gravada.
        await supabaseAdmin
          .from('importacoes')
          .update({ status: 'erro', linhas_aceitas: gravados })
          .eq('id', importacao.id);
        throw new Error(
          `falha ao gravar o lote a partir da linha ${i + 1} (${gravados} já gravados): ${error.message}`,
        );
      }
      gravados += lote.length;
    }

    res.status(201).json({
      importacaoId: importacao.id,
      status: 'confirmada',
      contagem: { ...contagem, aceitas: gravados },
      relatorio,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------
// GET /importacoes?empresaId=... — histórico
// ---------------------------------------------------------------------
importacaoRouter.get('/importacoes', async (req, res) => {
  try {
    const contexto = await exigirAdminDaEmpresa(req.auth!.userId, req.query?.empresaId);
    if ('erro' in contexto) return res.status(contexto.erro).json({ error: contexto.mensagem });

    const { data, error } = await supabaseAdmin
      .from('importacoes')
      .select(
        'id, arquivo_nome, arquivo_bytes, origem, base_legal, linhas_lidas, linhas_aceitas, ' +
          'linhas_duplicadas, linhas_invalidas, linhas_opt_out, status, criado_em, confirmado_em',
      )
      .eq('empresa_id', contexto.empresaId)
      .order('criado_em', { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);
    res.status(200).json({ importacoes: data ?? [] });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
