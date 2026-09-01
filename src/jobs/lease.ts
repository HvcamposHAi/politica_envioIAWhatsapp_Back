// Posse do gateway — qual instância pode segurar os sockets do WhatsApp.
//
// Ver a migration 20260901120000_gateway_lease.sql para o porquê. Resumo:
// o Render sobe a instância nova antes de encerrar a velha, e nessa janela
// dois processos disputariam as mesmas linhas. Só o dono da posse:
//
//   · reconcilia e reconecta canais no boot (channels/registry.ts)
//   · roda o vigia de canais (jobs/vigiaCanais.ts)
//   · roda o worker de disparo (jobs/disparador.ts)
//
// FALHA FECHADA. Enquanto não soubermos que somos donos, `souODonoDoGateway()`
// é `false` e nada acontece. Um erro de rede na renovação NÃO mantém a posse:
// preferimos um minuto sem reconexão automática a duas instâncias abrindo a
// mesma sessão de WhatsApp.

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import pino from 'pino';
import { supabaseAdmin } from '../db/client.server.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

/**
 * Identidade deste processo.
 *
 * Hostname + sufixo aleatório: o hostname sozinho não serve porque duas
 * instâncias do Render durante um deploy podem ter o mesmo, e o aleatório
 * sozinho não serve porque não diz nada no log.
 */
export const INSTANCIA_ID = `${os.hostname()}-${randomUUID().slice(0, 8)}`;

/** Prazo da posse. Precisa ser confortavelmente maior que o intervalo de
 *  renovação — senão um pico de latência do banco entrega a posse a outro
 *  processo enquanto este ainda está de pé e com sockets abertos. */
const TTL_SEG = Number(process.env.GATEWAY_LEASE_TTL_SEG ?? 45);

/** De quanto em quanto tempo renovar (ou tentar tomar, quando não somos
 *  donos). Também é a frequência com que a instância nova tenta assumir
 *  depois que a velha libera. */
const RENOVACAO_MS = Number(process.env.GATEWAY_LEASE_RENOVACAO_MS ?? 15_000);

let dono = false;
let timer: NodeJS.Timeout | null = null;

/** Chamado na PRIMEIRA vez que esta instância vira dona. É o gancho que
 *  dispara a reconexão de boot — que não pode rodar em server.ts direto,
 *  porque no instante do boot a posse pode ainda ser da instância velha. */
let aoAssumir: (() => void | Promise<void>) | null = null;

export function souODonoDoGateway(): boolean {
  return dono;
}

/**
 * Tenta tomar ou renovar. Nunca lança.
 *
 * A conta é feita no banco (`hub.tomar_lease`), com o relógio do banco:
 * dois processos comparando prazo contra o próprio `Date.now()` decidiriam
 * com relógios diferentes, e o desacordo apareceria justamente na troca de
 * instância.
 */
export async function tentarTomarLease(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc('tomar_lease', {
      p_instancia: INSTANCIA_ID,
      p_ttl_seg: TTL_SEG,
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (err) {
    // Falha fechada: sem confirmação, não somos donos.
    logger.error(
      { instancia: INSTANCIA_ID, err: err instanceof Error ? err.message : String(err) },
      'falha ao tomar/renovar a posse do gateway — assumindo que NÃO somos donos',
    );
    return false;
  }
}

async function passada(): Promise<void> {
  const era = dono;
  dono = await tentarTomarLease();

  if (dono && !era) {
    logger.warn({ instancia: INSTANCIA_ID }, 'esta instância assumiu a posse do gateway');
    if (aoAssumir) {
      try {
        await aoAssumir();
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'falha no gancho de assumir a posse — o vigia de canais tenta de novo',
        );
      }
    }
  }

  if (!dono && era) {
    // Perder a posse com sockets abertos é anormal: significa que a
    // renovação falhou tempo suficiente para outro processo assumir. Não
    // derrubamos os sockets aqui — o vigia e o disparador já param sozinhos
    // por consultarem `souODonoDoGateway()`, e desconectar às cegas seria
    // pior se a causa foi só uma instabilidade de rede.
    logger.error(
      { instancia: INSTANCIA_ID },
      'ESTA INSTÂNCIA PERDEU A POSSE DO GATEWAY — vigia e disparo suspensos até reavê-la',
    );
  }
}

/**
 * Começa a disputar a posse.
 *
 * `aoAssumirPrimeiraVez` roda quando esta instância vira dona — não no boot.
 * A diferença importa: no boot a posse pode ser da instância que está sendo
 * substituída, e reconectar canais nesse momento é exatamente o duelo de
 * sessão que tudo isto existe para evitar.
 */
export function iniciarLease(aoAssumirPrimeiraVez?: () => void | Promise<void>): void {
  if (timer) return;
  aoAssumir = aoAssumirPrimeiraVez ?? null;

  // Primeira tentativa imediata: no caso comum (nenhuma outra instância de
  // pé) a posse é nossa em milissegundos, e nada espera 15s à toa.
  void passada();

  timer = setInterval(() => void passada(), RENOVACAO_MS);
  timer.unref();
  logger.info(
    { instancia: INSTANCIA_ID, ttlSeg: TTL_SEG, renovacaoMs: RENOVACAO_MS },
    'disputa pela posse do gateway iniciada',
  );
}

/**
 * Entrega a posse. Chamado no desligamento gracioso.
 *
 * Sem isto a instância nova esperaria o prazo inteiro (45s) para assumir, e
 * a campanha ficaria esse tempo sem receber mensagem a cada deploy.
 */
export async function liberarLease(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!dono) return;
  dono = false;
  try {
    await supabaseAdmin.rpc('liberar_lease', { p_instancia: INSTANCIA_ID });
    logger.warn({ instancia: INSTANCIA_ID }, 'posse do gateway liberada');
  } catch (err) {
    // A posse vence sozinha em TTL_SEG. Falhar aqui atrasa a troca, não a
    // impede — não vale atrasar o shutdown por causa disso.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'falha ao liberar a posse do gateway — ela vence sozinha em segundos',
    );
  }
}

/** Só para teste. */
export function _forcarDono(valor: boolean): void {
  dono = valor;
}
