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
  canal: { conexao_status: string; criado_em: string; ultima_conexao?: string | null };
  /** O interruptor de envio passou a viver no banco, por empresa
   *  (hub.empresas.disparo_ativo) — antes era variável de processo, e todo
   *  restart o devolvia ao default sem a tela perceber (D-13). */
  empresa: { id: string; disparo_ativo: boolean };
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
    if (tabela === 'empresas') return [est.empresa as unknown as Record<string, unknown>];
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
    in(k: string, v: unknown[]) {
      this.filtros.push(['in', k, v]);
      return this;
    }
    not(k: string, _op: string, v: unknown) {
      this.filtros.push(['not', k, v]);
      return this;
    }
    lt() {
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

      // Filtro de tabela embutida (`empresas!inner(...)` + `.eq('empresas.
      // disparo_ativo', true)`). É como o worker passou a consultar o
      // interruptor de envio: campanha de empresa desligada nem é lida.
      // Quando o filtro não bate, NENHUMA linha volta — que é justamente o
      // efeito do inner join no PostgREST.
      const embutidos = this.filtros.filter(([, k]) => k.includes('.'));
      for (const [, k, v] of embutidos) {
        const campo = k.split('.')[1];
        if ((est.empresa as Record<string, unknown>)[campo] !== v) return [];
      }

      return fonte.filter((l) =>
        this.filtros
          .filter(([, k]) => !k.includes('.'))
          .every(([tipo, k, v]) => {
            if (tipo === 'eq') return l[k] === v;
            if (tipo === 'neq') return l[k] !== v;
            if (tipo === 'in') return (v as unknown[]).includes(l[k]);
            if (tipo === 'not') return l[k] !== v;
            return l[k] === v;
          }),
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

  /**
   * As RPCs de fila. `reservar_proximo_alvo` substituiu o
   * `select limit 1` + `update` que deixava uma janela entre ler o alvo e
   * marcá-lo (D-11) — aqui o mock reproduz o contrato que importa: tira UM
   * alvo de 'pendente', já devolvendo ele marcado.
   */
  function rpc(nome: string, args: Record<string, unknown>) {
    if (nome === 'reservar_proximo_alvo') {
      const alvo = est.alvos.find(
        (a) => a.disparo_id === args.p_disparo_id && a.status === 'pendente',
      );
      if (!alvo) return Promise.resolve({ data: [], error: null });
      alvo.status = 'enviando_agora';
      alvo.reservado_em = new Date().toISOString();
      return Promise.resolve({ data: [alvo], error: null });
    }
    if (nome === 'liberar_alvos_travados') {
      return Promise.resolve({ data: 0, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  return { supabaseAdmin: { from: (t: string) => new Consulta(t), rpc } };
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
/** Pré-voo (onWhatsApp). Por padrão todo mundo TEM WhatsApp — os testes que
 *  exercitam o contrário sobrescrevem. */
const verificarMock = vi.fn();
/** Aquecimento da linha (estágio 2). Por padrão aquecida. */
let linhaAquecida = true;

function canalFalso() {
  return {
    enviar: enviarMock,
    sinalizarDigitando: digitandoMock,
    verificarNoWhatsApp: verificarMock,
    prontoParaCampanha: () => linhaAquecida,
  };
}

vi.mock('../channels/registry.js', () => ({
  canalEmMemoria: () => canalFalso(),
  obterOuCriarCanal: async () => canalFalso(),
}));

/** Marcação de entrega incerta é varredura de manutenção — roda por tempo,
 *  não por passada, e não interessa a nenhum caso aqui. */
vi.mock('../services/ackEntrega.js', () => ({
  marcarEntregasIncertas: async () => 0,
}));

const { passadaDoDisparador, limparAgendamentos, primeiroNome, pararTudo, religarDisparos } =
  await import('./disparador.js');

const EMPRESA = 'emp-1';

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
  linhaAquecida = true;
  limparAgendamentos();
  enviarMock.mockResolvedValue({ waMessageId: 'wa-1', status: 'enviada' });
  // Pré-voo devolve o JID canônico. Devolver um JID DIFERENTE do telefone
  // é de propósito: é o caso do nono dígito, que é a razão inteira de o
  // estágio 1 existir (D-03).
  verificarMock.mockImplementation(async (telefones: string[]) => {
    const mapa = new Map<string, string | null>();
    for (const t of telefones) mapa.set(t.replace(/\D/g, ''), `${t}@s.whatsapp.net`);
    return mapa;
  });
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
    canal: {
      conexao_status: 'conectado',
      criado_em: '2026-08-20T12:00:00Z',
      ultima_conexao: '2026-08-20T12:00:00Z',
    },
    empresa: { id: EMPRESA, disparo_ativo: true },
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

  it('não envia com o interruptor da empresa desligado', async () => {
    await pararTudo(EMPRESA, 'teste');
    enviarMock.mockClear();
    const r = await passadaDoDisparador(AGORA);
    expect(r.enviados).toBe(0);
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('"parar tudo" sobrevive a restart: o estado fica no banco, não em memória', async () => {
    // D-13. Antes disto o interruptor era variável de processo, e todo
    // deploy o devolvia ao default do ambiente — "Parar tudo" clicado às
    // 18h não valia mais às 19h, sem ninguém perceber.
    await pararTudo(EMPRESA, 'teste');
    expect(est.empresa.disparo_ativo).toBe(false);
    await religarDisparos(EMPRESA);
    expect(est.empresa.disparo_ativo).toBe(true);
  });

  it('"parar tudo" marca o código de pausa, para nada retomar sozinho', async () => {
    await pararTudo(EMPRESA, 'teste');
    expect(est.disparos[0].pausa_codigo).toBe('parada_geral');
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

/* =====================================================================
 * Regressões do dossiê de 10/09/2026
 *
 * Cada caso aqui fixa um defeito que já custou uma campanha inteira sem
 * envio nenhum. Eles não testam funcionalidade nova: testam que a falha
 * antiga não volta.
 * ===================================================================== */

describe('D-03 · identidade do destinatário (pré-voo)', () => {
  it('NÃO envia para número que não está no WhatsApp — marca sem_whatsapp', async () => {
    // O defeito original em uma frase: sendMessage() para um JID que não
    // existe NÃO FALHA. O Baileys devolve um key.id, gravávamos "enviada",
    // e a mensagem ia para lugar nenhum. A campanha reportava sucesso com
    // zero entregas.
    verificarMock.mockResolvedValue(new Map([['5547999887766', null]]));

    const r = await passadaDoDisparador(AGORA);

    expect(enviarMock).not.toHaveBeenCalled();
    expect(r.enviados).toBe(0);
    expect(est.alvos[0].status).toBe('sem_whatsapp');
  });

  it('envia para o JID CANÔNICO, não para o telefone reconstruído', async () => {
    // O nono dígito: o número consultado e o JID registrado podem diferir.
    // Reconstruir "${telefone}@s.whatsapp.net" acerta por sorte.
    verificarMock.mockResolvedValue(new Map([['5547999887766', '554799887766@s.whatsapp.net']]));

    await passadaDoDisparador(AGORA);

    expect(enviarMock).toHaveBeenCalledTimes(1);
    expect(enviarMock.mock.calls[0][0].waJidDestino).toBe('554799887766@s.whatsapp.net');
  });

  it('grava o JID resolvido no cadastro, para não reconsultar', async () => {
    verificarMock.mockResolvedValue(new Map([['5547999887766', '554799887766@s.whatsapp.net']]));
    await passadaDoDisparador(AGORA);
    expect(est.clientes[0].wa_jid).toBe('554799887766@s.whatsapp.net');
  });

  it('"não deu para verificar" devolve o alvo à fila em vez de excluí-lo', async () => {
    // A distinção que protege a pessoa: NÃO SEI ≠ NÃO TEM. Marcar
    // sem_whatsapp aqui excluiria da campanha, para sempre, alguém que só
    // teve o azar de uma falha de rede no instante errado.
    verificarMock.mockResolvedValue(new Map());

    const r = await passadaDoDisparador(AGORA);

    expect(enviarMock).not.toHaveBeenCalled();
    expect(est.alvos[0].status).toBe('pendente');
    expect(r.pulados.jid_nao_verificado).toBe(1);
  });

  it('não reconsulta quem já tem JID salvo', async () => {
    est.clientes = [clienteBase({ wa_jid: '5547999887766@s.whatsapp.net' })];
    await passadaDoDisparador(AGORA);
    expect(verificarMock).not.toHaveBeenCalled();
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });
});

describe('estágio 2 · aquecimento da linha', () => {
  it('não dispara em cima da reconexão', async () => {
    // O socket abre antes de a sessão estar utilizável, e a reconexão é
    // justamente quando o worker acorda com a fila cheia na mão.
    linhaAquecida = false;
    const r = await passadaDoDisparador(AGORA);
    expect(enviarMock).not.toHaveBeenCalled();
    expect(r.pulados.aquecendo_linha).toBe(1);
  });
});

describe('D-11 · reserva atômica do alvo', () => {
  it('tira o alvo de "pendente" ANTES de enviar', async () => {
    // Antes disto o alvo só saía de 'pendente' depois do envio — segundos
    // depois. Nessa janela um segundo processo lia o mesmo alvo, e o
    // índice único só barra a duplicata depois de a mensagem ter saído.
    enviarMock.mockImplementation(async () => {
      expect(est.alvos[0].status).not.toBe('pendente');
      return { waMessageId: 'wa-1', status: 'enviada' };
    });
    await passadaDoDisparador(AGORA);
    expect(enviarMock).toHaveBeenCalledTimes(1);
  });
});
