// Adapter Baileys — implementa ChannelPort (Fase 5).
//
// NÃO TESTADO CONTRA UM NÚMERO REAL nesta passada: pareamento por QR
// exige um WhatsApp físico e um ambiente ao vivo (fora do alcance desta
// sessão). O que foi verificado: compila contra os tipos reais do
// pacote instalado (@whiskeysockets/baileys@6.7.24, tag `legacy` do npm
// — a `latest` é 7.0.0-rc14, um release candidate; para uma integração
// de produção onde o Risco #1 do plano é justamente ban/instabilidade
// de sessão, a linha estável é a escolha defensável, não a mais nova).
//
// Aceite pendente de Fase 5 (A5.5/A5.10), só verificável ao vivo:
//   · QR real escaneável, chegando por Realtime
//   · matar o processo e subir de novo reconecta sem novo QR
//   · 3 linhas simultâneas estáveis por 48h

import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { usePostgresAuthState } from './auth-state.postgres.js';
import { supabaseAdmin } from '../db/client.server.js';
import { classificarConteudo, type RefDownload } from './mensagemWhatsApp.js';
import { canalRecebeGrupos, sincronizarParticipantes } from '../services/grupos.js';
import {
  type ChannelPort,
  type EnvioMensagem,
  type EventoRecebido,
  type ResultadoEnvio,
  type StatusConexao,
} from './port.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

async function registrarEvento(canalId: string, tipo: string, detalhe?: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from('eventos_canal').insert({ canal_id: canalId, tipo, detalhe: detalhe ?? null });
  if (error) {
    // Log, não throw: perder um evento de log não pode derrubar a sessão
    // de WhatsApp em si.
    logger.error({ canalId, tipo, err: error.message }, 'falha ao gravar hub.eventos_canal');
  }
}

async function atualizarStatusCanal(canalId: string, status: StatusConexao) {
  const { error } = await supabaseAdmin
    .from('canais')
    .update({ conexao_status: status, ultima_conexao: status === 'conectado' ? new Date().toISOString() : undefined })
    .eq('id', canalId);
  if (error) {
    logger.error({ canalId, status, err: error.message }, 'falha ao atualizar hub.canais.conexao_status');
  }
}

/** Teto do backoff exponencial de reconexão (A5.6). */
const BACKOFF_MAXIMO_MS = 60_000;

/** Idade máxima de uma tentativa de conexão em 'conectando'/'lendo_qr'
 *  antes de a guarda de idempotência deixar de protegê-la. Uma tentativa
 *  presa além disso é um socket zumbi (ex.: exceção interna do Baileys
 *  abortou o handshake sem emitir 'close') — proteger um zumbi deixaria o
 *  canal impossível de reconectar pela UI para sempre (incidente
 *  2026-08-07: clique caiu em no-op sobre uma tentativa já condenada). */
const GUARDA_CONEXAO_STALE_MS = 90_000;

/** Teto de ciclos consecutivos de REGISTRO (canal ainda não pareado) antes
 *  de parar de tentar sozinho. Sem teto, o backoff reconectava o registro
 *  para sempre — dezenas de tentativas/hora sem ninguém na frente da tela,
 *  que é exatamente o perfil que faz o WhatsApp aplicar limitação
 *  anti-abuso e passar a encerrar a conexão na fase de registro
 *  ("Connection Terminated" antes de qualquer QR — incidente 2 do
 *  PLANO_CORRECAO_PAREAMENTO_BAILEYS.md). Canal JÁ pareado não tem teto:
 *  reconexão infinita é o comportamento certo para queda de rede de uma
 *  linha em produção. */
const MAXIMO_CICLOS_REGISTRO = 3;

/** Validade do cache de metadados de grupo (assunto + participantes). */
const CACHE_GRUPO_MS = 6 * 60 * 60_000;

/**
 * Traduz um EnvioMensagem no stanza certo do WhatsApp.
 *
 * Exportado para teste: imagem, vídeo, áudio e documento NÃO são o mesmo tipo
 * de mensagem lá dentro. Mandar tudo como documento (o caminho fácil) tira a
 * prévia da foto, o player do vídeo e a onda da nota de voz — exatamente a
 * paridade com o WhatsApp Desktop que esta feature existe para entregar.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function montarConteudoEnvio(msg: EnvioMensagem): any {
  if (!msg.midiaBuffer) return { text: msg.texto ?? '' };

  const mime = msg.midiaTipo ?? 'application/octet-stream';
  // Legenda e mídia são a MESMA mensagem no WhatsApp — nunca mandar duas.
  const legenda = msg.texto?.trim() || undefined;

  switch (msg.midiaClasse) {
    case 'imagem':
      return { image: msg.midiaBuffer, mimetype: mime, caption: legenda };
    case 'video':
      return { video: msg.midiaBuffer, mimetype: mime, caption: legenda };
    case 'voz':
      // ptt: true é o que faz o WhatsApp mostrar a onda e o botão de play em
      // vez de um anexo. Exige opus em ogg — a conversão acontece na rota de
      // upload (services/audioVoz.ts), não aqui.
      return { audio: msg.midiaBuffer, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: msg.midiaDuracaoSeg };
    case 'audio':
      return { audio: msg.midiaBuffer, mimetype: mime, ptt: false, seconds: msg.midiaDuracaoSeg };
    default:
      return {
        document: msg.midiaBuffer,
        mimetype: mime,
        fileName: msg.midiaNome ?? 'arquivo',
        caption: legenda,
      };
  }
}

export class BaileysChannel implements ChannelPort {
  readonly transporte = 'baileys' as const;
  private socket: WASocket | undefined;
  private receiverHandler: ((evento: EventoRecebido) => Promise<void>) | undefined;
  private statusAtual: StatusConexao = 'desconectado';
  /** Zerado a cada conexão bem-sucedida; dobra a cada queda que reconecta. */
  private tentativasReconexao = 0;
  /** true durante um desconectar() em andamento — suprime o auto-reconnect
   *  do handler de connection.update abaixo, que senão tentaria reabrir o
   *  socket que acabamos de fechar de propósito (ver desconectar()). */
  private encerrandoIntencionalmente = false;
  /** Quando a tentativa de conexão atual começou — usado pela guarda de
   *  idempotência para expirar tentativas presas (zumbis). */
  private conectandoDesde = 0;
  /** Ciclos consecutivos de registro (não-pareado) que fecharam sem
   *  pareamento — comparado com MAXIMO_CICLOS_REGISTRO. Zera num
   *  conectar() manual (status 'desconectado') e quando um pareamento
   *  completa. */
  private ciclosRegistroSemPareamento = 0;
  /** Timer do backoff pendente. Rastreado para (1) nunca acumular dois
   *  timers de reconexão (fechamentos rápidos em sequência agendavam um
   *  cada) e (2) o teto de registro conseguir CANCELAR a reconexão já
   *  agendada — sem isso, o timer pendente disparava depois do teto, era
   *  tratado como clique manual (status 'desconectado') e renovava o
   *  orçamento, derrotando o teto. */
  private timerReconexao: ReturnType<typeof setTimeout> | undefined;
  /** Metadados de grupo (assunto + participantes) com validade de 6h. Sem
   *  cache, CADA mensagem de grupo dispararia um `groupMetadata()` ao
   *  WhatsApp — num grupo movimentado isso é o perfil de tráfego que o
   *  WhatsApp trata como abuso. */
  private cacheGrupo = new Map<string, { assunto: string; em: number }>();

  constructor(readonly canalId: string) {}

  async conectar(): Promise<void> {
    // Idempotência: uma segunda chamada enquanto já há uma tentativa em
    // andamento (ou uma sessão já ativa) NÃO pode abrir outro socket. Dois
    // sockets concorrentes para a mesma identidade fazem o WhatsApp fechar
    // a conexão ("Connection Closed", statusCode 428, validateConnection)
    // antes mesmo de gerar QR — causa raiz confirmada em produção via
    // `gcloud logging read` (PLANO_CORRECAO_CONEXAO_QR_BAILEYS.md §1). A UI
    // pode legitimamente chamar isto mais de uma vez (reabrir o modal, um
    // retry) — quem garante um socket só por canal é aqui, não a UI.
    //
    // A guarda EXPIRA: 'conectado' é estado saudável e nunca expira, mas
    // uma tentativa presa em 'conectando'/'lendo_qr' há mais de
    // GUARDA_CONEXAO_STALE_MS é um zumbi (handshake abortado por exceção
    // interna, rede morta) — aí a chamada nova derruba o socket velho e
    // assume, em vez de virar no-op para sempre.
    if (
      this.socket &&
      (this.statusAtual === 'conectando' || this.statusAtual === 'lendo_qr' || this.statusAtual === 'conectado')
    ) {
      const idadeTentativa = Date.now() - this.conectandoDesde;
      if (this.statusAtual === 'conectado' || idadeTentativa < GUARDA_CONEXAO_STALE_MS) {
        return;
      }
      try {
        this.socket.end(undefined);
      } catch {
        // socket zumbi pode lançar ao fechar — irrelevante, vai ser substituído
      }
      this.socket = undefined;
    }
    // Chamada "manual" (usuário clicou, ou primeiro conectar do canal):
    // renova o orçamento de ciclos de registro. Chamadas do backoff chegam
    // com status 'instavel' e não zeram — senão o teto nunca estouraria.
    if (this.statusAtual === 'desconectado' || this.statusAtual === 'caido') {
      this.ciclosRegistroSemPareamento = 0;
    }
    // Uma chamada de conexão é, por definição, a declaração de que não
    // estamos mais encerrando. Sem este reset o flag ficava true para
    // sempre (era escrito em desconectar() e em nenhum outro lugar), e como
    // o objeto continua vivo no Map do registry, UM clique em "Desligar
    // linha" matava o auto-reconnect, o backoff E o teto de registro
    // daquela linha pelo resto da vida do processo: ela reparava por QR,
    // funcionava, e na primeira queda de rede ia para 'instavel' e ficava
    // lá (diagnóstico 2026-08-14, causa 2).
    this.encerrandoIntencionalmente = false;
    this.conectandoDesde = Date.now();

    const { state, saveCreds } = await usePostgresAuthState(this.canalId);
    // fetchLatestBaileysVersion() faz um GET em raw.githubusercontent.com e
    // NÃO repassa timeout/AbortSignal (confirmado lendo node_modules/
    // @whiskeysockets/baileys/lib/Utils/generics.js, também na 7.x) — se a
    // chamada travar (rede lenta/bloqueada a partir do Cloud Run),
    // conectar() nunca chegaria a abrir o socket, sem nenhum log de erro
    // (achado em produção, PLANO_CORRECAO_CONEXAO_QR_BAILEYS.md). O race
    // abaixo é o timeout que a lib não tem: estourou, seguimos SEM a opção
    // `version` e o makeWASocket usa a versão embutida do pacote — que na
    // linha `latest` é atual, ao contrário da `legacy`.
    const versaoInfo = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<{ version: undefined; isLatest: false }>((resolve) => {
        const t = setTimeout(() => resolve({ version: undefined, isLatest: false }), 8_000);
        t.unref?.();
      }),
    ]);
    // Sem isto não há como saber, em produção, qual versão de cliente foi
    // anunciada ao WhatsApp — lacuna sentida na investigação do incidente
    // de pareamento (PLANO_CORRECAO_PAREAMENTO_BAILEYS.md, frente C).
    logger.info(
      { version: versaoInfo.version ?? 'embutida-no-pacote', isLatest: versaoInfo.isLatest },
      'versão do WhatsApp Web anunciada ao conectar',
    );

    this.statusAtual = 'conectando';
    await atualizarStatusCanal(this.canalId, 'conectando');

    const socket = makeWASocket({
      auth: state,
      ...(versaoInfo.version ? { version: versaoInfo.version } : {}),
      logger,
      // Identificação do device conectado (aparece no app -> Aparelhos
      // conectados do usuário). Sem isto, o padrão do Baileys expõe
      // detalhe de versão da lib que não interessa ao atendente.
      browser: ['Hub de WhatsApp', 'Chrome', '1.0.0'],
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        this.statusAtual = 'lendo_qr';
        await atualizarStatusCanal(this.canalId, 'lendo_qr');
        // O QR chega ao front por Realtime via hub.eventos_canal — nenhuma
        // rota HTTP de polling, por contrato (plano-base §5).
        await registrarEvento(this.canalId, 'qr_gerado', { qr });
      }

      if (connection === 'open') {
        this.statusAtual = 'conectado';
        this.tentativasReconexao = 0;
        await atualizarStatusCanal(this.canalId, 'conectado');
        await registrarEvento(this.canalId, 'conectado');
      }

      if (connection === 'close') {
        const motivo = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const foiLogout = motivo === DisconnectReason.loggedOut;
        // "Pareado" = creds.me preenchido. NÃO usar creds.registered: na
        // 7.x ele permanece false mesmo com pareamento completo e linha
        // logada (confirmado em produção 2026-08-08) — usá-lo faria o teto
        // de registro tratar uma linha SAUDÁVEL como não-pareada e parar a
        // reconexão dela após 3 quedas de rede.
        const pareado = !!state.creds?.me;

        // Teto de registro (incidente 2, PLANO_CORRECAO_PAREAMENTO_
        // BAILEYS.md): canal AINDA NÃO pareado que fecha o ciclo de
        // registro repetidamente para de tentar sozinho — retry infinito
        // de registro é o perfil que faz o WhatsApp aplicar limitação
        // anti-abuso ("Connection Terminated" antes de qualquer QR). O
        // usuário retoma pela UI quando quiser; canal já pareado nunca
        // passa por aqui.
        if (!foiLogout && !pareado && !this.encerrandoIntencionalmente) {
          this.ciclosRegistroSemPareamento += 1;
          if (this.ciclosRegistroSemPareamento >= MAXIMO_CICLOS_REGISTRO) {
            if (this.timerReconexao) {
              clearTimeout(this.timerReconexao);
              this.timerReconexao = undefined;
            }
            this.socket = undefined;
            this.statusAtual = 'desconectado';
            await atualizarStatusCanal(this.canalId, 'desconectado');
            await registrarEvento(this.canalId, 'erro', {
              mensagem:
                'O WhatsApp encerrou as tentativas de pareamento seguidas vezes — pode haver limitação temporária. Aguarde alguns minutos e clique em "Tentar de novo".',
            });
            return;
          }
        } else if (pareado) {
          this.ciclosRegistroSemPareamento = 0;
        }

        const deveReconectar = !foiLogout;

        this.statusAtual = deveReconectar ? 'instavel' : 'desconectado';
        await atualizarStatusCanal(this.canalId, this.statusAtual);
        await registrarEvento(this.canalId, deveReconectar ? 'reconectando' : 'logout', { motivo });

        if (deveReconectar && !this.encerrandoIntencionalmente) {
          // Backoff exponencial (A5.6): 1s, 2s, 4s... até o teto de 60s,
          // resetado em 'open'. Cada queda soma mais espera em vez de
          // martelar a reconexão a cada 5s fixos.
          const espera = Math.min(2 ** this.tentativasReconexao * 1_000, BACKOFF_MAXIMO_MS);
          this.tentativasReconexao += 1;
          if (this.timerReconexao) clearTimeout(this.timerReconexao);
          this.timerReconexao = setTimeout(() => void this.conectar(), espera);
        } else if (!deveReconectar) {
          // 401 loggedOut: o WhatsApp declarou esta sessão morta — as
          // credenciais salvas em hub.canal_sessoes nunca mais vão
          // funcionar. Sem esta limpeza, todo conectar() futuro recarrega
          // a credencial morta, tenta retomar a sessão em vez de gerar QR,
          // leva outro 401, e o canal fica PRESO para sempre (incidente
          // 2026-08-07: pareamento interrompido por crash no meio da
          // gravação deixou creds meio-pareadas — `me` preenchido,
          // registered=false — e nenhum QR foi emitido de novo até uma
          // limpeza manual por SQL). Apagar aqui faz o próximo conectar()
          // partir de credencial nova e emitir QR — autocura, sem SQL.
          this.socket = undefined;
          const { error: erroLimpeza } = await supabaseAdmin
            .from('canal_sessoes')
            .delete()
            .eq('canal_id', this.canalId);
          if (erroLimpeza) {
            logger.error(
              { canalId: this.canalId, err: erroLimpeza.message },
              'falha ao limpar hub.canal_sessoes após loggedOut',
            );
          }
          // Evento 'erro' é o tipo que o modal de conexão já exibe com o
          // botão "Tentar de novo" (conectar-numero.tsx) — sem isto a tela
          // fica no spinner infinito esperando um QR que nunca vem.
          await registrarEvento(this.canalId, 'erro', {
            mensagem:
              'O WhatsApp desvinculou esta sessão. Clique em "Tentar de novo" para gerar um QR novo.',
          });
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'append' são mensagens sincronizadas do histórico do aparelho, não
      // tráfego novo. Continuam fora do funil por decisão de escopo (importar
      // histórico é fase própria — ver D8 do PLANO_MENSAGENS_INTEGRA_
      // WHATSAPP.md): entrariam centenas de conversas antigas de uma vez na
      // Caixa, no Kanban e no Painel.
      if (type !== 'notify' || !this.receiverHandler) return;

      for (const msg of messages) {
        try {
          await this.processarRecebida(msg);
        } catch (err) {
          // Uma mensagem malformada não pode parar a fila das outras. O laço
          // é serial e este catch é o que garante que a rajada continue.
          logger.error(
            {
              canalId: this.canalId,
              waMessageId: msg.key?.id,
              err: err instanceof Error ? err.message : String(err),
            },
            'falha ao processar mensagem recebida no adapter — seguindo para a próxima',
          );
        }
      }
    });

    // Reação a mensagem. Não cria linha nova — altera a bolha existente,
    // igual ao WhatsApp. Chega por evento próprio quando quem reage é o
    // contato; a reação do próprio celular pareado vem por messages.upsert e
    // cai no mesmo caminho via classificarConteudo.
    socket.ev.on('messages.reaction', async (reacoes) => {
      if (!this.receiverHandler) return;
      for (const r of reacoes) {
        const alvoWaId = r.key?.id;
        if (!alvoWaId) continue;
        const reator = r.reaction?.key?.participant ?? r.reaction?.key?.remoteJid ?? undefined;
        await this.receiverHandler({
          waMessageId: alvoWaId,
          telefone: '',
          origem: 'cliente',
          recebidoEm: new Date(),
          efeito: { tipo: 'reagir', alvoWaId, texto: r.reaction?.text ?? '' },
          autorWaJid: reator ?? undefined,
        }).catch((err) => {
          logger.error({ canalId: this.canalId, alvoWaId, err: String(err) }, 'falha ao aplicar reação');
        });
      }
    });

    // Sincroniza o assunto do grupo quando ele muda no WhatsApp — sem isto, a
    // Caixa mostraria para sempre o nome que o grupo tinha na primeira
    // mensagem.
    socket.ev.on('groups.update', async (atualizacoes) => {
      for (const g of atualizacoes) {
        if (!g.id || !g.subject) continue;
        this.cacheGrupo.delete(g.id);
      }
    });

    socket.ev.on('group-participants.update', async (evento) => {
      // O roster mudou: invalida o cache para a próxima mensagem do grupo
      // ressincronizar. Não busca agora de propósito — um grupo com muita
      // entrada/saída faria uma chamada ao WhatsApp por evento.
      if (evento.id) this.cacheGrupo.delete(evento.id);
    });

    this.socket = socket;
  }

  /** Assunto do grupo, com cache de 6h. Devolve `undefined` em vez de lançar:
   *  não saber o nome do grupo não pode impedir a mensagem de entrar — a
   *  conversa nasceria sem nome e o nome chega na próxima. */
  private async assuntoDoGrupo(jid: string): Promise<string | undefined> {
    const guardado = this.cacheGrupo.get(jid);
    if (guardado && Date.now() - guardado.em < CACHE_GRUPO_MS) return guardado.assunto;
    if (!this.socket) return guardado?.assunto;

    try {
      const meta = await this.socket.groupMetadata(jid);
      const assunto = meta?.subject?.trim() || undefined;
      if (assunto) this.cacheGrupo.set(jid, { assunto, em: Date.now() });
      // Roster para a Ficha. Fire-and-forget: falhar aqui não pode segurar a
      // mensagem, que é o produto.
      void sincronizarParticipantes(this.canalId, jid, meta?.participants ?? []);
      return assunto;
    } catch (err) {
      logger.warn(
        { canalId: this.canalId, jid, err: err instanceof Error ? err.message : String(err) },
        'falha ao ler metadados do grupo — a mensagem entra mesmo assim',
      );
      return guardado?.assunto;
    }
  }

  /** Pede ao WhatsApp que REENVIE a mídia. Usado pela fila de download quando
   *  a URL original já expirou (mensagem recebida depois de dias offline). */
  private async reobterRefMidia(msg: unknown): Promise<RefDownload | null> {
    if (!this.socket) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const atualizada = await this.socket.updateMediaMessage(msg as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conteudo = classificarConteudo((atualizada as any)?.message ?? (msg as any)?.message);
      return conteudo.midia?.ref ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Converte UMA mensagem do Baileys em EventoRecebido e entrega ao handler.
   *
   * Extraído do laço de `messages.upsert` quando a classificação de conteúdo
   * entrou: o laço agora só cuida de iterar e não deixar uma mensagem ruim
   * derrubar as outras.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processarRecebida(msg: any): Promise<void> {
    const jidOrigemBruto: string | undefined = msg.key?.remoteJid ?? undefined;
    const waMessageId: string | undefined = msg.key?.id ?? undefined;
    if (!jidOrigemBruto || !waMessageId || !this.receiverHandler) return;

    // Status e newsletter continuam fora: não são atendimento, e ingeri-los
    // criava "clientes" com telefone-lixo (confirmado em produção
    // 2026-08-08). Grupo SAIU deste descarte — agora depende do opt-in da
    // linha, logo abaixo.
    if (jidOrigemBruto.endsWith('@broadcast') || jidOrigemBruto.endsWith('@newsletter')) return;

    const ehGrupo = jidOrigemBruto.endsWith('@g.us');
    // Opt-in por LINHA. Default false: uma linha pareada a um celular com
    // dezenas de grupos despejaria todos eles na Caixa no primeiro minuto.
    if (ehGrupo && !(await canalRecebeGrupos(this.canalId))) return;

    const conteudo = classificarConteudo(msg.message);
    // Único descarte legítimo: ruído de protocolo (distribuição de chave,
    // ajuste de temporizador efêmero). Tipo desconhecido NÃO cai aqui — vira
    // linha 'desconhecido' com o payload preservado.
    if (conteudo.ignorar && !conteudo.efeito) return;

    const recebidoEm = new Date((Number(msg.messageTimestamp) || Date.now() / 1000) * 1000);
    const deMim = !!msg.key?.fromMe;

    // Efeito (reação/edição/apagar) não precisa de cliente nem de conversa —
    // ele altera uma linha que já existe, achada por wa_message_id.
    if (conteudo.efeito) {
      await this.receiverHandler({
        waMessageId,
        telefone: '',
        origem: deMim ? 'atendente' : 'cliente',
        recebidoEm,
        efeito: conteudo.efeito,
        autorWaJid: msg.key?.participant ?? undefined,
      });
      return;
    }

    let telefone: string;
    let autorWaJid: string | undefined;
    let autorNome: string | undefined;
    let nomeGrupo: string | undefined;

    if (ehGrupo) {
      // O "telefone" de um grupo é o ID do JID — NÃO é número de ninguém.
      // hub.clientes.tipo_chat='grupo' marca isso, e o front já esconde o
      // valor quando ele não parece telefone (ehTelefoneValido).
      telefone = jidOrigemBruto.split('@')[0];
      autorWaJid = msg.key?.participant ?? msg.participant ?? undefined;
      // pushName num grupo é o nome de QUEM FALOU, não o do grupo — é isso
      // que aparece acima da bolha, como no WhatsApp.
      autorNome = deMim ? undefined : msg.pushName?.trim() || undefined;
      nomeGrupo = await this.assuntoDoGrupo(jidOrigemBruto);
    } else {
      // WhatsApp roteia parte dos contatos (contas Business, perfis já
      // migrados) por um JID "@lid" opaco em vez de "@s.whatsapp.net" — o
      // texto antes do "@" nesse caso NÃO é um telefone. Quando o JID é
      // @lid, o Baileys já decodifica o telefone real (quando o provedor o
      // expõe) em `msg.key.remoteJidAlt` (na 7.x; era `senderPn` na 6.x —
      // mesmo dado, alimentado pelo attr `sender_pn` do stanza) — cai no ID
      // cru como fallback só se não vier.
      const ehLid = jidOrigemBruto.endsWith('@lid');
      telefone = ehLid
        ? (msg.key?.remoteJidAlt?.split('@')[0] ?? jidOrigemBruto.split('@')[0])
        : jidOrigemBruto.split('@')[0];
    }
    if (!telefone) return;

    // fromMe = mensagem enviada pelo próprio celular pareado (fora do app do
    // Hub). Precisa entrar na thread como saída do atendente — senão a
    // conversa fica com buraco toda vez que o vendedor responde direto pelo
    // telefone. Idempotência por wa_message_id cobre o eco do que o backend
    // já enviou via enviar().
    await this.receiverHandler({
      waMessageId,
      telefone,
      texto: conteudo.texto,
      tipo: conteudo.tipo,
      midia: conteudo.midia,
      reobterRefMidia: conteudo.midia ? () => this.reobterRefMidia(msg) : undefined,
      conteudoExtra: conteudo.conteudoExtra,
      citandoWaId: conteudo.citandoWaId,
      origem: deMim ? 'atendente' : 'cliente',
      recebidoEm,
      // Em conversa individual, pushName é o nome de exibição de quem ASSINOU
      // a mensagem — quando fromMe, é o nome do próprio atendente/celular
      // pareado, não do cliente. services/mensagens.ts é quem decide não usar
      // isto fora de origem 'cliente'; aqui só repassa. Em grupo, quem nomeia
      // a conversa é o ASSUNTO do grupo, que não depende de quem falou.
      nomeContato: ehGrupo ? nomeGrupo : msg.pushName?.trim() || undefined,
      ehGrupo,
      nomeGrupo,
      autorWaJid,
      autorNome,
      waJidOrigem: jidOrigemBruto,
    });
  }

  async desconectar(opcoes?: { preservarSessao?: boolean }): Promise<void> {
    // Cancela reconexão pendente sempre — um desconectar explícito não
    // pode deixar um timer de backoff reabrir o socket segundos depois.
    if (this.timerReconexao) {
      clearTimeout(this.timerReconexao);
      this.timerReconexao = undefined;
    }
    if (!this.socket) return;
    this.encerrandoIntencionalmente = true;
    if (opcoes?.preservarSessao) {
      // Fechamento local, não protocolar: `end()` fecha o WebSocket sem
      // mandar o "remove-companion-device" que `logout()` envia — as
      // credenciais em hub.canal_sessoes continuam válidas, então o
      // próximo conectar() (reconectarCanaisAoSubir, no boot) reabre sem
      // pedir QR de novo. Ver nota em port.ts sobre por que isto importa
      // especificamente aqui: este branch só é chamado pelo shutdown
      // gracioso do processo, nunca por uma ação explícita do usuário.
      this.socket.end(undefined);
      await registrarEvento(this.canalId, 'desconectado', { motivo: 'shutdown_processo' });
      this.socket = undefined;
      // 'instavel', NÃO 'desconectado' — e este `return` existe para não cair
      // no trecho comum lá embaixo, que gravaria 'desconectado' por cima.
      //
      // Causa raiz das quedas periódicas (diagnóstico 2026-08-14): este ramo
      // existe justamente para PRESERVAR a sessão, mas gravava
      // 'desconectado' no banco — e reconectarCanaisAoSubir() (registry.ts)
      // só reconecta o que o banco diz estar recuperável. Ou seja: toda
      // saída limpa do processo apagava a própria condição que faria o boot
      // seguinte reconectar, e o mecanismo só funcionava quando o processo
      // morria SUJO (SIGKILL/OOM) — o oposto do desenhado. Como o Cloud Run
      // manda SIGTERM em escala-a-zero, reciclagem de instância e
      // manutenção (não só em deploy), a linha caía sozinha de madrugada e
      // não voltava até alguém clicar.
      //
      // 'instavel' é a descrição honesta do estado: credencial válida em
      // hub.canal_sessoes, socket fora do ar temporariamente. O valor já
      // existe no CHECK de hub.canais.conexao_status — nenhuma migration.
      this.statusAtual = 'instavel';
      await atualizarStatusCanal(this.canalId, 'instavel');
      return;
    }

    // Desligamento EXPLÍCITO do usuário: logout de protocolo, aparelho
    // desvinculado, credencial morta. Aqui 'desconectado' é a verdade.
    await this.socket.logout().catch(() => undefined);
    await registrarEvento(this.canalId, 'logout', { motivo: 'usuario' });
    this.socket = undefined;
    this.statusAtual = 'desconectado';
    await atualizarStatusCanal(this.canalId, 'desconectado');
  }

  async status(): Promise<StatusConexao> {
    return this.statusAtual;
  }

  async enviar(msg: EnvioMensagem): Promise<ResultadoEnvio> {
    if (!this.socket) {
      return { waMessageId: '', status: 'falhou', erro: 'canal não conectado' };
    }
    try {
      // Preferir o JID técnico salvo (hub.clientes.wa_jid) — é o único jeito
      // correto de alcançar um contato roteado por "@lid" (ver §1 do plano
      // de correção). Reconstruir por dígitos só serve para contatos ainda
      // sem wa_jid capturado (compat com dados antigos).
      const jid = msg.waJidDestino ?? `${msg.telefone.replace(/\D/g, '')}@s.whatsapp.net`;

      // GUARDA DE GRUPO: um JID de grupo NUNCA pode ser reconstruído a partir
      // de dígitos — o resultado seria "<id-do-grupo>@s.whatsapp.net", que o
      // WhatsApp entrega a UM participante em conversa privada. Ou seja: a
      // resposta que o atendente escreveu para o grupo chegaria em particular
      // para uma pessoa só, sem ninguém perceber. Recusar é o comportamento
      // seguro (auditoria A-05 do plano).
      if (!msg.waJidDestino && msg.telefone.length > 15) {
        return {
          waMessageId: '',
          status: 'falhou',
          erro: 'Conversa de grupo sem JID técnico salvo — não é possível responder com segurança.',
        };
      }

      const conteudo = montarConteudoEnvio(msg);
      const enviado = await this.socket.sendMessage(jid, conteudo);
      if (!enviado?.key?.id) {
        return { waMessageId: '', status: 'falhou', erro: 'Baileys não retornou message id' };
      }
      return { waMessageId: enviado.key.id, status: 'enviada' };
    } catch (err) {
      return { waMessageId: '', status: 'falhou', erro: err instanceof Error ? err.message : String(err) };
    }
  }

  aoReceber(handler: (evento: EventoRecebido) => Promise<void>): void {
    this.receiverHandler = handler;
  }

  /**
   * "digitando..." antes do envio (ChannelPort.sinalizarDigitando).
   *
   * Nao e disfarce: no WhatsApp o indicador de digitacao e parte da
   * conversa, e uma mensagem longa que aparece instantaneamente e ruido de
   * interface. Quem calcula a duracao e services/ritmoDisparo.ts, que tem
   * piso e teto.
   *
   * Nunca lanca: presenca e cosmetica e nao pode impedir a mensagem.
   */
  async sinalizarDigitando(telefone: string, duracaoMs: number, waJidDestino?: string): Promise<void> {
    if (!this.socket) return;
    const jid = waJidDestino ?? `${telefone.replace(/\D/g, '')}@s.whatsapp.net`;
    try {
      await this.socket.presenceSubscribe(jid);
      await this.socket.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, Math.max(0, duracaoMs)));
      await this.socket.sendPresenceUpdate('paused', jid);
    } catch {
      // Silencio proposital — ver doc do metodo.
    }
  }
}

/* A GUARDA QUE EXISTIA AQUI
 * -------------------------
 * Ate 31/08/2026 este arquivo exportava `bloquearDisparoEmMassa()`, que
 * recusava disparo em massa por Baileys, com o trigger
 * `hub.impede_disparo_baileys` como segunda camada no banco.
 *
 * A campanha decidiu, por escrito, correr esse risco: ver §1.1 de
 * docs/PLANO_CAMPANHA_INDIARA.md. Baileys e cliente nao oficial e volume
 * atipico numa linha nova e o gatilho classico de ban — a decisao foi
 * tomada com chip dedicado e chip reserva ja habilitado.
 *
 * As duas camadas nao viraram zero. No lugar entraram, na Fase 1,
 * guarda-corpos de outra natureza — que protegem a PESSOA do outro lado em
 * vez do numero da campanha:
 *   · hub.impede_alvo_opt_out          (nunca enfileirar quem pediu para sair)
 *   · hub.impede_disparo_sem_base_legal (base legal declarada por destinatario)
 *   · hub.confere_teto_diario           (teto do dia conferido no banco)
 * mais a reconferencia de opt-out NO INSTANTE do envio, em
 * jobs/disparador.ts, e a janela/rampa/intervalo de
 * services/ritmoDisparo.ts.
 *
 * Se algum dia esta plataforma voltar a ter um canal `twilio` para massa,
 * a trava de transporte volta como ESCOLHA por canal, nao como proibicao
 * global. */
