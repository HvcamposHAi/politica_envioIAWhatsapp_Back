// O ritmo do disparo — Fase 3 do PLANO_CAMPANHA_INDIARA.md.
//
// Tudo aqui é FUNÇÃO PURA: sem banco, sem socket, sem relógio implícito. O
// worker (jobs/disparador.ts) traz o estado e o instante; este módulo só
// decide. A separação é o que permite testar "às 20h01 não envia", "no dia
// 1 o teto é 40" e "opt-out barra antes de tudo" sem subir Postgres nem
// parear um número de WhatsApp.
//
// O QUE ESTE MÓDULO NÃO É: não é um jeito de driblar detecção. O ritmo
// existe porque uma linha nova que dispara 400 mensagens na primeira hora
// é indistinguível de spam — inclusive para uma pessoa que recebe. Janela
// diurna, intervalo entre mensagens e rampa de aquecimento são o que faz a
// campanha parecer o que ela é. Elas reduzem, e não eliminam, o risco de
// ban assumido por escrito no §1.1 do plano.

/** Fuso da campanha. O Cloud Run roda em UTC; decidir janela horária pelo
 *  relógio do container mandaria mensagem às 6h da manhã achando que são
 *  9h. O fuso é fixo de propósito — a campanha é municipal. */
export const FUSO_CAMPANHA = 'America/Sao_Paulo';

export interface RitmoConfig {
  /** 'HH:MM' no fuso da campanha. */
  janelaInicio: string;
  janelaFim: string;
  intervaloMinSeg: number;
  intervaloMaxSeg: number;
  /** Teto por dia de vida do canal. O último valor vale para todo dia
   *  seguinte. Vazio = sem rampa (só o teto fixo do disparo, se houver). */
  rampa: number[];
  /** Teto explícito do disparo. Quando os dois existem, vence o MENOR:
   *  a rampa protege a linha, o teto protege o orçamento, e nenhum dos
   *  dois deveria poder ser anulado pelo outro. */
  tetoDiario?: number | null;
}

export type MotivoParada =
  | 'fora_da_janela'
  | 'teto_diario'
  | 'canal_desconectado'
  | 'pausado'
  | 'sem_pendentes'
  | 'disparo_inativo';

export type Decisao = { enviar: true } | { enviar: false; motivo: MotivoParada };

/** Converte 'HH:MM' em minutos desde a meia-noite. Devolve null para
 *  formato inválido — quem chama trata, ninguém adivinha 00:00. */
export function minutosDoDia(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** O minuto do dia AGORA, no fuso da campanha — não no fuso do container. */
export function minutoAtualNaCampanha(agora: Date, fuso = FUSO_CAMPANHA): number {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const partes = fmt.formatToParts(agora);
  const h = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const min = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl pode devolver "24" para meia-noite em algumas combinações de
  // locale/hourCycle. 24:00 e 00:00 são o mesmo instante.
  return (h % 24) * 60 + min;
}

/** A data civil (YYYY-MM-DD) no fuso da campanha. É o que define "hoje"
 *  para o contador diário — meia-noite em Brasília, não em UTC, senão o
 *  contador vira às 21h e a campanha ganha um teto extra à noite. */
export function diaNaCampanha(agora: Date, fuso = FUSO_CAMPANHA): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(agora);
}

/**
 * A janela é inclusiva no início e EXCLUSIVA no fim: com 09:00–20:00,
 * 20:00 em ponto já está fora. Mensagem às 20:00:59 é mensagem às oito da
 * noite para quem recebe, e "o limite era 20h" não ajuda ninguém.
 *
 * Janela invertida (fim <= início) é recusada, não interpretada como
 * "atravessa a meia-noite". Disparo de campanha que cruza a madrugada é
 * exatamente o que a janela existe para impedir; aceitar isso em silêncio
 * seria transformar um erro de digitação em envio às 3h.
 */
export function dentroDaJanela(agora: Date, inicio: string, fim: string, fuso = FUSO_CAMPANHA): boolean {
  const i = minutosDoDia(inicio);
  const f = minutosDoDia(fim);
  if (i === null || f === null || f <= i) return false;
  const atual = minutoAtualNaCampanha(agora, fuso);
  return atual >= i && atual < f;
}

/**
 * Teto de hoje, em mensagens.
 *
 * `diasDeVida` é 1 no primeiro dia da linha. A rampa cresce até o último
 * valor, que vale dali em diante. Quando o disparo também tem teto
 * próprio, vence o menor dos dois.
 */
export function tetoDeHoje(diasDeVida: number, config: RitmoConfig): number | null {
  const dia = Math.max(1, Math.floor(diasDeVida));
  const daRampa = config.rampa.length
    ? config.rampa[Math.min(dia, config.rampa.length) - 1]
    : null;
  const doDisparo = config.tetoDiario ?? null;

  if (daRampa === null) return doDisparo;
  if (doDisparo === null) return daRampa;
  return Math.min(daRampa, doDisparo);
}

/** Dias de vida da linha, contando o dia da conexão como 1. */
export function diasDeVidaDaLinha(primeiraConexao: Date | null, agora: Date, fuso = FUSO_CAMPANHA): number {
  if (!primeiraConexao) return 1;
  const a = diaNaCampanha(primeiraConexao, fuso);
  const b = diaNaCampanha(agora, fuso);
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.max(1, Math.floor(ms / 86_400_000) + 1);
}

/**
 * Intervalo até o próximo envio, em milissegundos.
 *
 * `aleatorio` é injetado (0 <= x < 1) para o teste ser determinístico. O
 * sorteio é uniforme entre min e max, inclusive nas pontas.
 */
export function proximoIntervaloMs(
  intervaloMinSeg: number,
  intervaloMaxSeg: number,
  aleatorio: number,
): number {
  const min = Math.max(1, Math.floor(intervaloMinSeg));
  const max = Math.max(min, Math.floor(intervaloMaxSeg));
  const x = Math.min(Math.max(aleatorio, 0), 0.999999);
  // Sorteia SEGUNDOS inteiros e só então converte. Fazer o piso depois da
  // multiplicação por 1000 deixava o resultado passar do máximo
  // configurado (90,99s viravam 90999ms com max=90) — um intervalo que
  // estoura o teto é menos grave que um que o ignora, mas "o que eu
  // configurei é o que acontece" é o mínimo de um controle de ritmo.
  const segundos = Math.min(max, min + Math.floor(x * (max - min + 1)));
  return segundos * 1000;
}

/**
 * Quanto tempo mostrar "digitando…" antes de mandar.
 *
 * Proporcional ao tamanho do texto, com piso e teto. Não é disfarce: uma
 * mensagem longa que aparece instantaneamente, num app onde o indicador de
 * digitação é parte da conversa, é ruído de interface. O teto de 6s existe
 * porque acima disso o indicador vira espera, não sinal — e porque o tempo
 * de digitação sai do orçamento de envios do dia.
 */
export function tempoDigitandoMs(texto: string): number {
  const CARACTERES_POR_SEGUNDO = 18;
  const PISO_MS = 800;
  const TETO_MS = 6_000;
  const estimado = (texto.length / CARACTERES_POR_SEGUNDO) * 1000;
  return Math.round(Math.min(Math.max(estimado, PISO_MS), TETO_MS));
}

export interface EstadoDisparo {
  status: string;
  pausadoEm: string | null;
  enviadosHoje: number;
  contadorDia: string | null;
  pendentes: number;
  canalConectado: boolean;
  diasDeVidaDaLinha: number;
}

/**
 * A decisão do worker, num lugar só.
 *
 * A ORDEM IMPORTA e é a mesma do §3.4 do plano: o que protege a pessoa do
 * outro lado vem antes do que protege a operação. Opt-out e base legal já
 * foram barrados no banco (triggers da Fase 1) antes de o alvo existir —
 * aqui começa do disparo em si.
 */
export function decidir(estado: EstadoDisparo, config: RitmoConfig, agora: Date): Decisao {
  if (estado.status !== 'enviando') return { enviar: false, motivo: 'disparo_inativo' };
  if (estado.pausadoEm) return { enviar: false, motivo: 'pausado' };
  if (estado.pendentes <= 0) return { enviar: false, motivo: 'sem_pendentes' };
  if (!estado.canalConectado) return { enviar: false, motivo: 'canal_desconectado' };
  if (!dentroDaJanela(agora, config.janelaInicio, config.janelaFim)) {
    return { enviar: false, motivo: 'fora_da_janela' };
  }

  const teto = tetoDeHoje(estado.diasDeVidaDaLinha, config);
  if (teto !== null) {
    // Contador de outro dia é contador zerado. Sem esta conferência, a
    // campanha para para sempre no dia em que bate o teto.
    const enviadosHoje = estado.contadorDia === diaNaCampanha(agora) ? estado.enviadosHoje : 0;
    if (enviadosHoje >= teto) return { enviar: false, motivo: 'teto_diario' };
  }

  return { enviar: true };
}

export interface LimiaresPausa {
  falhaPct: number;
  optOutPct: number;
  /** Abaixo disto não se conclui nada: 2 falhas em 3 envios é 66%, e não
   *  é sinal de nada. */
  amostraMinima: number;
}

export type MotivoPausaAutomatica = 'taxa_de_falha' | 'taxa_de_optout';

/**
 * Freio automático.
 *
 * A taxa de opt-out é o número mais importante da campanha: é a medida
 * direta de quanta gente está incomodada, e ela sobe ANTES de a denúncia
 * em massa acontecer. Por isso o limiar dela é bem mais baixo que o de
 * falha técnica.
 */
export function avaliarPausaAutomatica(
  janela: { enviados: number; falhas: number; optOuts: number },
  limiares: LimiaresPausa,
): MotivoPausaAutomatica | null {
  if (janela.enviados < limiares.amostraMinima) return null;
  if ((janela.optOuts / janela.enviados) * 100 >= limiares.optOutPct) return 'taxa_de_optout';
  if ((janela.falhas / janela.enviados) * 100 >= limiares.falhaPct) return 'taxa_de_falha';
  return null;
}

/**
 * Substituição de campos no texto-base. É o que a Fase 3 entrega enquanto
 * a personalização por IA (Fase 4) não existe.
 *
 * Campo sem valor vira string VAZIA e o resultado passa por uma limpeza de
 * espaço duplicado. A alternativa — deixar "Olá {{nome}}," literal — é o
 * erro que todo mundo já recebeu por SMS, e ele diz para a pessoa, em uma
 * linha, que ela é uma linha de planilha.
 */
export function aplicarCampos(textoBase: string, campos: Record<string, string | null | undefined>): string {
  const substituido = textoBase.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_todo, chave: string) => {
    const v = campos[chave];
    return v === null || v === undefined ? '' : String(v);
  });
  return substituido
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Os campos que o texto-base pode usar hoje. Documentado aqui porque a UI
 *  precisa listá-los para quem escreve a mensagem. */
export const CAMPOS_DO_TEXTO = ['nome', 'primeiro_nome', 'bairro', 'cidade'] as const;
