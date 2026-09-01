// POST /alice/chat — conversa do gestor com a Alice no Painel.
// PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md, fase 3.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { buscarAtendenteAutenticado } from '../auth/escopoConversa.js';
import { responderAlice, type FiltrosAlice, type TurnoAlice } from '../services/alice.js';
import {
  FOCOS_VALIDOS,
  PERIODOS_VALIDOS,
  type AliceFoco,
  type FocoTipo,
  type PeriodoFoco,
} from '../services/aliceFoco.js';

export const aliceRouter = Router();
aliceRouter.use(requireSupabaseAuth());

const MAX_TURNOS = 20;
const MAX_CHARS_TURNO = 4000;

/* Limites do objeto `foco`. Ele vem do nosso próprio Painel, mas chega pela
 * rede como qualquer outra entrada — e três dos campos (titulo, valor, linhas)
 * entram no prompt. Nenhum deles decide QUAIS dados são lidos (isso continua
 * saindo do atendente autenticado), então o risco é de custo e de ruído, não de
 * vazamento; o teto trata dos dois. */
const MAX_CHARS_TITULO = 120;
const MAX_CHARS_VALOR = 60;
const MAX_LINHAS_FOCO = 8;
const MAX_CHARS_LINHA = 200;
const MAX_CHARS_MOTIVO = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Limite próprio, além do global de 300/min do server.ts. Cada requisição aqui
 * custa uma chamada ao modelo com contexto da janela inteira — sem teto por
 * usuário, um loop no front (ou impaciência com Enter) vira conta alta em
 * minutos. Chaveado pelo usuário autenticado, não pelo IP: numa empresa todo
 * mundo sai pelo mesmo IP, e o limite global puniria o escritório inteiro.
 *
 * Subiu de 10 para 20 quando o Painel virou clicável: o modo de uso deixou de
 * ser "digitar uma pergunta" e passou a ser "explorar cards", que é
 * estruturalmente mais frequente. Dez cliques por minuto é exploração normal,
 * e um 429 no meio dela leria como bug. */
const limitePorUsuario = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? req.ip ?? 'anonimo',
  message: { error: 'Muitas perguntas seguidas. Aguarde um minuto.' },
});

interface CorpoAlice {
  mensagens?: unknown;
  filtros?: { empresaId?: unknown; setorId?: unknown; atendenteId?: unknown };
  foco?: unknown;
}

/** Valida o histórico vindo do front. O front é confiável para a CONVERSA
 *  (é o que o usuário digitou), nunca para o escopo dos dados — este é
 *  montado no servidor a partir do atendente autenticado. */
function validarTurnos(bruto: unknown): { turnos: TurnoAlice[] } | { erro: string } {
  if (!Array.isArray(bruto) || bruto.length === 0) {
    return { erro: 'Envie ao menos uma mensagem.' };
  }
  if (bruto.length > MAX_TURNOS) {
    return { erro: `Histórico muito longo (máximo ${MAX_TURNOS} mensagens).` };
  }

  const turnos: TurnoAlice[] = [];
  for (const item of bruto) {
    const t = item as { role?: unknown; content?: unknown };
    if (t.role !== 'user' && t.role !== 'assistant') {
      return { erro: "Cada mensagem precisa de role 'user' ou 'assistant'." };
    }
    if (typeof t.content !== 'string' || !t.content.trim()) {
      return { erro: 'Mensagem sem conteúdo.' };
    }
    if (t.content.length > MAX_CHARS_TURNO) {
      return { erro: `Mensagem muito longa (máximo ${MAX_CHARS_TURNO} caracteres).` };
    }
    turnos.push({ role: t.role, content: t.content });
  }

  // A API exige que a conversa termine numa fala do usuário.
  if (turnos[turnos.length - 1].role !== 'user') {
    return { erro: 'A última mensagem precisa ser do usuário.' };
  }
  return { turnos };
}

const texto = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Id do recorte: só passa se for UUID. Qualquer outra coisa (objeto, número,
 *  string com operador do PostgREST) vira `undefined` — mesma postura do
 *  `texto()` acima com os filtros. */
const uuid = (v: unknown): string | undefined =>
  typeof v === 'string' && UUID.test(v) ? v : undefined;

/**
 * Valida o `foco`. Ausente → `undefined` (o caminho de hoje, que é o que
 * mantém um front antigo funcionando). Presente e malformado → erro 400.
 *
 * O 400 é deliberado em vez de "ignora e segue": o `foco` é produzido pela
 * nossa própria UI, então um tipo fora da allowlist é bug de deploy (front à
 * frente do backend) ou requisição forjada. Engolir esconderia os dois, e o
 * sintoma seria uma resposta genérica que ninguém saberia explicar.
 */
function validarFoco(bruto: unknown): { foco?: AliceFoco } | { erro: string } {
  if (bruto === undefined || bruto === null) return {};
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return { erro: 'Foco malformado.' };

  const f = bruto as Record<string, unknown>;

  if (!FOCOS_VALIDOS.includes(f.tipo as FocoTipo)) {
    return { erro: 'Indicador desconhecido.' };
  }
  if (!PERIODOS_VALIDOS.includes(f.periodo as PeriodoFoco)) {
    return { erro: 'Período do indicador inválido.' };
  }

  const titulo = texto(f.titulo);
  const valor = texto(f.valor);
  if (!titulo || titulo.length > MAX_CHARS_TITULO) return { erro: 'Título do indicador inválido.' };
  if (!valor || valor.length > MAX_CHARS_VALOR) return { erro: 'Valor do indicador inválido.' };

  // `desde` é só uma data; a janela em si é clampada em aliceFoco.resolverJanela.
  const desde = texto(f.desde);
  if (!desde || Number.isNaN(new Date(desde).getTime())) {
    return { erro: 'Início da janela inválido.' };
  }

  const brutoLinhas = Array.isArray(f.linhas) ? f.linhas : [];
  if (brutoLinhas.length > MAX_LINHAS_FOCO) return { erro: 'Indicador com detalhes demais.' };
  const linhas: string[] = [];
  for (const l of brutoLinhas) {
    const s = texto(l);
    if (!s) continue; // linha vazia é ruído, não erro
    if (s.length > MAX_CHARS_LINHA) return { erro: 'Detalhe do indicador muito longo.' };
    linhas.push(s);
  }

  const r = (f.recorte ?? {}) as Record<string, unknown>;
  const motivo = texto(r.motivo);
  if (motivo && motivo.length > MAX_CHARS_MOTIVO) return { erro: 'Motivo de perda muito longo.' };

  return {
    foco: {
      tipo: f.tipo as FocoTipo,
      periodo: f.periodo as PeriodoFoco,
      titulo,
      valor,
      desde,
      linhas,
      mock: f.mock === true,
      recorte: {
        setorId: uuid(r.setorId),
        atendenteId: uuid(r.atendenteId),
        canalId: uuid(r.canalId),
        conversaId: uuid(r.conversaId),
        motivo,
      },
    },
  };
}

aliceRouter.post('/alice/chat', limitePorUsuario, async (req, res) => {
  try {
    const atendente = await buscarAtendenteAutenticado(req.auth!.userId);
    if (!atendente) {
      return res.status(403).json({ error: 'Usuário autenticado não corresponde a um atendente ativo.' });
    }

    /* Gate de perfil. A Alice responde sobre a OPERAÇÃO — volume de chamados,
     * ranking por atendente, motivos de perda, CSAT — e o Painel, que é a tela
     * dela, sempre foi supervisor/admin. Só que isso era imposto apenas no
     * front (`abasVisiveis`), e esta rota aceitava qualquer atendente ativo:
     * um operador com o token dele obtinha os indicadores da empresa inteira
     * via curl. Ver PLANO_GOVERNANCA_ACESSOS.md (incoerência I2). */
    if (atendente.perfil !== 'admin' && atendente.perfil !== 'supervisor') {
      return res
        .status(403)
        .json({ error: 'A Alice atende supervisão e administração.' });
    }

    const corpo = (req.body ?? {}) as CorpoAlice;
    const validado = validarTurnos(corpo.mensagens);
    if ('erro' in validado) return res.status(400).json({ error: validado.erro });

    const filtros: FiltrosAlice = {
      empresaId: texto(corpo.filtros?.empresaId),
      setorId: texto(corpo.filtros?.setorId),
      atendenteId: texto(corpo.filtros?.atendenteId),
    };

    const comFoco = validarFoco(corpo.foco);
    if ('erro' in comFoco) return res.status(400).json({ error: comFoco.erro });

    const resposta = await responderAlice(atendente.id, validado.turnos, filtros, comFoco.foco);
    res.status(200).json({ resposta });
  } catch (err) {
    const mensagem = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('falha na conversa com a Alice:', mensagem);
    const status = (err as { status?: number } | null)?.status;
    res.status(500).json({
      error:
        status === 401
          ? 'Chave da Anthropic não configurada ou inválida. Peça a um administrador para configurar em Configurações → Integrações.'
          : mensagem,
    });
  }
});
