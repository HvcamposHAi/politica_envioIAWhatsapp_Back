// Teste pontual: captura de nome do contato (pushName/ProfileName) em
// resolverCliente()/processarEventoRecebido() — ver PLANO_CORRECAO_NOME_CONTATO.md
// §9. Mocka supabaseAdmin com um fake em memória (fluente o bastante para
// cobrir as cadeias usadas em mensagens.ts) — não toca banco real, ver
// twilio.e2e.test.ts para o equivalente com banco de verdade.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Registro = Record<string, unknown> & { id: string };
type Tabelas = Record<string, Registro[]>;

let proximoId = 0;

/** Fake mínimo do query builder do supabase-js: cobre só as cadeias que
 *  services/mensagens.ts realmente usa (select/insert/update + eq/is/order/
 *  limit + maybeSingle/single, e o builder é "thenable" pra cobrir os
 *  lugares onde o código não fecha com single()/maybeSingle(), ex.:
 *  `await supabaseAdmin.from('mensagens').insert({...})`). */
function criarSupabaseFake(tabelas: Tabelas) {
  function builder(tabela: string) {
    const registros = (tabelas[tabela] ??= []);
    const filtros: Array<(r: Registro) => boolean> = [];
    let modo: 'select' | 'insert' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    let ordenacao: { coluna: string; ascending: boolean } | undefined;
    let limite: number | undefined;

    function aplicarFiltros(lista: Registro[]) {
      return lista.filter((r) => filtros.every((f) => f(r)));
    }

    /** Simula os uniques reais de hub.clientes (clientes_telefone_empresa e
     *  clientes_wa_jid_empresa) — sem isto o caminho de merge de
     *  resolverCliente (UNIQUE_VIOLATION no patch de telefone) fica
     *  intestável, porque no fake todo update "dá certo". */
    function conflitoUniqueClientes(candidato: Registro, ignorar: Registro[]) {
      return registros.find(
        (r) =>
          !ignorar.includes(r) &&
          r.empresa_id === candidato.empresa_id &&
          ((candidato.telefone != null && r.telefone === candidato.telefone) ||
            (candidato.wa_jid != null && r.wa_jid === candidato.wa_jid)),
      );
    }
    const ERRO_UNIQUE = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "clientes_telefone_empresa"',
    };

    async function executar(): Promise<{ data: unknown; error: { code: string; message: string } | null }> {
      if (modo === 'insert') {
        const novo = { id: `id-${++proximoId}`, ...payload } as Registro;
        if (tabela === 'clientes' && conflitoUniqueClientes(novo, [])) {
          return { data: null, error: ERRO_UNIQUE };
        }
        registros.push(novo);
        return { data: novo, error: null };
      }
      if (modo === 'update') {
        const alvos = aplicarFiltros(registros);
        if (tabela === 'clientes') {
          for (const alvo of alvos) {
            if (conflitoUniqueClientes({ ...alvo, ...payload } as Registro, alvos)) {
              return { data: null, error: ERRO_UNIQUE };
            }
          }
        }
        alvos.forEach((r) => Object.assign(r, payload));
        return { data: alvos, error: null };
      }
      let resultado = aplicarFiltros(registros);
      if (ordenacao) {
        const { coluna, ascending } = ordenacao;
        resultado = [...resultado].sort((a, b) => {
          const av = String(a[coluna] ?? '');
          const bv = String(b[coluna] ?? '');
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limite !== undefined) resultado = resultado.slice(0, limite);
      return { data: resultado, error: null };
    }

    async function terminal(maybe: boolean) {
      const { data, error } = await executar();
      const lista = Array.isArray(data) ? data : [data];
      return { data: lista[0] ?? null, error, __maybe: maybe };
    }

    const api = {
      select() {
        return api;
      },
      eq(campo: string, valor: unknown) {
        filtros.push((r) => r[campo] === valor);
        return api;
      },
      is(campo: string, valor: unknown) {
        filtros.push((r) => (r[campo] ?? null) === valor);
        return api;
      },
      order(coluna: string, opts?: { ascending?: boolean }) {
        ordenacao = { coluna, ascending: opts?.ascending !== false };
        return api;
      },
      limit(n: number) {
        limite = n;
        return api;
      },
      insert(dados: Record<string, unknown>) {
        modo = 'insert';
        payload = dados;
        return api;
      },
      update(dados: Record<string, unknown>) {
        modo = 'update';
        payload = dados;
        return api;
      },
      maybeSingle: () => terminal(true),
      single: () => terminal(false),
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return executar().then(resolve, reject);
      },
    };

    return api;
  }

  /* `hub.tocar_conversa` (PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md §5.2) reproduzida
   * aqui com a MESMA semântica do SQL — `greatest` + clamp de futuro +
   * incremento atômico. Um fake que só gravasse `p_em` deixaria passar
   * exatamente a regressão que a função existe para impedir: backlog de
   * reconexão derrubando a conversa na lista. */
  function rpc(nome: string, args: Record<string, unknown>) {
    if (nome !== 'tocar_conversa') {
      return Promise.resolve({ data: null, error: { message: `rpc desconhecida no fake: ${nome}` } });
    }
    const conversa = (tabelas.conversas ??= []).find((c) => c.id === args.p_conversa_id);
    if (!conversa) return Promise.resolve({ data: null, error: null });

    const agora = Date.now();
    const pedido = args.p_em ? new Date(args.p_em as string).getTime() : agora;
    const limitado = Math.min(Number.isFinite(pedido) ? pedido : agora, agora);
    const atual = conversa.atualizado_em ? new Date(conversa.atualizado_em as string).getTime() : 0;
    conversa.atualizado_em = new Date(Math.max(atual, limitado)).toISOString();
    if (args.p_incrementar) {
      conversa.nao_lidas = ((conversa.nao_lidas as number) ?? 0) + 1;
    }
    return Promise.resolve({ data: conversa.atualizado_em, error: null });
  }

  return { from: (tabela: string) => builder(tabela), rpc };
}

let tabelas: Tabelas;
let supabaseFake: ReturnType<typeof criarSupabaseFake>;

vi.mock('../db/client.server.js', () => ({
  get supabaseAdmin() {
    return supabaseFake;
  },
}));

/** O fluxo de descadastro responde a confirmacao pelo canal. Sem este mock,
 *  o teste tentaria abrir um socket de WhatsApp de verdade. */
const enviarMock = vi.fn(async () => ({ waMessageId: 'wa-confirma', status: 'enviada' as const }));
vi.mock('../channels/registry.js', () => ({
  obterOuCriarCanal: async () => ({ enviar: enviarMock }),
}));

const { processarEventoRecebido, normalizarTelefone } = await import('./mensagens.js');

const EMPRESA_ID = 'empresa-1';
const CANAL_ID = 'canal-1';
const TELEFONE_BRUTO = '5541999998888';
const TELEFONE_NORM = normalizarTelefone(TELEFONE_BRUTO);

function seed() {
  tabelas = {
    canais: [{ id: CANAL_ID, empresa_id: EMPRESA_ID, setor_id: null } as Registro],
    clientes: [],
    conversas: [],
    mensagens: [],
  };
  supabaseFake = criarSupabaseFake(tabelas);
}

function cliente() {
  return tabelas.clientes.find((c) => c.telefone === TELEFONE_NORM);
}

describe('processarEventoRecebido — captura de nome do contato (pushName/ProfileName)', () => {
  beforeEach(() => {
    seed();
    proximoId = 0;
  });

  it('1. cliente novo com nomeContato presente -> grava o nome real, não o telefone', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
      nomeContato: 'Maria Silva',
    });

    expect(cliente()?.nome).toBe('Maria Silva');
  });

  it('2. cliente novo sem nomeContato -> mantém o fallback atual (nome = telefone)', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });

    expect(cliente()?.nome).toBe(TELEFONE_NORM);
  });

  it('3. guard de segurança: eco do atendente (fromMe) não sobrescreve o nome do cliente', async () => {
    // Cliente já existe com nome ainda placeholder (== telefone).
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });
    expect(cliente()?.nome).toBe(TELEFONE_NORM);

    // Atendente responde direto pelo celular pareado: fromMe -> origem
    // 'atendente', com o pushName sendo o nome do PRÓPRIO atendente/empresa.
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-2',
      telefone: TELEFONE_BRUTO,
      texto: 'pode deixar',
      origem: 'atendente',
      recebidoEm: new Date(),
      nomeContato: 'Agro Timbó Vendas',
    });

    expect(cliente()?.nome).toBe(TELEFONE_NORM); // não virou "Agro Timbó Vendas"
  });

  it('4. cliente existente com nome placeholder recebe o nome real na próxima mensagem', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });
    expect(cliente()?.nome).toBe(TELEFONE_NORM);

    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-2',
      telefone: TELEFONE_BRUTO,
      texto: 'tudo bem?',
      origem: 'cliente',
      recebidoEm: new Date(),
      nomeContato: 'João Pereira',
    });

    expect(cliente()?.nome).toBe('João Pereira');
  });

  it('5. cliente existente com nome já resolvido não é sobrescrito por um nomeContato diferente', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
      nomeContato: 'João Pereira',
    });
    expect(cliente()?.nome).toBe('João Pereira');

    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-2',
      telefone: TELEFONE_BRUTO,
      texto: 'de novo',
      origem: 'cliente',
      recebidoEm: new Date(),
      nomeContato: 'Outro Nome',
    });

    expect(cliente()?.nome).toBe('João Pereira');
  });

  it('6. nomeContato só espaço/vazio após trim é tratado como ausente', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
      nomeContato: '   ',
    });

    expect(cliente()?.nome).toBe(TELEFONE_NORM);
  });
});

// PLANO_CORRECAO_IDENTIFICACAO_LID_WHATSAPP.md §9 — correlação por wa_jid
// para contatos roteados por "@lid", sem fragmentar o cliente quando o
// telefone real aparece numa mensagem futura.
describe('processarEventoRecebido — correlação por wa_jid (contatos @lid)', () => {
  const WA_JID_LID = '120363190542165600@lid';

  beforeEach(() => {
    seed();
    proximoId = 0;
  });

  it('7. cliente @lid já conhecido (wa_jid salvo) não fragmenta quando o telefone real aparece', async () => {
    tabelas.clientes.push({
      id: 'cliente-lid-1',
      empresa_id: EMPRESA_ID,
      telefone: '120363190542165600', // ID cru, como ficou antes do fix (backfill do §5.3)
      nome: '120363190542165600',
      wa_jid: WA_JID_LID,
    } as Registro);

    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO, // resolvido via senderPn pelo adapter
      texto: 'oi de novo',
      origem: 'cliente',
      recebidoEm: new Date(),
      waJidOrigem: WA_JID_LID,
    });

    expect(tabelas.clientes).toHaveLength(1); // não criou um segundo cliente
    const c = tabelas.clientes[0];
    expect(c.id).toBe('cliente-lid-1');
    expect(c.telefone).toBe(TELEFONE_NORM); // corrigido de ID cru para o telefone real
  });

  it('8. não sobrescreve um telefone já real/correto por um valor diferente do mesmo wa_jid', async () => {
    tabelas.clientes.push({
      id: 'cliente-lid-2',
      empresa_id: EMPRESA_ID,
      telefone: TELEFONE_NORM, // já é um telefone real (<= 13 dígitos)
      nome: 'Cliente Já Nomeado',
      wa_jid: WA_JID_LID,
    } as Registro);

    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: '5541988887777', // diferente, não deveria acontecer, mas testa a defesa
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
      waJidOrigem: WA_JID_LID,
    });

    expect(tabelas.clientes).toHaveLength(1);
    expect(tabelas.clientes[0]!.telefone).toBe(TELEFONE_NORM); // não mudou
  });

  it('9. cliente novo via @lid grava telefone real (senderPn) e wa_jid num único registro', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
      nomeContato: 'Maria Silva',
      waJidOrigem: WA_JID_LID,
    });

    expect(tabelas.clientes).toHaveLength(1);
    const c = tabelas.clientes[0]!;
    expect(c.telefone).toBe(TELEFONE_NORM);
    expect(c.wa_jid).toBe(WA_JID_LID);
    expect(c.nome).toBe('Maria Silva');
  });

  it('10. cliente já existente por telefone (sem wa_jid ainda) ganha o wa_jid na próxima mensagem', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });
    expect(cliente()?.wa_jid).toBeNull();

    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-2',
      telefone: TELEFONE_BRUTO,
      texto: 'de novo, agora com jid',
      origem: 'cliente',
      recebidoEm: new Date(),
      waJidOrigem: TELEFONE_BRUTO + '@s.whatsapp.net',
    });

    expect(tabelas.clientes).toHaveLength(1); // mesmo cliente, não duplicou
    expect(cliente()?.wa_jid).toBe(TELEFONE_BRUTO + '@s.whatsapp.net');
  });
});

// Incidente 2026-08-08 ("não vejo as mensagens do 2º número"): resíduo @lid
// e dono do telefone real coexistem na mesma empresa — o patch de telefone
// viola clientes_telefone_empresa e, sem merge, toda mensagem nova ficava
// presa no resíduo, invisível para quem procura pelo número na Caixa.
describe('processarEventoRecebido — merge quando o telefone real já existe (resíduo @lid)', () => {
  const WA_JID_RESIDUO = '23716993970200@lid';

  function evento(extra?: Record<string, unknown>) {
    return {
      waMessageId: `wa-${++proximoId}`,
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente' as const,
      recebidoEm: new Date(),
      waJidOrigem: WA_JID_RESIDUO,
      ...extra,
    };
  }

  beforeEach(() => {
    seed();
    proximoId = 0;
    tabelas.clientes.push(
      {
        id: 'cliente-residuo',
        empresa_id: EMPRESA_ID,
        telefone: '23716993970200', // >13 dígitos: ainda "parece" lid cru
        nome: '23716993970200',
        wa_jid: WA_JID_RESIDUO,
      } as Registro,
      {
        id: 'cliente-dono',
        empresa_id: EMPRESA_ID,
        telefone: TELEFONE_NORM, // o telefone real que o patch tentaria gravar
        nome: TELEFONE_NORM,
        wa_jid: null,
      } as Registro,
    );
  });

  it('11. mensagem nova resolve para o dono do telefone, não fica presa no resíduo', async () => {
    await processarEventoRecebido(CANAL_ID, evento());

    expect(tabelas.conversas).toHaveLength(1);
    expect(tabelas.conversas[0]!.cliente_id).toBe('cliente-dono');
    expect(tabelas.mensagens).toHaveLength(1);
  });

  it('12. wa_jid migra do resíduo para o dono, sem violar o unique por empresa', async () => {
    await processarEventoRecebido(CANAL_ID, evento());

    const residuo = tabelas.clientes.find((c) => c.id === 'cliente-residuo')!;
    const dono = tabelas.clientes.find((c) => c.id === 'cliente-dono')!;
    expect(residuo.wa_jid).toBeNull();
    expect(dono.wa_jid).toBe(WA_JID_RESIDUO);
    // O telefone-resíduo fica como está: mover o histórico do resíduo é
    // operação de dados (SQL de merge), não deste fluxo.
    expect(residuo.telefone).toBe('23716993970200');

    // E a PRÓXIMA mensagem já acha o dono direto pelo wa_jid.
    await processarEventoRecebido(CANAL_ID, evento());
    expect(tabelas.conversas).toHaveLength(1); // mesma conversa aberta
    expect(tabelas.mensagens).toHaveLength(2);
  });

  it('13. nome placeholder do dono é corrigido pelo pushName no mesmo passo', async () => {
    await processarEventoRecebido(CANAL_ID, evento({ nomeContato: 'Sheila' }));

    expect(tabelas.clientes.find((c) => c.id === 'cliente-dono')!.nome).toBe('Sheila');
  });

  it('14. dono que já tem wa_jid próprio não é sobrescrito', async () => {
    tabelas.clientes.find((c) => c.id === 'cliente-dono')!.wa_jid = 'outro-jid@s.whatsapp.net';

    await processarEventoRecebido(CANAL_ID, evento());

    const dono = tabelas.clientes.find((c) => c.id === 'cliente-dono')!;
    expect(dono.wa_jid).toBe('outro-jid@s.whatsapp.net'); // preservado
    expect(tabelas.conversas[0]!.cliente_id).toBe('cliente-dono'); // merge acontece mesmo assim
  });
});

// Linha pessoal (20260808150000_hub_canais_atendente_responsavel):
// canal com atendente_id -> conversa nova ja nasce com dono; canal sem
// (linha de equipe) -> nasce "Sem dono", comportamento classico.
describe('processarEventoRecebido — linha pessoal (canais.atendente_id)', () => {
  beforeEach(() => {
    seed();
    proximoId = 0;
  });

  it('canal com atendente responsável -> conversa nasce com atendente_id preenchido', async () => {
    tabelas.canais[0]!.atendente_id = 'atendente-humberto';

    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });

    expect(tabelas.conversas).toHaveLength(1);
    expect(tabelas.conversas[0]!.atendente_id).toBe('atendente-humberto');
  });

  it('canal de equipe (sem atendente_id) -> conversa nasce Sem dono (atendente_id null)', async () => {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });

    expect(tabelas.conversas).toHaveLength(1);
    expect(tabelas.conversas[0]!.atendente_id ?? null).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Auditoria 2026-08-09, itens 4 e 6b.
 * ------------------------------------------------------------------------- */

describe('processarEventoRecebido — primeira_resposta_em (item 4)', () => {
  beforeEach(() => {
    seed();
    proximoId = 0;
  });

  async function doCliente(waMessageId = 'wa-cliente') {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId,
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });
  }

  async function doAtendente(waMessageId = 'wa-atendente') {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId,
      telefone: TELEFONE_BRUTO,
      texto: 'pode deixar',
      origem: 'atendente',
      recebidoEm: new Date(),
    });
  }

  it('eco fromMe marca a primeira resposta — era o furo do vendedor que responde pelo celular', async () => {
    await doCliente();
    expect(tabelas.conversas[0]!.primeira_resposta_em ?? null).toBeNull();

    await doAtendente();

    expect(tabelas.conversas[0]!.primeira_resposta_em).toBeTruthy();
  });

  it('mensagem de CLIENTE nunca marca primeira resposta', async () => {
    await doCliente('wa-1');
    await doCliente('wa-2');

    expect(tabelas.conversas[0]!.primeira_resposta_em ?? null).toBeNull();
  });

  it('idempotente: o segundo eco não reescreve o carimbo do primeiro', async () => {
    await doCliente();
    await doAtendente('wa-a1');
    const primeiro = tabelas.conversas[0]!.primeira_resposta_em;

    await doAtendente('wa-a2');

    expect(tabelas.conversas[0]!.primeira_resposta_em).toBe(primeiro);
  });

  it('conversa FECHADA não recebe carimbo — eco de pesquisa/agradecimento não é resposta', async () => {
    await doCliente();
    // Chamado finalizado antes do eco chegar.
    tabelas.conversas[0]!.fechada_em = new Date().toISOString();

    await doAtendente();

    expect(tabelas.conversas[0]!.primeira_resposta_em ?? null).toBeNull();
  });
});

describe('processarEventoRecebido — eco em conversa fechada não cria fantasma (item 6b)', () => {
  beforeEach(() => {
    seed();
    proximoId = 0;
  });

  it('eco de mensagem NOSSA em chamado fechado é no-op — não abre conversa nova', async () => {
    // 1. Conversa real, depois fechada.
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-cliente',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: new Date(),
    });
    const conversaOriginal = tabelas.conversas[0]!.id;
    tabelas.conversas[0]!.fechada_em = new Date().toISOString();

    // 2. routes/avaliacao.ts envia a pesquisa e grava a mensagem NA conversa
    //    fechada — é o que acontece hoje em produção.
    tabelas.mensagens.push({
      id: 'msg-pesquisa',
      conversa_id: conversaOriginal,
      wa_message_id: 'wa-pesquisa',
      autor: 'atendente',
      direcao: 'saida',
      texto: 'Obrigado pelo contato! De 1 a 5...',
    } as Registro);

    // 3. O Baileys devolve o eco fromMe da MESMA mensagem.
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-pesquisa',
      telefone: TELEFONE_BRUTO,
      texto: 'Obrigado pelo contato! De 1 a 5...',
      origem: 'atendente',
      recebidoEm: new Date(),
    });

    // Antes da correção nascia uma segunda conversa contendo só a pesquisa.
    expect(tabelas.conversas).toHaveLength(1);
    expect(tabelas.conversas[0]!.id).toBe(conversaOriginal);
  });

  it('mensagem INÉDITA do celular sem chamado aberto continua abrindo conversa', async () => {
    // O comportamento que a guarda não pode ter matado: vendedor inicia o
    // contato pelo telefone, com um wa_message_id que nunca vimos.
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-inedito',
      telefone: TELEFONE_BRUTO,
      texto: 'bom dia, seu pedido chegou',
      origem: 'atendente',
      recebidoEm: new Date(),
    });

    expect(tabelas.conversas).toHaveLength(1);
    expect(tabelas.mensagens).toHaveLength(1);
  });
});

/* Ordem cronológica por atividade real — PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md.
 *
 * Estes casos cobrem o fluxo INTEIRO (evento -> insert -> carimbo da conversa),
 * que é onde o defeito vivia: o adapter resolvia o `messageTimestamp` e o insert
 * o descartava. Testar só `instanteDaMensagem` provaria a função, não a ligação
 * — e era exatamente a ligação que estava faltando. */
describe('processarEventoRecebido — data/hora real da mensagem e ordem da Caixa', () => {
  beforeEach(() => {
    seed();
    proximoId = 0;
  });

  const UMA_HORA = 3_600_000;

  it('grava enviada_em com o timestamp do WhatsApp, não com a hora do processamento', async () => {
    const duasHorasAtras = new Date(Date.now() - 2 * UMA_HORA);
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-backlog',
      telefone: TELEFONE_BRUTO,
      texto: 'mandei isto faz duas horas',
      origem: 'cliente',
      recebidoEm: duasHorasAtras,
    });

    expect(tabelas.mensagens[0]!.enviada_em).toBe(duasHorasAtras.toISOString());
  });

  it('mensagem em tempo real carimba a conversa com o instante dela', async () => {
    const agora = new Date();
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: agora,
    });

    expect(tabelas.conversas[0]!.atualizado_em).toBe(agora.toISOString());
  });

  it('BACKLOG não derruba a conversa na lista — o carimbo nunca retrocede', async () => {
    // Cenário E15 do plano: a conversa já teve atividade recente e o Baileys
    // reconecta trazendo mensagens antigas. Sem `greatest`, a conversa
    // afundaria na Caixa justamente quando recebeu mensagem.
    const recente = new Date(Date.now() - UMA_HORA);
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-recente',
      telefone: TELEFONE_BRUTO,
      texto: 'atividade de uma hora atrás',
      origem: 'cliente',
      recebidoEm: recente,
    });

    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-antiga',
      telefone: TELEFONE_BRUTO,
      texto: 'escrita ontem, entregue agora',
      origem: 'cliente',
      recebidoEm: new Date(Date.now() - 24 * UMA_HORA),
    });

    expect(tabelas.conversas[0]!.atualizado_em).toBe(recente.toISOString());
    // …mas a mensagem antiga entra no fio com a hora REAL dela, e o front
    // ordena o fio por enviada_em — ela cai na posição certa.
    const antiga = tabelas.mensagens.find((m) => m.wa_message_id === 'wa-antiga');
    expect(new Date(antiga!.enviada_em as string).getTime()).toBeLessThan(recente.getTime());
  });

  it('relógio adiantado do cliente não prega a conversa no topo', async () => {
    const antes = Date.now();
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-futuro',
      telefone: TELEFONE_BRUTO,
      texto: 'meu celular acha que é 2027',
      origem: 'cliente',
      recebidoEm: new Date(Date.now() + 365 * 24 * UMA_HORA),
    });

    const carimbo = new Date(tabelas.conversas[0]!.atualizado_em as string).getTime();
    expect(carimbo).toBeGreaterThanOrEqual(antes);
    expect(carimbo).toBeLessThanOrEqual(Date.now());
  });

  it('a mesma data/hora vai para hub.mensagens e para hub.conversas', async () => {
    // Duas tabelas discordando sobre quando a mensagem aconteceu é o que faz a
    // ordem da lista contradizer o horário exibido no card.
    const quando = new Date(Date.now() - 30 * 60_000);
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-1',
      telefone: TELEFONE_BRUTO,
      texto: 'oi',
      origem: 'cliente',
      recebidoEm: quando,
    });

    expect(tabelas.mensagens[0]!.enviada_em).toBe(tabelas.conversas[0]!.atualizado_em);
  });

  it('eco do celular pareado também carimba a conversa (e não conta como não lida)', async () => {
    const quando = new Date(Date.now() - 5 * 60_000);
    await processarEventoRecebido(CANAL_ID, {
      waMessageId: 'wa-eco',
      telefone: TELEFONE_BRUTO,
      texto: 'respondi pelo celular',
      origem: 'atendente',
      recebidoEm: quando,
    });

    expect(tabelas.conversas[0]!.atualizado_em).toBe(quando.toISOString());
    expect(tabelas.conversas[0]!.nao_lidas ?? 0).toBe(0);
  });

  it('duas mensagens do cliente incrementam nao_lidas duas vezes', async () => {
    for (const id of ['wa-1', 'wa-2']) {
      await processarEventoRecebido(CANAL_ID, {
        waMessageId: id,
        telefone: TELEFONE_BRUTO,
        texto: 'oi',
        origem: 'cliente',
        recebidoEm: new Date(),
      });
    }
    expect(tabelas.conversas[0]!.nao_lidas).toBe(2);
  });
});

describe('processarEventoRecebido — descadastro pedido pelo eleitor', () => {
  beforeEach(() => {
    seed();
    proximoId = 0;
    vi.clearAllMocks();
    enviarMock.mockResolvedValue({ waMessageId: 'wa-confirma', status: 'enviada' as const });
  });

  async function chegaMensagem(texto: string, waMessageId = 'wa-x') {
    await processarEventoRecebido(CANAL_ID, {
      waMessageId,
      telefone: TELEFONE_BRUTO,
      texto,
      origem: 'cliente',
      recebidoEm: new Date(),
      nomeContato: 'Maria Silva',
    });
  }

  it('grava o opt-out quando a pessoa responde SAIR', async () => {
    await chegaMensagem('oi, recebi a mensagem', 'wa-1');
    expect(cliente()?.opt_out_em).toBeFalsy();

    await chegaMensagem('SAIR', 'wa-2');
    expect(cliente()?.opt_out_em).toBeTruthy();
    expect(cliente()?.situacao).toBe('opt_out');
    expect(String(cliente()?.opt_out_motivo)).toContain('SAIR');
  });

  it('confirma para a pessoa que ela saiu', async () => {
    await chegaMensagem('não quero mais receber');
    expect(enviarMock).toHaveBeenCalledTimes(1);
    expect(String(enviarMock.mock.calls[0][0].texto)).toContain('não receberá mais mensagens');
  });

  it('a confirmação fica registrada na conversa', async () => {
    await chegaMensagem('me tira dessa lista');
    const saidas = tabelas.mensagens.filter((m) => m.direcao === 'saida');
    expect(saidas).toHaveLength(1);
    expect(saidas[0].autor).toBe('atendente');
  });

  it('mensagem comum não descadastra ninguém', async () => {
    await chegaMensagem('Bom dia! Vocês vão fazer algo pelo bairro?');
    expect(cliente()?.opt_out_em).toBeFalsy();
    expect(enviarMock).not.toHaveBeenCalled();
  });

  it('não confirma duas vezes se a pessoa insistir', async () => {
    await chegaMensagem('SAIR', 'wa-1');
    expect(enviarMock).toHaveBeenCalledTimes(1);

    // Pediu de novo: já estava fora, então nada muda no cadastro. A
    // confirmação sai outra vez de propósito — a pessoa está perguntando se
    // funcionou, e o silêncio é a pior resposta possível.
    const quando = cliente()?.opt_out_em;
    await chegaMensagem('PARE', 'wa-2');
    expect(cliente()?.opt_out_em).toBe(quando);
  });

  it('a falha ao confirmar não desfaz o descadastro', async () => {
    // O descadastro é o que barra o envio. Perder a confirmação é ruim;
    // perder o descadastro é o desastre.
    enviarMock.mockRejectedValue(new Error('linha caída'));
    await chegaMensagem('descadastrar');
    expect(cliente()?.opt_out_em).toBeTruthy();
  });
});
