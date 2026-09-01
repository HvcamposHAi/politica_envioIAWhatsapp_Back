// Teste pontual (ver PLANO_CORRECAO_NOME_CONTATO.md §9.7): BaileysChannel
// repassa msg.pushName como EventoRecebido.nomeContato. Mocka o pacote
// @whiskeysockets/baileys inteiro (não abre socket real) e o auth state/db
// — mesmo padrão de twilio.adapter.test.ts (mocka o pacote 'twilio' inteiro).
//
// Quem decide se nomeContato é USADO (origem === 'cliente') é
// services/mensagens.ts, não este adapter — por isso os testes aqui cobrem
// só a CAPTURA (o adapter repassa o pushName sempre que existir), e o guard
// de segurança é coberto em mensagens.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;

const eventHandlers: Record<string, Handler> = {};
const socketMock = {
  ev: {
    on: vi.fn((evento: string, handler: Handler) => {
      eventHandlers[evento] = handler;
    }),
  },
  logout: vi.fn().mockResolvedValue(undefined),
  end: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue({ key: { id: 'WA_MSG_ENVIADA' } }),
  groupMetadata: vi.fn().mockResolvedValue({ subject: 'Grupo de Compras', participants: [] }),
  updateMediaMessage: vi.fn(),
};

/** Valor que hub.canais.receber_grupos devolve no fake — é o opt-in por linha
 *  que decide se mensagem de grupo entra no funil (migration 20260810120000). */
let receberGruposFake = false;

const makeWASocketMock = vi.fn(() => socketMock);
const fetchLatestBaileysVersionMock = vi.fn().mockResolvedValue({ version: [2, 3000, 0] });

vi.mock('@whiskeysockets/baileys', () => ({
  default: makeWASocketMock,
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: fetchLatestBaileysVersionMock,
}));

vi.mock('./auth-state.postgres.js', () => ({
  usePostgresAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
}));
const { usePostgresAuthState: usePostgresAuthStateMock } = await import('./auth-state.postgres.js');

/** Registra cada delete().eq() feito no fake, por tabela — usado pelo teste
 *  de autolimpeza de sessão morta (loggedOut). */
const delecoesRegistradas: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
/** Registra cada insert() por tabela — usado para conferir eventos_canal. */
const insercoesRegistradas: Array<{ tabela: string; dados: Record<string, unknown> }> = [];
/** Registra cada update().eq() por tabela — usado pelos testes de
 *  conexao_status, que são a trava contra a causa 1 das quedas periódicas
 *  (diagnóstico 2026-08-14). Sem isto o fake engolia o valor gravado e
 *  nenhum teste conseguia afirmar QUAL status foi para o banco. */
const atualizacoesRegistradas: Array<{ tabela: string; dados: Record<string, unknown> }> = [];

function tabelaFake(tabela: string) {
  return {
    insert: vi.fn((dados: Record<string, unknown>) => {
      insercoesRegistradas.push({ tabela, dados });
      return Promise.resolve({ error: null });
    }),
    update: vi.fn((dados: Record<string, unknown>) => ({
      eq: vi.fn(() => {
        atualizacoesRegistradas.push({ tabela, dados });
        return Promise.resolve({ error: null });
      }),
    })),
    delete: vi.fn(() => ({
      eq: vi.fn((coluna: string, valor: unknown) => {
        delecoesRegistradas.push({ tabela, coluna, valor });
        return Promise.resolve({ error: null });
      }),
    })),
    // Só hub.canais é lido por este adapter (services/grupos.ts, opt-in de
    // grupos). Antes desta adição o fake não tinha `select`, e o teste de
    // "grupo é ignorado" passava porque a leitura EXPLODIA — não porque o
    // opt-in funcionava.
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn().mockResolvedValue({
          data: tabela === 'canais' ? { receber_grupos: receberGruposFake } : null,
          error: null,
        }),
      })),
    })),
  };
}

vi.mock('../db/client.server.js', () => ({
  supabaseAdmin: { from: vi.fn((tabela: string) => tabelaFake(tabela)) },
}));

const { BaileysChannel, montarConteudoEnvio } = await import('./baileys.adapter.js');
const { invalidarCacheOptInGrupos } = await import('../services/grupos.js');

function msgFake(overrides: {
  remoteJid?: string;
  id?: string;
  fromMe?: boolean;
  texto?: string;
  pushName?: string | null;
  remoteJidAlt?: string;
}) {
  return {
    key: {
      remoteJid: overrides.remoteJid ?? '5541999998888@s.whatsapp.net',
      id: overrides.id ?? 'WA_MSG_1',
      fromMe: overrides.fromMe ?? false,
      remoteJidAlt: overrides.remoteJidAlt,
    },
    message: { conversation: overrides.texto ?? 'oi' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: overrides.pushName,
  };
}

describe('BaileysChannel — captura de nomeContato via pushName', () => {
  const receiverHandler = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    receiverHandler.mockClear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];

    const canal = new BaileysChannel('canal-1');
    canal.aoReceber(receiverHandler);
    await canal.conectar();
  });

  it('mensagem de cliente com pushName -> nomeContato preenchido, origem cliente', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [msgFake({ fromMe: false, pushName: '  Maria Silva  ' })],
    });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        telefone: '5541999998888',
        origem: 'cliente',
        nomeContato: 'Maria Silva', // aparado
      }),
    );
  });

  it('mensagem sem pushName (ausente) -> nomeContato undefined, sem quebrar', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [msgFake({ fromMe: false, pushName: undefined })],
    });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({ telefone: '5541999998888', nomeContato: undefined }),
    );
  });

  it('eco fromMe (atendente) também carrega o pushName recebido — o adapter não filtra por origem, quem filtra é services/mensagens.ts', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [msgFake({ fromMe: true, pushName: 'Agro Timbó Vendas' })],
    });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({ origem: 'atendente', nomeContato: 'Agro Timbó Vendas' }),
    );
  });

  it('type !== "notify" -> ignora o lote inteiro, receiverHandler não é chamado', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'append',
      messages: [msgFake({ pushName: 'Não Deveria Chegar' })],
    });

    expect(receiverHandler).not.toHaveBeenCalled();
  });

  it('grupo (@g.us), status (@broadcast) e newsletter -> ignorados; só conversa individual entra no funil', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [
        msgFake({ remoteJid: '120363151865597914@g.us' }),
        msgFake({ remoteJid: '554191081996-1626536151@g.us' }),
        msgFake({ remoteJid: 'status@broadcast' }),
        msgFake({ remoteJid: '120363023456789012@newsletter' }),
        msgFake({ remoteJid: '5541999998888@s.whatsapp.net', texto: 'individual passa' }),
      ],
    });

    expect(receiverHandler).toHaveBeenCalledTimes(1);
    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({ telefone: '5541999998888', texto: 'individual passa' }),
    );
  });
});

// PLANO_MENSAGENS_INTEGRA_WHATSAPP.md — grupos (fase 4) e mídia (fase 1).
describe('BaileysChannel — grupos (opt-in por linha)', () => {
  const receiverHandler = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    receiverHandler.mockClear();
    socketMock.groupMetadata.mockClear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    // O opt-in é cacheado por 60s no serviço; sem limpar, um teste herdaria a
    // decisão do anterior.
    invalidarCacheOptInGrupos();

    const canal = new BaileysChannel('canal-grupos');
    canal.aoReceber(receiverHandler);
    await canal.conectar();
  });

  it('receber_grupos = false (default) -> mensagem de grupo NÃO entra', async () => {
    receberGruposFake = false;
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [msgFake({ remoteJid: '120363151865597914@g.us', texto: 'oi do grupo' })],
    });
    expect(receiverHandler).not.toHaveBeenCalled();
  });

  it('receber_grupos = true -> entra marcada como grupo, com quem falou', async () => {
    receberGruposFake = true;
    const msg = msgFake({ remoteJid: '120363151865597914@g.us', texto: 'oi do grupo' });
    // participante = quem escreveu DENTRO do grupo; pushName é o nome dele,
    // não o do grupo.
    (msg.key as Record<string, unknown>).participant = '5541988887777@s.whatsapp.net';
    msg.pushName = 'Marcelo';

    await eventHandlers['messages.upsert']!({ type: 'notify', messages: [msg] });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        ehGrupo: true,
        // "telefone" de um grupo é o ID do JID — nunca um número de gente.
        telefone: '120363151865597914',
        autorWaJid: '5541988887777@s.whatsapp.net',
        autorNome: 'Marcelo',
        // Quem NOMEIA a conversa é o assunto do grupo, não quem falou.
        nomeGrupo: 'Grupo de Compras',
        nomeContato: 'Grupo de Compras',
        waJidOrigem: '120363151865597914@g.us',
      }),
    );
  });

  it('broadcast e newsletter continuam fora mesmo com grupos ligados', async () => {
    receberGruposFake = true;
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [
        msgFake({ remoteJid: 'status@broadcast' }),
        msgFake({ remoteJid: '120363023456789012@newsletter' }),
      ],
    });
    expect(receiverHandler).not.toHaveBeenCalled();
  });
});

describe('BaileysChannel — mídia recebida', () => {
  const receiverHandler = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    receiverHandler.mockClear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    const canal = new BaileysChannel('canal-midia');
    canal.aoReceber(receiverHandler);
    await canal.conectar();
  });

  it('imagem com legenda vira UMA mensagem, com descritor e referência de download', async () => {
    const msg = msgFake({ texto: 'ignorado' });
    msg.message = {
      imageMessage: {
        mimetype: 'image/jpeg',
        caption: 'olha o milho',
        fileLength: 4096,
        url: 'https://mmg.whatsapp.net/x',
        directPath: '/v/t62',
        mediaKey: Buffer.from('chave'),
      },
    } as never;

    await eventHandlers['messages.upsert']!({ type: 'notify', messages: [msg] });

    expect(receiverHandler).toHaveBeenCalledTimes(1);
    const evento = receiverHandler.mock.calls[0][0] as Record<string, unknown>;
    expect(evento.tipo).toBe('imagem');
    expect(evento.texto).toBe('olha o milho');
    // A referência de download vai junto: é ela que a fila persiste em
    // midia_ref para sobreviver a um restart do Cloud Run.
    expect((evento.midia as { ref: { directPath: string } }).ref.directPath).toBe('/v/t62');
    expect(typeof evento.reobterRefMidia).toBe('function');
  });

  it('mensagem de tipo desconhecido NÃO some — entra como desconhecido', async () => {
    const msg = msgFake({});
    msg.message = { mensagemDoFuturoMessage: { algo: 1 } } as never;

    await eventHandlers['messages.upsert']!({ type: 'notify', messages: [msg] });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({ tipo: 'desconhecido' }),
    );
  });

  it('ruído de protocolo é o ÚNICO descarte silencioso', async () => {
    const msg = msgFake({});
    msg.message = { senderKeyDistributionMessage: {} } as never;

    await eventHandlers['messages.upsert']!({ type: 'notify', messages: [msg] });

    expect(receiverHandler).not.toHaveBeenCalled();
  });

  it('uma mensagem malformada não impede as seguintes de chegar', async () => {
    const ruim = { key: null } as never;
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [ruim, msgFake({ texto: 'a segunda passa' })],
    });

    expect(receiverHandler).toHaveBeenCalledTimes(1);
    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({ texto: 'a segunda passa' }),
    );
  });
});

describe('montarConteudoEnvio — cada mídia vira o stanza certo', () => {
  const base = { conversaId: 'c1', telefone: '5541999998888' };

  it('sem mídia continua sendo texto puro (não-regressão)', () => {
    expect(montarConteudoEnvio({ ...base, texto: 'oi' })).toEqual({ text: 'oi' });
  });

  it('imagem leva a legenda junto, não numa segunda mensagem', () => {
    const r = montarConteudoEnvio({
      ...base,
      texto: 'segue a foto',
      midiaBuffer: Buffer.from('x'),
      midiaClasse: 'imagem',
      midiaTipo: 'image/jpeg',
    });
    expect(r).toMatchObject({ mimetype: 'image/jpeg', caption: 'segue a foto' });
    expect(r.image).toBeDefined();
  });

  it('nota de voz sai como ptt em opus/ogg — é o que faz o WhatsApp mostrar a onda', () => {
    const r = montarConteudoEnvio({
      ...base,
      midiaBuffer: Buffer.from('x'),
      midiaClasse: 'voz',
      midiaTipo: 'audio/ogg',
      midiaDuracaoSeg: 12,
    });
    expect(r).toMatchObject({ ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 12 });
  });

  it('áudio anexado NÃO é ptt', () => {
    const r = montarConteudoEnvio({
      ...base,
      midiaBuffer: Buffer.from('x'),
      midiaClasse: 'audio',
      midiaTipo: 'audio/mpeg',
    });
    expect(r.ptt).toBe(false);
  });

  it('documento preserva o nome que o cliente vai ver', () => {
    const r = montarConteudoEnvio({
      ...base,
      midiaBuffer: Buffer.from('x'),
      midiaClasse: 'documento',
      midiaTipo: 'application/pdf',
      midiaNome: 'nota-fiscal.pdf',
    });
    expect(r).toMatchObject({ fileName: 'nota-fiscal.pdf', mimetype: 'application/pdf' });
  });
});

describe('BaileysChannel — guarda de envio para grupo', () => {
  let canal: InstanceType<typeof BaileysChannel>;

  beforeEach(async () => {
    socketMock.sendMessage.mockClear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
    canal = new BaileysChannel('canal-1');
    await canal.conectar();
  });

  it('grupo SEM wa_jid salvo é recusado — nunca reconstruir o JID por dígitos', async () => {
    // Sem a guarda, isto viraria "120363151865597914@s.whatsapp.net" e o
    // WhatsApp entregaria a resposta do grupo em PARTICULAR para uma pessoa
    // só — o cliente errado recebendo o que não era para ele.
    const r = await canal.enviar({
      conversaId: 'c1',
      telefone: '120363151865597914',
      texto: 'resposta do grupo',
    });

    expect(r.status).toBe('falhou');
    expect(r.erro).toMatch(/grupo/i);
    expect(socketMock.sendMessage).not.toHaveBeenCalled();
  });

  it('grupo COM wa_jid salvo envia para o JID do grupo', async () => {
    const r = await canal.enviar({
      conversaId: 'c1',
      telefone: '120363151865597914',
      waJidDestino: '120363151865597914@g.us',
      texto: 'resposta do grupo',
    });

    expect(r.status).toBe('enviada');
    expect(socketMock.sendMessage).toHaveBeenCalledWith('120363151865597914@g.us', {
      text: 'resposta do grupo',
    });
  });
});

// PLANO_CORRECAO_IDENTIFICACAO_LID_WHATSAPP.md §9 — captura de telefone
// real (remoteJidAlt) para contatos roteados por "@lid", e roteamento de envio
// pelo JID técnico em vez de reconstruir por dígitos.
describe('BaileysChannel — contatos @lid (PLANO_CORRECAO_IDENTIFICACAO_LID_WHATSAPP)', () => {
  const receiverHandler = vi.fn().mockResolvedValue(undefined);
  let canal: InstanceType<typeof BaileysChannel>;

  beforeEach(async () => {
    receiverHandler.mockClear();
    socketMock.sendMessage.mockClear();
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];

    canal = new BaileysChannel('canal-1');
    canal.aoReceber(receiverHandler);
    await canal.conectar();
  });

  it('remoteJid @lid com remoteJidAlt presente -> telefone é o número real, não o ID do lid', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [
        msgFake({
          remoteJid: '120363190542165600@lid',
          remoteJidAlt: '5541999998888@s.whatsapp.net',
        }),
      ],
    });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        telefone: '5541999998888',
        waJidOrigem: '120363190542165600@lid',
      }),
    );
  });

  it('remoteJid @lid sem remoteJidAlt -> cai no fallback (ID cru), sem quebrar (não regressão)', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [msgFake({ remoteJid: '120363190542165600@lid', remoteJidAlt: undefined })],
    });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        telefone: '120363190542165600',
        waJidOrigem: '120363190542165600@lid',
      }),
    );
  });

  it('remoteJid normal (@s.whatsapp.net) -> waJidOrigem preenchido, telefone igual a antes (não lê remoteJidAlt)', async () => {
    await eventHandlers['messages.upsert']!({
      type: 'notify',
      messages: [msgFake({ remoteJid: '5541999998888@s.whatsapp.net' })],
    });

    expect(receiverHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        telefone: '5541999998888',
        waJidOrigem: '5541999998888@s.whatsapp.net',
      }),
    );
  });

  it('enviar() com waJidDestino -> manda para o JID exato, não reconstrói por dígitos', async () => {
    await canal.enviar({
      conversaId: 'conversa-1',
      telefone: '120363190542165600', // ID cru — se fosse usado, o envio iria para o lugar errado
      waJidDestino: '120363190542165600@lid',
      texto: 'oi',
    });

    expect(socketMock.sendMessage).toHaveBeenCalledWith('120363190542165600@lid', { text: 'oi' });
  });

  it('enviar() sem waJidDestino -> mantém o comportamento atual (reconstrução por dígitos)', async () => {
    await canal.enviar({ conversaId: 'conversa-1', telefone: '(41) 99999-8888', texto: 'oi' });

    expect(socketMock.sendMessage).toHaveBeenCalledWith('41999998888@s.whatsapp.net', { text: 'oi' });
  });
});

// PLANO_CORRECAO_CONEXAO_QR_BAILEYS.md §9 — guarda de idempotência em
// conectar(): duas chamadas concorrentes não podem abrir dois sockets para
// a mesma linha (causa raiz do "Connection Closed"/428 do WhatsApp que
// travava o QR).
describe('BaileysChannel.conectar() — guarda de idempotência (PLANO_CORRECAO_CONEXAO_QR_BAILEYS)', () => {
  beforeEach(() => {
    makeWASocketMock.mockClear();
  });

  it('duas chamadas em sequência enquanto "conectando" -> makeWASocket só é chamado uma vez', async () => {
    const canal = new BaileysChannel('canal-idem-1');
    canal.aoReceber(vi.fn().mockResolvedValue(undefined));

    await canal.conectar();
    await canal.conectar();

    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('conectar() depois de desconectar() -> abre um socket novo normalmente', async () => {
    const canal = new BaileysChannel('canal-idem-2');
    canal.aoReceber(vi.fn().mockResolvedValue(undefined));

    await canal.conectar();
    await canal.desconectar();
    await canal.conectar();

    expect(makeWASocketMock).toHaveBeenCalledTimes(2);
  });

  it('segunda chamada com status "conectado" (connection.update open) -> também é ignorada', async () => {
    const canal = new BaileysChannel('canal-idem-3');
    canal.aoReceber(vi.fn().mockResolvedValue(undefined));

    await canal.conectar();
    await eventHandlers['connection.update']!({ connection: 'open' });
    await canal.conectar();

    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('primeira chamada num canal novo -> abre o socket normalmente', async () => {
    const canal = new BaileysChannel('canal-idem-4');
    canal.aoReceber(vi.fn().mockResolvedValue(undefined));

    await canal.conectar();

    expect(makeWASocketMock).toHaveBeenCalledTimes(1);
  });

  it('fetchLatestBaileysVersion travado (nunca resolve) -> conectar() segue após o timeout interno, com a versão embutida do pacote', async () => {
    vi.useFakeTimers();
    try {
      fetchLatestBaileysVersionMock.mockImplementationOnce(() => new Promise(() => undefined));
      const canal = new BaileysChannel('canal-idem-5');
      canal.aoReceber(vi.fn().mockResolvedValue(undefined));

      const promessa = canal.conectar();
      await vi.advanceTimersByTimeAsync(8_100);
      await promessa;

      expect(makeWASocketMock).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      fetchLatestBaileysVersionMock.mockResolvedValue({ version: [2, 3000, 0] });
    }
  });

  it('tentativa presa em "conectando" há mais de 90s (socket zumbi) -> nova chamada derruba a velha e assume', async () => {
    vi.useFakeTimers();
    socketMock.end.mockClear();
    try {
      vi.setSystemTime(new Date('2026-08-07T20:00:00Z'));
      const canal = new BaileysChannel('canal-idem-6');
      canal.aoReceber(vi.fn().mockResolvedValue(undefined));

      await canal.conectar();
      expect(makeWASocketMock).toHaveBeenCalledTimes(1);

      // dentro da janela: no-op (guarda protege)
      vi.setSystemTime(new Date('2026-08-07T20:01:00Z')); // +60s
      await canal.conectar();
      expect(makeWASocketMock).toHaveBeenCalledTimes(1);

      // além da janela: derruba o zumbi e abre socket novo
      vi.setSystemTime(new Date('2026-08-07T20:02:00Z')); // +120s
      await canal.conectar();
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);
      expect(socketMock.end).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Incidente 2026-08-07 (parte final): pareamento interrompido por crash no
// meio da gravação deixou credenciais meio-pareadas em hub.canal_sessoes
// (`me` preenchido, registered=false). Todo conectar() seguinte carregava a
// credencial morta, tentava retomar a sessão em vez de gerar QR, levava 401
// loggedOut do WhatsApp — e o canal ficava preso para sempre, sem QR, até
// limpeza manual por SQL. Estes testes travam a autocura: 401 apaga a
// sessão morta e emite um evento 'erro' que o modal já sabe exibir.
describe('BaileysChannel — sessão morta (loggedOut) limpa hub.canal_sessoes sozinha', () => {
  beforeEach(async () => {
    delecoesRegistradas.length = 0;
    insercoesRegistradas.length = 0;
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
  });

  it('close com 401 loggedOut -> apaga a linha de canal_sessoes e emite evento "erro" para o modal', async () => {
    const canal = new BaileysChannel('canal-logout-1');
    canal.aoReceber(vi.fn().mockResolvedValue(undefined));
    await canal.conectar();

    await eventHandlers['connection.update']!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    expect(delecoesRegistradas).toContainEqual({
      tabela: 'canal_sessoes',
      coluna: 'canal_id',
      valor: 'canal-logout-1',
    });
    const eventosErro = insercoesRegistradas.filter(
      (i) => i.tabela === 'eventos_canal' && (i.dados as { tipo?: string }).tipo === 'erro',
    );
    expect(eventosErro).toHaveLength(1);
  });

  it('close com motivo != loggedOut (ex. 515 restartRequired do pareamento) -> NÃO apaga a sessão', async () => {
    vi.useFakeTimers(); // captura o setTimeout do backoff sem deixá-lo disparar
    try {
      const canal = new BaileysChannel('canal-logout-2');
      canal.aoReceber(vi.fn().mockResolvedValue(undefined));
      await canal.conectar();

      await eventHandlers['connection.update']!({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 515 } } },
      });

      expect(delecoesRegistradas).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Incidente 2026-08-07 ("mensagens recebidas não aparecem"): desconectar()
// chamava socket.logout() SEMPRE, inclusive no shutdown gracioso do
// processo (SIGTERM a cada deploy) — um logout de protocolo de verdade,
// que desvincula o aparelho no WhatsApp. Estes testes travam a distinção
// que corrige isso: só a ação explícita do usuário desvincula; o processo
// saindo só fecha o socket local, preservando a sessão para reconectar
// sozinho no próximo boot (registry.ts:reconectarCanaisAoSubir).
describe('BaileysChannel.desconectar() — logout real vs. fechamento local (incidente 2026-08-07)', () => {
  let canal: InstanceType<typeof BaileysChannel>;

  beforeEach(async () => {
    socketMock.logout.mockClear();
    socketMock.end.mockClear();
    atualizacoesRegistradas.length = 0;
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];

    canal = new BaileysChannel('canal-1');
    canal.aoReceber(vi.fn().mockResolvedValue(undefined));
    await canal.conectar();
    atualizacoesRegistradas.length = 0; // ignora o 'conectando' do conectar()
  });

  it('sem opções -> logout() de protocolo de verdade (ação explícita do usuário)', async () => {
    await canal.desconectar();

    expect(socketMock.logout).toHaveBeenCalledTimes(1);
    expect(socketMock.end).not.toHaveBeenCalled();
  });

  it('preservarSessao: true -> fecha local (end()), NÃO desvincula o aparelho (shutdown do processo)', async () => {
    await canal.desconectar({ preservarSessao: true });

    expect(socketMock.end).toHaveBeenCalledWith(undefined);
    expect(socketMock.logout).not.toHaveBeenCalled();
  });

  it('sem socket ativo -> não lança e não chama nem logout() nem end()', async () => {
    const semSocket = new BaileysChannel('canal-2');

    await expect(semSocket.desconectar({ preservarSessao: true })).resolves.toBeUndefined();
    expect(socketMock.logout).not.toHaveBeenCalled();
    expect(socketMock.end).not.toHaveBeenCalled();
  });

  // T1 — a trava mais importante do arquivo (diagnóstico 2026-08-14, causa 1).
  //
  // Este ramo existe para PRESERVAR a sessão, mas gravava 'desconectado' no
  // banco. Como reconectarCanaisAoSubir() só reconecta o que o banco diz ser
  // recuperável, toda saída limpa do processo apagava a própria condição que
  // faria o boot seguinte reconectar — e a linha caía sozinha a cada
  // SIGTERM do Cloud Run (escala a zero, reciclagem de instância,
  // manutenção; não só deploy) sem nunca mais voltar.
  it('preservarSessao: true -> grava "instavel" no banco, NUNCA "desconectado"', async () => {
    await canal.desconectar({ preservarSessao: true });

    const statusGravados = atualizacoesRegistradas
      .filter((a) => a.tabela === 'canais')
      .map((a) => a.dados.conexao_status);

    expect(statusGravados).toContain('instavel');
    expect(statusGravados).not.toContain('desconectado');
    expect(await canal.status()).toBe('instavel');
  });

  it('sem opções (logout do usuário) -> grava "desconectado", que aí é a verdade', async () => {
    await canal.desconectar();

    const statusGravados = atualizacoesRegistradas
      .filter((a) => a.tabela === 'canais')
      .map((a) => a.dados.conexao_status);

    expect(statusGravados).toContain('desconectado');
    expect(await canal.status()).toBe('desconectado');
  });
});

// T3 — segunda causa-raiz das quedas periódicas (diagnóstico 2026-08-14).
//
// `encerrandoIntencionalmente` tinha UMA única escrita (true, em
// desconectar()) e nunca voltava a false. Como o objeto continua no Map do
// registry, bastava UM clique em "Desligar linha" para aquela linha perder o
// auto-reconnect pelo resto da vida do processo: ela reparava por QR,
// funcionava, e na primeira queda de rede ia para 'instavel' e ficava lá.
// O backoff e o teto de registro estavam os dois sob a mesma guarda.
describe('BaileysChannel — auto-reconnect sobrevive a um desligamento manual', () => {
  beforeEach(() => {
    makeWASocketMock.mockClear();
    insercoesRegistradas.length = 0;
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
  });

  it('desconectar() -> conectar() -> queda de rede: reconexão volta a ser agendada', async () => {
    vi.useFakeTimers();
    // linha pareada: sem isto o teto de registro entraria no caminho e
    // mascararia o que este teste quer provar
    vi.mocked(usePostgresAuthStateMock).mockResolvedValue({
      state: { creds: { me: { id: '554733820505:1@s.whatsapp.net' } } },
      saveCreds: vi.fn(),
    } as never);
    try {
      const canal = new BaileysChannel('canal-religado-1');
      canal.aoReceber(vi.fn().mockResolvedValue(undefined));
      await canal.conectar();

      await canal.desconectar(); // o clique em "Desligar linha"
      await canal.conectar(); // religado por QR
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);

      // queda de rede qualquer (não é logout)
      await eventHandlers['connection.update']!({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      });

      // antes da correção o backoff nunca era agendado aqui: o flag ficava
      // grudado em true e o socket nunca mais reabria
      await vi.advanceTimersByTimeAsync(120_000);
      expect(makeWASocketMock.mock.calls.length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
      vi.mocked(usePostgresAuthStateMock).mockResolvedValue({ state: {}, saveCreds: vi.fn() } as never);
    }
  });
});

// Incidente 2 do PLANO_CORRECAO_PAREAMENTO_BAILEYS.md: retry infinito de
// REGISTRO (canal não pareado) alimentava a limitação anti-abuso do
// WhatsApp ("Connection Terminated" antes de qualquer QR). O teto para de
// tentar sozinho após MAXIMO_CICLOS_REGISTRO fechamentos consecutivos sem
// pareamento; canal já pareado nunca é limitado.
describe('BaileysChannel — teto de ciclos de registro (canal não pareado)', () => {
  const fecharCiclo = () =>
    eventHandlers['connection.update']!({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });

  beforeEach(() => {
    makeWASocketMock.mockClear();
    delecoesRegistradas.length = 0;
    insercoesRegistradas.length = 0;
    for (const k of Object.keys(eventHandlers)) delete eventHandlers[k];
  });

  it('3 fechamentos seguidos sem pareamento -> para de reconectar, status desconectado, evento "erro"', async () => {
    vi.useFakeTimers();
    try {
      const canal = new BaileysChannel('canal-teto-1');
      canal.aoReceber(vi.fn().mockResolvedValue(undefined));
      await canal.conectar();

      await fecharCiclo();
      await fecharCiclo();
      await fecharCiclo();

      const eventosErro = insercoesRegistradas.filter(
        (i) => i.tabela === 'eventos_canal' && (i.dados as { tipo?: string }).tipo === 'erro',
      );
      expect(eventosErro).toHaveLength(1);
      expect(await canal.status()).toBe('desconectado');
      // nada agendado deve reabrir socket: mesmo passando o tempo todo do
      // backoff, makeWASocket continua só com a chamada inicial
      await vi.advanceTimersByTimeAsync(120_000);
      expect(makeWASocketMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('canal JÁ pareado (creds.registered) nunca é limitado — reconexão continua após 3+ quedas', async () => {
    vi.useFakeTimers();
    vi.mocked(usePostgresAuthStateMock).mockResolvedValue({
      // "pareado" = creds.me preenchido (registered fica false na 7.x
      // mesmo com a linha logada — confirmado em produção)
      state: { creds: { me: { id: '554196247863:89@s.whatsapp.net' } } },
      saveCreds: vi.fn(),
    } as never);
    try {
      const canal = new BaileysChannel('canal-teto-2');
      canal.aoReceber(vi.fn().mockResolvedValue(undefined));
      await canal.conectar();

      await fecharCiclo();
      await fecharCiclo();
      await fecharCiclo();
      await fecharCiclo();

      const eventosErro = insercoesRegistradas.filter(
        (i) => i.tabela === 'eventos_canal' && (i.dados as { tipo?: string }).tipo === 'erro',
      );
      expect(eventosErro).toHaveLength(0); // teto nunca disparou
      // cada queda agendou reconexão por backoff — avançar o relógio reabre
      await vi.advanceTimersByTimeAsync(120_000);
      expect(makeWASocketMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
      vi.mocked(usePostgresAuthStateMock).mockResolvedValue({ state: {}, saveCreds: vi.fn() } as never);
    }
  });

  it('conectar() manual depois do teto estourado -> orçamento zera e o ciclo recomeça', async () => {
    vi.useFakeTimers();
    try {
      const canal = new BaileysChannel('canal-teto-3');
      canal.aoReceber(vi.fn().mockResolvedValue(undefined));
      await canal.conectar();
      await fecharCiclo();
      await fecharCiclo();
      await fecharCiclo(); // teto: status 'desconectado'

      await canal.conectar(); // clique manual
      expect(makeWASocketMock).toHaveBeenCalledTimes(2);

      // uma queda nova NÃO estoura o teto de cara (contador foi zerado)
      await fecharCiclo();
      const eventosErro = insercoesRegistradas.filter(
        (i) => i.tabela === 'eventos_canal' && (i.dados as { tipo?: string }).tipo === 'erro',
      );
      expect(eventosErro).toHaveLength(1); // só o do teto anterior
    } finally {
      vi.useRealTimers();
    }
  });
});
