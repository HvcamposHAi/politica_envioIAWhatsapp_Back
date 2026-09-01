// Worker de disparo. Mocka banco e canal — não toca WhatsApp nem Postgres.
//
// O caso que mais importa aqui é o penúltimo: quem pediu descadastro
// DEPOIS de entrar na fila não recebe. O trigger do banco barra na entrada;
// entre a entrada e o envio existe uma janela, e é nela que o erro dói.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CANAL = 'canal-1';
const DISPARO = 'disparo-1';

interface Estado {
  disparos: Record<string, unknown>[];
  alvos: Record<string, unknown>[];
  clientes: Record<string, unknown>[];
  canal: { conexao_status: string; criado_em: string };
  conversas: Record<string, unknown>[];
  mensagens: Record<string, unknown>[];
  atualizacoes: Array<{ tabela: string; patch: Record<string, unknown>; id?: string }>;
}

let est: Estado;

/**
 * Mock do supabase-js. Um construtor de consulta THENABLE de verdade —
 * acumula filtros e só resolve no await. A primeira versão devolvia `this`
 * para tudo e resolvia em métodos escolhidos a dedo; quebrou em metade das
 * cadeias, porque cada consulta do disparador termina de um jeito
 * diferente (await direto, .maybeSingle(), .limit(), .single()).
 */
vi.mock('../db/client.server.js', () => {
  function fonteDe(tabela: string): Record<string, unknown>[] {
    if (tabela === 'disparos') return est.disparos;
    if (tabela === 'disparo_alvos') return est.alvos;
    if (tabela === 'clientes') return est.clientes;
    if (tabela === 'conversas') return est.conversas;
    if (tabela === 'mensagens') return est.mensagens;
    return [];
  }

  class Consulta {
    private filtros: Array<[string, string, unknown]> = [];
    private op: 'select' | 'update' | 'insert' = 'select';
    private patch: Record<string, unknown> | null = null;
    private linha: Record<string, unknown> | null = null;
    private contando = false;
    private teto: number | null = null;

    constructor(private tabela: string) {}

    select(_cols?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.count) this.contando = true;
      return this;
    }
    eq(k: string, v: unknown) {
      this.filtros.push(['eq', k, v]);
      return this;
    }
    neq(k: string, v: unknown) {
      this.filtros.push(['neq', k, v]);
      return this;
    }
    is(k: string, v: unknown) {
      this.filtros.push(['is', k, v]);
      return this;
    }
    gte() {
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.teto = n;
      return this;
    }
    update(patch: Record<string, unknown>) {
      this.op = 'update';
      this.patch = patch;
      return this;
    }
    insert(linha: Record<string, unknown>) {
      this.op = 'insert';
      this.linha = linha;
      return this;
    }

    private casadas(): Record<string, unknown>[] {
      const fonte = fonteDe(this.tabela);
      return fonte.filter((l) =>
        this.filtros.every(([tipo, k, v]) =>
          tipo === 'eq' ? l[k] === v : tipo === 'neq' ? l[k] !== v : l[k] === v,
        ),
      );
    }

    private executar(): { data: unknown; error: null; count?: number } {
      if (this.tabela === 'canais') {
        return { data: est.canal as unknown, error: null };
      }
      if (this.op === 'insert') {
        const nova = { ...this.linha, id: `${this.tabela}-${fonteDe(this.tabela).length + 1}` };
        fonteDe(this.tabela).push(nova);
        return { data: nova, error: null };
      }
      if (this.op === 'update') {
        const alvos = this.casadas();
        for (const l of alvos) Object.assign(l, this.patch);
        est.atualizacoes.push({ tabela: this.tabela, patch: this.patch ?? {} });
        return { data: alvos, error: null };
      }
      const linhas = this.casadas();
      if (this.contando) return { data: null, error: null, count: linhas.length };
      return { data: this.teto === null ? linhas : linhas.slice(0, this.teto), error: null };
    }

    maybeSingle() {
      const r = this.executar();
      const d = r.data;
      return Promise.resolve({ data: Array.isArray(d) ? (d[0] ?? null) : d, error: null });
    }
    single() {
      return this.maybeSingle();
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve()
        .then(() => this.executar())
        .then(res, rej);
    }
  }

  return { supabaseAdmin: { from: (t: string) => new Consulta(t) } };
});

/** A posse do gateway (jobs/lease.ts) barra tudo que toca em canal quando
 *  esta instância não é a dona. Aqui ela é controlável, para os testes
 *  exercitarem os dois lados. */
let temPosse = true;
vi.mock('./lease.js', () => ({
  souODonoDoGateway: () => temPosse,
}));

const enviarMock = vi.fn();
const digitandoMock = vi.fn();

vi.mock('../channels/registry.js', () => ({
  canalEmMemoria: () => ({
    enviar: enviarMock,
    sinalizarDigitando: digitandoMock,
  }),
  obterOuCriarCanal: async () => ({
    enviar: enviarMock,
    sinalizarDigitando: digitandoMock,
  }),
}));

const { passadaDoDisparador, limparAgendamentos, primeiroNome, pararTudo, religarDisparos } =
  await import('./disparador.js');

/** 12:00 BRT de um dia útil — dentro da janela padrão 09:00–20:00. */
const AGORA = new Date('2026-09-01T15:00:00Z');

function disparoBase(over: Record<string, unknown> = {}) {
  return {
    id: DISPARO,
    empresa_id: 'emp-1',
    canal_id: CANAL,
    status: 'enviando',
    pausado_em: null,
    texto_base: 'Oi {{primeiro_nome}}, aqui é da campanha. Responda SAIR para não receber mais.',
    janela_inicio: '09:00',
    janela_fim: '20:00',
    intervalo_min_seg: 25,
    intervalo_max_seg: 90,
    teto_diario: null,
    enviados_hoje: 0,
    contador_dia: '2026-09-01',
    amostra_aprovada_em: null,
    ...over,
  };
}

function clienteBase(over: Record<string, unknown> = {}) {
  return {
    id: 'cli-1',
    nome: 'MARIA DAS GRAÇAS SILVA',
    telefone: '5547999887766',
    bairro: 'Centro',
    cidade: 'Timbó',
    situacao: 'ativo',
    opt_out_em: null,
    wa_jid: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  temPosse = true;
  limparAgendamentos();
  religarDisparos();
  enviarMock.mockResolvedValue({ waMessageId: 'wa-1', status: 'enviada' });
  est = {
    disparos: [disparoBase()],
    alvos: [
      {
        id: 'alvo-1',
        disparo_id: DISPARO,
        telefone: '5547999887766',
        cliente_id: 'cli-1',
        texto_gerado: null,
        tentativas: 0,
        status: 'pendente',
      },
    ],
    clientes: [clienteBase()],
    canal: { conexao_status: 'conectado', criado_em: '2026-08-20T12:00:00Z' },
    conversas: [],
    mensagens: [],
    atualizacoes: [],
  };
});

describe('primeiroNome', () => {
  it('normaliza a caixa alta que planilha de campanha traz', () => {
    expect(primeiroNome('MARIA DAS GRAÇAS SILVA')).toBe('Maria');
    expect(primeiroNome('joão pedro')).toBe('João');
    expect(primeiroNome('  ANA  ')).toBe('Ana');
  });

  it('aguenta nome vazio', () => {
    expect(primeiroNome('')).toBe('');
    expect(primeiroNome('   ')).toBe('');
  });
});

describe('passadaDoDisparador', () => {
  it('envia uma mensagem com os campos substituídos', async () => {
    const r = await passadaDoDisparador(AGORA);
    expect(r.enviados).toBe(1);
    expect(enviarMock).toHaveBeenCalledTimes(1);
    expect(enviarMock.mock.calls[0][0].texto).toContain('Oi Maria,');
    expect(enviarMock.mock.calls[0][0].telefone).toBe('5547999887766');
  });

  it('mostra "digitando" antes de mandar', async () => {
    await passadaDoDisparador(AGORA);
    expect(digitandoMock).toHaveBeenCalledTimes(1);
    const [, duracao] = digitandoMock.mock.calls[0];
    expect(duracao).toBeGreaterThan(0);
  });

  it('grava a mensagem na conversa, para a resposta cair na Caixa', async () => {
    await passadaDoDisparador(AGORA);
    expect(est.conversas).toHaveLength(1);
    expect(est.mensagens).toHaveLength(1);
    expect(est.mensagens[0]).toMatchObject({ autor: 'atendente', direcao: 'saida' });
  });

  it('manda NO MÁXIMO uma por disparo por passada', async () => {
    est.alvos.push({ ...est.alvos[0], id: 'alvo-2', telefone: '5547988776655' });
    await passadaDoDisparador(AGORA);
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });

  it('respeita o intervalo: a segunda passada imediata não envia', async () => {
    await passadaDoDisparador(AGORA);
    est.alvos.push({ ...est.alvos[0], id: 'alvo-2', status: 'pendente' });
    enviarMock.mockClear();
    await passadaDoDisparador(new Date(AGORA.getTime() + 1_000));
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('não envia fora da janela horária', async () => {
    const madrugada = new Date('2026-09-01T06:00:00Z'); // 03:00 BRT
    const r = await passadaDoDisparador(madrugada);
    expect(r.enviados).toBe(0);
    expect(enviarMock).not.toHaveBeenCalled();
    expect(r.pulados.fora_da_janela).toBe(1);
  });

  it('pausa o disparo quando a linha cai, em vez de ficar em silêncio', async () => {
    est.canal = { ...est.canal, conexao_status: 'caido' };
    const r = await passadaDoDisparador(AGORA);
    expect(r.pausados).toBe(1);
    expect(enviarMock).not.toHaveBeenCalled();
    expect(est.disparos[0].pausado_em).toBeTruthy();
    expect(String(est.disparos[0].pausa_motivo)).toContain('linha de WhatsApp caiu');
  });

  it('não envia com o interruptor geral desligado', async () => {
    await pararTudo('teste');
    enviarMock.mockClear();
    const r = await passadaDoDisparador(AGORA);
    expect(r.enviados).toBe(0);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('NÃO ENVIA para quem pediu descadastro depois de entrar na fila', async () => {
    // O caso mais caro desta plataforma. O trigger do banco barra o alvo na
    // entrada; a pessoa pode responder "PARE" com a fila já andando.
    est.clientes = [clienteBase({ situacao: 'opt_out', opt_out_em: '2026-09-01T14:00:00Z' })];
    const r = await passadaDoDisparador(AGORA);
    expect(enviarMock).not.toHaveBeenCalled();
    expect(r.enviados).toBe(0);
    expect(est.alvos[0].status).toBe('cancelado');
  });

  it('também barra quem está bloqueado por base legal', async () => {
    est.clientes = [clienteBase({ situacao: 'bloqueado' })];
    await passadaDoDisparador(AGORA);
    expect(enviarMock).not.toHaveBeenCalled();
    expect(est.alvos[0].status).toBe('cancelado');
  });

  it('marca falha sem derrubar a passada quando o envio falha', async () => {
    enviarMock.mockResolvedValue({ waMessageId: '', status: 'falhou', erro: 'sem sessão' });
    const r = await passadaDoDisparador(AGORA);
    expect(r.enviados).toBe(0);
    expect(est.alvos[0].status).toBe('falhou');
    expect(est.alvos[0].erro).toBe('sem sessão');
  });

  it('usa texto_gerado quando a IA já personalizou (Fase 4)', async () => {
    est.alvos[0].texto_gerado = 'Texto que a IA escreveu para esta pessoa.';
    await passadaDoDisparador(AGORA);
    expect(enviarMock.mock.calls[0][0].texto).toBe('Texto que a IA escreveu para esta pessoa.');
  });

  it('não deixa o erro de um disparo parar os outros', async () => {
    est.disparos.push(disparoBase({ id: 'disparo-2', canal_id: null }));
    const r = await passadaDoDisparador(AGORA);
    expect(r.avaliados).toBe(2);
    expect(r.enviados).toBe(1);
  });

  it('nunca lança, mesmo com o banco fora', async () => {
    // Exceção que escape daqui vira unhandledRejection num timer, e este
    // processo segura todas as linhas de WhatsApp.
    est.disparos = null as unknown as Record<string, unknown>[];
    await expect(passadaDoDisparador(AGORA)).resolves.toBeDefined();
  });
});

describe('posse do gateway', () => {
  it('NÃO envia quando esta instância não é a dona', async () => {
    // Dois processos tirando alvos da mesma fila mandam a mesma mensagem
    // duas vezes para a mesma pessoa. O índice único do banco barra a
    // duplicata DEPOIS de a mensagem ter saído; esta guarda impede o envio.
    temPosse = false;
    const r = await passadaDoDisparador(AGORA);
    expect(r.enviados).toBe(0);
    expect(r.avaliados).toBe(0);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('envia normalmente quando a posse é desta instância', async () => {
    temPosse = true;
    const r = await passadaDoDisparador(AGORA);
    expect(r.enviados).toBe(1);
  });
});
