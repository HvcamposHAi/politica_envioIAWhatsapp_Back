// Adapter Twilio — implementa ChannelPort (conversas 1:1, plano de
// implementação Twilio). Mesma conta (Account SID/Auth Token) usada pela
// Alice (Agente Assistente Comercial), número dedicado ao Hub — ver
// plano. Ao contrário do Baileys, não há socket persistente: Twilio é
// REST (enviar) + webhook HTTP (receber, em src/webhooks/twilio.ts).
//
// Disparo em massa (hub.disparos) fica fora do escopo desta passada —
// aqui só o caminho conversacional que espelha o Baileys.

import twilio, { Twilio } from 'twilio';
import { supabaseAdmin } from '../db/client.server.js';
import { normalizarTelefone } from '../services/mensagens.js';
import type {
  ChannelPort,
  EnvioMensagem,
  EventoRecebido,
  ResultadoEnvio,
  StatusConexao,
} from './port.js';

async function registrarEvento(canalId: string, tipo: string, detalhe?: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from('eventos_canal').insert({ canal_id: canalId, tipo, detalhe: detalhe ?? null });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao gravar hub.eventos_canal (canal=${canalId}, tipo=${tipo}):`, error.message);
  }
}

async function atualizarStatusCanal(canalId: string, status: StatusConexao) {
  const { error } = await supabaseAdmin
    .from('canais')
    .update({ conexao_status: status, ultima_conexao: status === 'conectado' ? new Date().toISOString() : undefined })
    .eq('id', canalId);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`falha ao atualizar hub.canais.conexao_status (canal=${canalId}, status=${status}):`, error.message);
  }
}

/** Prefixa E.164 com "whatsapp:", reaproveitando a mesma regra de dígitos de
 *  normalizarTelefone() (única fonte da regra — ver services/mensagens.ts).
 *  Trata tanto o telefone do cliente quanto hub.canais.numero (texto livre,
 *  ex. "+55 41 3333-1010"). */
function paraWhatsApp(bruto: string): string {
  return `whatsapp:+${normalizarTelefone(bruto)}`;
}

/** Seam de fábrica — existe só para o teste unitário poder mockar o cliente
 *  Twilio sem depender de internals do pacote. */
export function criarClienteTwilio(accountSid: string, authToken: string): Twilio {
  return twilio(accountSid, authToken);
}

export class TwilioChannel implements ChannelPort {
  readonly transporte = 'twilio' as const;
  private readonly client: Twilio;
  // Diferente do Baileys: sem socket para "desconectar" entre requests —
  // Twilio é REST+webhook stateless. Nasce 'conectado', não 'desconectado':
  // senão todo cold start do Cloud Run mostraria o canal como desconectado
  // no front até alguém clicar "reconectar", apesar de enviar/receber
  // funcionar normalmente por baixo.
  private statusAtual: StatusConexao = 'conectado';

  // Credenciais resolvidas por quem instancia (registry.ts, via
  // services/twilioCredenciais.ts) — este construtor não lê process.env
  // nem toca o Secret Manager diretamente, então continua síncrono.
  constructor(readonly canalId: string, private readonly numero: string, credenciais: { accountSid: string; authToken: string }) {
    this.client = criarClienteTwilio(credenciais.accountSid, credenciais.authToken);
  }

  async conectar(): Promise<void> {
    try {
      // Confirma que o par SID/token é válido. Checagem de capacidade
      // WhatsApp do número específico fica para uma passada futura — não é
      // pré-requisito pra este canal funcionar.
      await this.client.api.v2010.accounts(this.client.accountSid).fetch();
      this.statusAtual = 'conectado';
      await atualizarStatusCanal(this.canalId, 'conectado');
      await registrarEvento(this.canalId, 'conectado', { transporte: 'twilio', numero: this.numero, modo: 'credenciais_validadas' });
    } catch (err) {
      this.statusAtual = 'caido';
      await atualizarStatusCanal(this.canalId, 'caido');
      await registrarEvento(this.canalId, 'erro', { transporte: 'twilio', mensagem: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async desconectar(): Promise<void> {
    // Sem socket para fechar — "pausar" o canal: enviar() passa a recusar
    // enquanto statusAtual !== 'conectado'.
    this.statusAtual = 'desconectado';
    await atualizarStatusCanal(this.canalId, 'desconectado');
    await registrarEvento(this.canalId, 'desconectado', { transporte: 'twilio' });
  }

  async status(): Promise<StatusConexao> {
    return this.statusAtual;
  }

  async enviar(msg: EnvioMensagem): Promise<ResultadoEnvio> {
    if (this.statusAtual !== 'conectado') {
      return { waMessageId: '', status: 'falhou', erro: 'canal não conectado' };
    }
    try {
      // Mídia: a Twilio é REST e BUSCA o arquivo por HTTP — não aceita o
      // binário no corpo, ao contrário do Baileys. Por isso o envio de mídia
      // exige que o arquivo já esteja no bucket, e o que vai é uma URL
      // assinada de curta duração (a Twilio a baixa em segundos).
      let mediaUrl: string[] | undefined;
      if (msg.midiaObjeto) {
        const { urlAssinada } = await import('../services/midiaStorage.js');
        const { url } = await urlAssinada(msg.midiaObjeto, {
          ttlSeg: 600,
          tipoMime: msg.midiaTipo,
        });
        mediaUrl = [url];
      } else if (msg.midiaUrl) {
        mediaUrl = [msg.midiaUrl];
      } else if (msg.midiaBuffer) {
        return {
          waMessageId: '',
          status: 'falhou',
          erro: 'Linha oficial (Twilio) precisa do arquivo publicado antes do envio — arquivo não foi armazenado.',
        };
      }

      const enviado = await this.client.messages.create({
        to: paraWhatsApp(msg.telefone),
        from: paraWhatsApp(this.numero),
        body: msg.texto ?? '',
        ...(mediaUrl ? { mediaUrl } : {}),
      });
      return { waMessageId: enviado.sid, status: 'enviada' };
    } catch (err) {
      return { waMessageId: '', status: 'falhou', erro: err instanceof Error ? err.message : String(err) };
    }
  }

  aoReceber(_handler: (evento: EventoRecebido) => Promise<void>): void {
    // Twilio não empurra evento por aqui — mensagem de entrada chega via
    // webhook HTTP (src/webhooks/twilio.ts), que chama
    // processarEventoRecebido() direto, sem passar por este adapter.
    // Método mantido só para satisfazer ChannelPort.
  }
}
