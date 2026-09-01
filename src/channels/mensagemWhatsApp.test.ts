// Testes do classificador de conteúdo (channels/mensagemWhatsApp.ts).
//
// É o único pedaço da ingestão testável sem número real, sem socket e sem
// banco — e é onde mora a regra que esta feature comprou: nenhuma mensagem
// recebida pode ser descartada em silêncio.
import { describe, expect, it } from 'vitest';
import {
  classificarConteudo,
  desembrulhar,
  extensaoDe,
  TIPOS_COM_MIDIA,
  TIPOS_DE_AUDIO,
} from './mensagemWhatsApp.js';

describe('classificarConteudo — texto', () => {
  it('classifica conversation simples', () => {
    expect(classificarConteudo({ conversation: 'bom dia' })).toMatchObject({
      tipo: 'texto',
      texto: 'bom dia',
    });
  });

  it('classifica extendedTextMessage e captura a citação', () => {
    const r = classificarConteudo({
      extendedTextMessage: { text: 'respondendo', contextInfo: { stanzaId: 'ABC123' } },
    });
    expect(r).toMatchObject({ tipo: 'texto', texto: 'respondendo', citandoWaId: 'ABC123' });
  });

  it('texto só de espaço vira undefined, não string vazia', () => {
    expect(classificarConteudo({ conversation: '   ' }).texto).toBeUndefined();
  });
});

describe('classificarConteudo — mídia', () => {
  it('imagem com legenda é UMA mensagem, não duas', () => {
    const r = classificarConteudo({
      imageMessage: {
        mimetype: 'image/jpeg',
        caption: 'olha o milho',
        fileLength: 204800,
        width: 1600,
        height: 1200,
        jpegThumbnail: Buffer.from([1, 2, 3]),
      },
    });
    expect(r.tipo).toBe('imagem');
    expect(r.texto).toBe('olha o milho');
    expect(r.midia).toMatchObject({ tipoMime: 'image/jpeg', tamanho: 204800, largura: 1600 });
    expect(r.midia?.thumbnail?.length).toBe(3);
  });

  it('imagem sem legenda não inventa texto', () => {
    expect(classificarConteudo({ imageMessage: { mimetype: 'image/jpeg' } }).texto).toBeUndefined();
  });

  it('vídeo traz duração e marca gif', () => {
    const r = classificarConteudo({
      videoMessage: { mimetype: 'video/mp4', seconds: 12, gifPlayback: true },
    });
    expect(r).toMatchObject({ tipo: 'video', conteudoExtra: { gif: true } });
    expect(r.midia?.duracaoSeg).toBe(12);
  });

  it('ptt=true é nota de voz; ptt=false é áudio anexado', () => {
    expect(classificarConteudo({ audioMessage: { ptt: true, seconds: 8 } }).tipo).toBe('voz');
    expect(classificarConteudo({ audioMessage: { ptt: false, seconds: 8 } }).tipo).toBe('audio');
  });

  it('documento preserva o nome do arquivo', () => {
    const r = classificarConteudo({
      documentMessage: { mimetype: 'application/pdf', fileName: 'nota-fiscal.pdf', pageCount: 3 },
    });
    expect(r.tipo).toBe('documento');
    expect(r.midia?.nome).toBe('nota-fiscal.pdf');
    expect(r.conteudoExtra).toMatchObject({ paginas: 3 });
  });

  it('figurinha animada é marcada', () => {
    const r = classificarConteudo({ stickerMessage: { mimetype: 'image/webp', isAnimated: true } });
    expect(r).toMatchObject({ tipo: 'figurinha', conteudoExtra: { animada: true } });
  });

  it('fileLength em Long (protobufjs) vira número', () => {
    const r = classificarConteudo({
      imageMessage: { mimetype: 'image/png', fileLength: { toNumber: () => 999 } },
    });
    expect(r.midia?.tamanho).toBe(999);
  });

  it('todo tipo com mídia está no conjunto TIPOS_COM_MIDIA', () => {
    for (const msg of [
      { imageMessage: {} },
      { videoMessage: {} },
      { audioMessage: {} },
      { documentMessage: {} },
      { stickerMessage: {} },
    ]) {
      const r = classificarConteudo(msg);
      expect(TIPOS_COM_MIDIA.has(r.tipo), `${r.tipo} deveria ter mídia`).toBe(true);
      expect(r.midia).toBeDefined();
    }
  });

  it('só áudio entra na transcrição', () => {
    expect(TIPOS_DE_AUDIO.has('voz')).toBe(true);
    expect(TIPOS_DE_AUDIO.has('audio')).toBe(true);
    expect(TIPOS_DE_AUDIO.has('video')).toBe(false);
  });
});

describe('classificarConteudo — envelopes', () => {
  it('desembrulha mensagem temporária (ephemeral)', () => {
    const r = classificarConteudo({
      ephemeralMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
    });
    expect(r.tipo).toBe('imagem');
  });

  it('desembrulha "ver uma vez" (viewOnceMessageV2)', () => {
    const r = classificarConteudo({
      viewOnceMessageV2: { message: { videoMessage: { mimetype: 'video/mp4' } } },
    });
    expect(r.tipo).toBe('video');
  });

  it('desembrulha documento com legenda', () => {
    const r = classificarConteudo({
      documentWithCaptionMessage: {
        message: { documentMessage: { mimetype: 'application/pdf', caption: 'segue' } },
      },
    });
    expect(r).toMatchObject({ tipo: 'documento', texto: 'segue' });
  });

  it('envelope aninhado não entra em laço infinito', () => {
    const recursivo: Record<string, unknown> = {};
    recursivo.ephemeralMessage = { message: recursivo };
    expect(() => desembrulhar(recursivo)).not.toThrow();
  });
});

describe('classificarConteudo — efeitos (não criam linha nova)', () => {
  it('REVOKE vira efeito apagar', () => {
    const r = classificarConteudo({ protocolMessage: { type: 0, key: { id: 'M1' } } });
    expect(r.efeito).toEqual({ tipo: 'apagar', alvoWaId: 'M1' });
  });

  it('MESSAGE_EDIT vira efeito editar com o texto novo', () => {
    const r = classificarConteudo({
      protocolMessage: {
        type: 14,
        key: { id: 'M2' },
        editedMessage: { message: { conversation: 'texto corrigido' } },
      },
    });
    expect(r.efeito).toEqual({ tipo: 'editar', alvoWaId: 'M2', texto: 'texto corrigido' });
  });

  it('aceita o enum como string (mock/teste)', () => {
    expect(classificarConteudo({ protocolMessage: { type: 'REVOKE', key: { id: 'M3' } } }).efeito)
      .toMatchObject({ tipo: 'apagar' });
  });

  it('reação vira efeito reagir', () => {
    const r = classificarConteudo({ reactionMessage: { key: { id: 'M4' }, text: '👍' } });
    expect(r.efeito).toEqual({ tipo: 'reagir', alvoWaId: 'M4', texto: '👍' });
  });

  it('reação removida (texto vazio) ainda é um efeito — a bolha precisa perder o emoji', () => {
    const r = classificarConteudo({ reactionMessage: { key: { id: 'M5' }, text: '' } });
    expect(r.efeito).toEqual({ tipo: 'reagir', alvoWaId: 'M5', texto: '' });
  });

  it('protocolo sem alvo é ignorado em vez de virar linha', () => {
    expect(classificarConteudo({ protocolMessage: { type: 3 } }).ignorar).toBe(true);
  });
});

describe('classificarConteudo — tipos extras', () => {
  it('localização guarda coordenadas em conteudoExtra', () => {
    const r = classificarConteudo({
      locationMessage: { degreesLatitude: -26.8, degreesLongitude: -50.3, name: 'Fazenda' },
    });
    expect(r.tipo).toBe('localizacao');
    expect(r.texto).toBe('Fazenda');
    expect(r.conteudoExtra).toMatchObject({ latitude: -26.8, longitude: -50.3, aoVivo: false });
  });

  it('contato guarda o vCard', () => {
    const r = classificarConteudo({
      contactMessage: { displayName: 'João', vcard: 'BEGIN:VCARD...' },
    });
    expect(r).toMatchObject({ tipo: 'contato', texto: 'João' });
    expect((r.conteudoExtra as any).contatos[0].vcard).toContain('VCARD');
  });

  it('enquete guarda pergunta e opções', () => {
    const r = classificarConteudo({
      pollCreationMessageV3: { name: 'Qual dia?', options: [{ optionName: 'Seg' }, { optionName: 'Ter' }] },
    });
    expect(r).toMatchObject({ tipo: 'enquete', texto: 'Qual dia?' });
    expect((r.conteudoExtra as any).opcoes).toEqual(['Seg', 'Ter']);
  });

  it('resposta de botão vira texto com o rótulo clicado', () => {
    const r = classificarConteudo({ buttonsResponseMessage: { selectedDisplayText: 'Sim' } });
    expect(r).toMatchObject({ tipo: 'texto', texto: 'Sim' });
  });
});

describe('classificarConteudo — nada some em silêncio', () => {
  it('tipo inventado vira desconhecido com a chave preservada', () => {
    const r = classificarConteudo({ mensagemDoFuturoMessage: { algo: 1 } });
    expect(r.tipo).toBe('desconhecido');
    expect((r.conteudoExtra as any).chaves).toEqual(['mensagemDoFuturoMessage']);
    expect(r.ignorar).toBeFalsy();
  });

  it('só ruído de protocolo É ignorado — este é o único descarte legítimo', () => {
    expect(classificarConteudo({ senderKeyDistributionMessage: {} }).ignorar).toBe(true);
    expect(classificarConteudo({ messageContextInfo: {} }).ignorar).toBe(true);
  });

  it('entrada malformada não lança', () => {
    expect(() => classificarConteudo(null)).not.toThrow();
    expect(() => classificarConteudo(undefined)).not.toThrow();
    expect(() => classificarConteudo('texto solto' as unknown)).not.toThrow();
  });
});

describe('extensaoDe', () => {
  it('prefere a extensão do nome original', () => {
    expect(extensaoDe('application/octet-stream', 'contrato.docx')).toBe('docx');
  });
  it('cai no mapa de MIME', () => {
    expect(extensaoDe('image/jpeg')).toBe('jpg');
    expect(extensaoDe('audio/ogg; codecs=opus')).toBe('ogg');
  });
  it('MIME desconhecido vira sufixo ou bin', () => {
    expect(extensaoDe('application/vnd.coisa')).toBe('vndcoisa');
    expect(extensaoDe(undefined)).toBe('bin');
  });
});
