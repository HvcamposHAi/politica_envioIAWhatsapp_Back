// Conversão de áudio gravado no navegador para nota de voz do WhatsApp.
//
// POR QUE ISTO EXISTE: o `MediaRecorder` do Chrome produz `audio/webm;
// codecs=opus`. O WhatsApp só mostra a ONDA e o botão de play — a nota de voz
// de verdade — quando o stanza é `ptt: true` com opus dentro de um container
// OGG. Mandando webm, o atendente grava um áudio, o Hub diz "enviado", e boa
// parte dos Androids do outro lado exibe um anexo que não toca. É pior do que
// não ter o botão.
//
// O container muda; o codec não. `-c:a copy` remuxa opus/webm para opus/ogg
// sem recodificar (rápido, sem perda). Se a entrada não for opus (Safari grava
// mp4/aac), aí sim recodifica.
//
// DEPENDÊNCIA DE IMAGEM: exige `ffmpeg` no container (ver Dockerfile). Sem ele
// a rota de upload recusa a nota de voz com uma mensagem explícita, em vez de
// enviar um arquivo que não toca.

import { spawn } from 'node:child_process';

const FFMPEG = process.env.FFMPEG_CAMINHO ?? 'ffmpeg';
/** Teto de tempo da conversão. Nota de voz é curta; passar disto é ffmpeg
 *  travado, e um processo pendurado neste container segura a instância única
 *  que também segura os sockets do WhatsApp. */
const TIMEOUT_MS = 30_000;

let _disponivel: boolean | undefined;

/** ffmpeg está instalado? Cacheado — é uma propriedade da imagem, não muda em
 *  tempo de execução. */
export async function ffmpegDisponivel(): Promise<boolean> {
  if (_disponivel !== undefined) return _disponivel;
  _disponivel = await new Promise<boolean>((resolve) => {
    const p = spawn(FFMPEG, ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (codigo) => resolve(codigo === 0));
  });
  return _disponivel;
}

/** Só para teste — permite reavaliar a disponibilidade. */
export function limparCacheFfmpeg(): void {
  _disponivel = undefined;
}

export interface AudioConvertido {
  buffer: Buffer;
  duracaoSeg?: number;
}

/**
 * Converte qualquer áudio de entrada em opus/ogg pronto para `ptt: true`.
 *
 * Rejeita (não devolve o original) quando falha: mandar o arquivo cru como se
 * fosse nota de voz é justamente o defeito que esta função previne. Quem chama
 * traduz a rejeição num erro claro para o atendente.
 */
export async function converterParaNotaDeVoz(entrada: Buffer): Promise<AudioConvertido> {
  if (!(await ffmpegDisponivel())) {
    throw new Error(
      'Gravação de áudio indisponível: o conversor (ffmpeg) não está instalado neste servidor. ' +
        'Envie o áudio como arquivo anexado enquanto isso.',
    );
  }

  const argumentos = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    '24k',
    '-ar',
    '48000',
    '-ac',
    '1',
    '-f',
    'ogg',
    'pipe:1',
  ];

  return new Promise<AudioConvertido>((resolve, reject) => {
    const proc = spawn(FFMPEG, argumentos);
    const pedacos: Buffer[] = [];
    const erros: Buffer[] = [];
    let encerrado = false;

    const relogio = setTimeout(() => {
      encerrado = true;
      proc.kill('SIGKILL');
      reject(new Error('Conversão do áudio demorou demais e foi cancelada.'));
    }, TIMEOUT_MS);
    relogio.unref?.();

    proc.stdout.on('data', (d: Buffer) => pedacos.push(d));
    proc.stderr.on('data', (d: Buffer) => erros.push(d));
    proc.on('error', (err) => {
      clearTimeout(relogio);
      if (!encerrado) reject(err);
    });
    proc.on('close', (codigo) => {
      clearTimeout(relogio);
      if (encerrado) return;
      const saida = Buffer.concat(pedacos);
      if (codigo !== 0 || saida.length === 0) {
        reject(
          new Error(
            `Não foi possível converter o áudio (ffmpeg ${codigo}): ${Buffer.concat(erros).toString('utf8').slice(0, 200)}`,
          ),
        );
        return;
      }
      resolve({ buffer: saida });
    });

    proc.stdin.on('error', () => {
      // EPIPE quando o ffmpeg morre antes de consumir tudo — o 'close' acima
      // já reporta a causa real.
    });
    proc.stdin.end(entrada);
  });
}
