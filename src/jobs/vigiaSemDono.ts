// Vigia de conversas SEM DONO — a rede de segurança da regra de acesso nova.
//
// POR QUE ISTO EXISTE: em 2026-08-17 o escopo de conversa passou a ser por
// atendente (ver PLANO_GOVERNANCA_ACESSOS.md). O operador deixou de ver a fila
// "Sem dono", e a contrapartida acordada com o cliente foi: "conversa sem dono
// é sempre visível para o gestor da área e para o administrador, e os dois são
// informados".
//
// A primeira metade dessa frase a RLS resolve — o supervisor casa pelo setor
// que ele supervisiona, o admin pelo canal. A SEGUNDA metade não tinha
// mecanismo nenhum: o contador na Caixa só aparece para quem já está com a tela
// aberta. À noite, no fim de semana e no horário de almoço, uma conversa de
// cliente podia ficar parada sem ninguém saber — e agora sem nem aparecer para
// o operador que antes a puxaria.
//
// O QUE ELE FAZ: conta, a cada passada, as conversas abertas sem dono que já
// passaram do limite de espera, e registra no log com o setor. É isso. Não
// atribui ninguém: distribuir é decisão de gente, e um round-robin automático
// escondido num job seria pior que o silêncio que ele veio resolver — o
// supervisor perderia a única visão que tem da carga real.
//
// O QUE ELE NÃO FAZ: não manda e-mail nem WhatsApp. Sem alguém para calibrar o
// volume, notificação assim vira ruído e é desligada na primeira semana; o log
// estruturado alimenta alerta no Cloud Logging quando o cliente decidir o
// limite dele. Ver §7.4 do plano.

import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';

const logger = pino({ level: process.env.VIGIA_SEM_DONO_LOG_LEVEL ?? 'info' });

/** Uma passada a cada 5 minutos. Deliberadamente mais lento que o vigia de
 *  canais (60s): ali o alvo é uma sessão de WhatsApp caindo, aqui é uma pessoa
 *  precisando reagir. Passada mais curta não faria o supervisor chegar mais
 *  rápido — só encheria o log. */
export const VIGIA_SEM_DONO_INTERVALO_MS = 5 * 60_000;

/** Quanto tempo uma conversa pode ficar sem dono antes de virar alerta.
 *  15 minutos é o mesmo número do critério de pronto do plano (§12) — o que o
 *  job mede e o que o cliente aceitou são a mesma coisa, de propósito. */
export const LIMITE_SEM_DONO_MS = 15 * 60_000;

interface ConversaSemDono {
  id: string;
  setor_id: string | null;
  aberta_em: string;
  setores: { nome: string | null } | null;
}

export interface ResultadoVigiaSemDono {
  /** Conversas sem dono acima do limite. */
  atrasadas: number;
  /** A mais antiga, em minutos. 0 quando não há nenhuma. */
  esperaMaximaMin: number;
  /** Quantas por setor, para o log dizer ONDE está o problema — "3 sem dono"
   *  não aciona ninguém; "3 sem dono no Compras" aciona. */
  porSetor: Record<string, number>;
}

/** Uma passada. Exportada para teste — o `setInterval` só a chama. */
export async function vigiarSemDono(agora = Date.now()): Promise<ResultadoVigiaSemDono> {
  const vazio: ResultadoVigiaSemDono = { atrasadas: 0, esperaMaximaMin: 0, porSetor: {} };
  try {
    const corte = new Date(agora - LIMITE_SEM_DONO_MS).toISOString();

    /* Só colunas simples e UM embed de nome de setor.
     *
     * Nada de `atendentes(nome)` aqui: uma FK nova para hub.atendentes já
     * tornou um embed desses ambíguo neste projeto e derrubou a análise de IA
     * em silêncio por uma hora. Job de segundo plano que falha calado é a
     * mesma classe de problema que ele veio resolver. */
    const { data, error } = await supabaseAdmin
      .from('conversas')
      .select('id, setor_id, aberta_em, setores(nome)')
      .is('fechada_em', null)
      .is('atendente_id', null)
      .neq('origem_chat', 'grupo')
      .lte('aberta_em', corte)
      .order('aberta_em', { ascending: true });

    if (error) {
      // Relança para o catch abaixo: uma falha de leitura NÃO pode ser
      // reportada como "nenhuma conversa esperando".
      throw new Error(error.message);
    }

    const linhas = (data ?? []) as unknown as ConversaSemDono[];
    if (!linhas.length) {
      logger.debug('vigia sem dono: nenhuma conversa acima do limite');
      return vazio;
    }

    const porSetor: Record<string, number> = {};
    for (const c of linhas) {
      const nome = c.setores?.nome ?? 'sem setor';
      porSetor[nome] = (porSetor[nome] ?? 0) + 1;
    }

    // `linhas` vem ordenada por aberta_em asc, então a primeira é a mais antiga.
    const esperaMaximaMin = Math.round((agora - new Date(linhas[0].aberta_em).getTime()) / 60_000);

    logger.warn(
      { atrasadas: linhas.length, esperaMaximaMin, porSetor, limiteMin: LIMITE_SEM_DONO_MS / 60_000 },
      'conversas sem dono esperando distribuição além do limite',
    );

    return { atrasadas: linhas.length, esperaMaximaMin, porSetor };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'vigia sem dono: passada falhou por inteiro — próxima passada tenta de novo',
    );
    return vazio;
  }
}

let timer: ReturnType<typeof setInterval> | undefined;

export function iniciarVigiaSemDono(): void {
  if (timer) return;
  // Uma passada imediata, ao contrário do vigia de canais: aqui não há
  // handshake para esperar. Se o processo subiu e já existe fila parada, o
  // supervisor precisa saber agora, não em 5 minutos.
  void vigiarSemDono();
  timer = setInterval(() => void vigiarSemDono(), VIGIA_SEM_DONO_INTERVALO_MS);
  timer.unref?.();
}

export function pararVigiaSemDono(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
