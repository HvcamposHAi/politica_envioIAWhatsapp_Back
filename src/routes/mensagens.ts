// POST /conversas/:id/mensagens — envio pelo atendente via app (plano-base
// §5, miolo do fluxo de mensagem). Mesma regra de ouro de canais.ts: 202 e
// pronto, o estado real (entregue/lida) chega por Realtime via update de
// hub.mensagens.status_entrega — não implementado nesta rota (webhook de
// status é trabalho futuro; aqui só gravamos o resultado imediato de
// canal.enviar()).
import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';
import { requireSupabaseAuth } from '../auth/middleware.js';
import { supabaseAdmin } from '../db/client.server.js';
import { obterOuCriarCanal } from '../channels/registry.js';
import { buscarAtendenteAutenticado, conversaNoEscopo, type AtendenteRow } from '../auth/escopoConversa.js';
import { marcarPrimeiraResposta } from '../services/mensagens.js';
import { extensaoDe } from '../channels/mensagemWhatsApp.js';
import { midiaConfigurada, montarCaminho, subirBuffer, urlAssinada } from '../services/midiaStorage.js';
import { converterParaNotaDeVoz } from '../services/audioVoz.js';

export const mensagensRouter = Router();
mensagensRouter.use(requireSupabaseAuth());

/** Teto de upload. Batido nas DUAS pontas (o front também barra) — aqui é a
 *  barreira de verdade; lá é a cortesia de avisar antes de subir 16 MB. */
const TAMANHO_MAXIMO_MB = Number(process.env.MIDIA_TAMANHO_MAX_MB ?? 16);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAMANHO_MAXIMO_MB * 1024 * 1024, files: 1 },
});

/**
 * Multer reporta erro chamando `next(err)`, NÃO lançando — então o try/catch do
 * handler nunca o vê, e um arquivo acima do limite cairia no handler padrão do
 * Express: 500 com HTML, que o front mostra como "Backend respondeu 500".
 * Envolver aqui é o que transforma isso num 413 com a explicação certa.
 */
const receberArquivo: RequestHandler = (req, res, next) => {
  upload.single('arquivo')(req, res, (err: unknown) => {
    if (!err) return next();
    const codigo = (err as { code?: string }).code;
    if (codigo === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `Arquivo acima do limite de ${TAMANHO_MAXIMO_MB} MB.` });
      return;
    }
    if (codigo === 'LIMIT_FILE_COUNT' || codigo === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({ error: 'Envie um arquivo por vez.' });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : 'Falha ao ler o arquivo enviado.' });
  });
};

/** Extensões que não trafegam pelo Hub em nenhuma hipótese. O bucket é
 *  privado e serve com Content-Disposition, mas redistribuir um executável
 *  pela ferramenta de atendimento da empresa é responsabilidade que não se
 *  assume por descuido. */
const EXTENSOES_BLOQUEADAS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'vbs', 'js', 'jse',
  'wsf', 'wsh', 'ps1', 'jar', 'apk', 'dll', 'lnk',
]);

type ClasseMidia = 'imagem' | 'video' | 'audio' | 'voz' | 'documento';

function classeDoMime(mime: string): ClasseMidia {
  const base = mime.split('/')[0]?.toLowerCase();
  if (base === 'image') return 'imagem';
  if (base === 'video') return 'video';
  if (base === 'audio') return 'audio';
  return 'documento';
}

/** Tipo da mensagem gravado em hub.mensagens.tipo_mensagem. */
function tipoDaClasse(classe: ClasseMidia): string {
  return classe;
}

interface ConversaComEscopo {
  id: string;
  canal_id: string;
  cliente_id: string;
  /* Dono e setor: o escopo passou a ser por atendente, não por empresa
   * (2026-08-17). conversaNoEscopo() exige as duas. */
  atendente_id: string | null;
  setor_id: string | null;
  setores: { empresa_id: string | null } | null;
  canais: { empresa_id: string | null } | null;
}

/** Prólogo comum: atendente por tabela + conversa dentro do escopo dele.
 *  Mesmo formato de retorno de autorizarCanal() em routes/canais.ts. */
async function autorizarConversa(
  userId: string,
  conversaId: string,
): Promise<{ atendente: AtendenteRow; conversa: ConversaComEscopo } | { erro: number; mensagem: string }> {
  const atendente = await buscarAtendenteAutenticado(userId);
  if (!atendente) {
    return { erro: 403, mensagem: 'Usuário autenticado não corresponde a um atendente ativo em hub.atendentes.' };
  }
  const { data: conversa, error } = await supabaseAdmin
    .from('conversas')
    .select('id, canal_id, cliente_id, atendente_id, setor_id, setores(empresa_id), canais(empresa_id)')
    .eq('id', conversaId)
    .maybeSingle<ConversaComEscopo>();
  if (error) return { erro: 500, mensagem: error.message };
  if (!conversa) return { erro: 404, mensagem: 'Conversa não encontrada.' };
  if (!(await conversaNoEscopo(atendente, conversa))) {
    return { erro: 403, mensagem: 'Conversa fora do escopo deste atendente.' };
  }
  return { atendente, conversa };
}

interface MensagemComMidia {
  id: string;
  conversa_id: string | null;
  midia_objeto: string | null;
  midia_thumb_objeto: string | null;
  midia_nome: string | null;
  midia_tipo: string | null;
  midia_status: string;
  tipo_mensagem: string;
}

/**
 * URL assinada de leitura da mídia de UMA mensagem.
 *
 * A URL é gerada a cada pedido, com validade curta, e NUNCA é persistida —
 * uma URL assinada gravada em coluna apodrece em minutos e a mídia "some".
 *
 * O escopo é revalidado aqui, e não só na listagem: sem esta checagem,
 * qualquer atendente autenticado poderia ler a mídia de qualquer empresa
 * chutando ids (o backend usa service_role e não passa pela RLS).
 */
mensagensRouter.get('/mensagens/:id/midia', async (req, res) => {
  try {
    const { data: mensagem, error } = await supabaseAdmin
      .from('mensagens')
      .select('id, conversa_id, midia_objeto, midia_thumb_objeto, midia_nome, midia_tipo, midia_status, tipo_mensagem')
      .eq('id', req.params.id)
      .maybeSingle<MensagemComMidia>();
    if (error) return res.status(500).json({ error: error.message });
    if (!mensagem) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!mensagem.conversa_id) return res.status(404).json({ error: 'Mensagem sem conversa.' });

    const autorizado = await autorizarConversa(req.auth!.userId, mensagem.conversa_id);
    if ('erro' in autorizado) return res.status(autorizado.erro).json({ error: autorizado.mensagem });

    const miniatura = req.query.thumb === '1';
    const objeto = miniatura ? mensagem.midia_thumb_objeto : mensagem.midia_objeto;
    if (!objeto) {
      // 409 e não 404: a mensagem existe, o arquivo é que ainda não está
      // pronto (ou falhou). O front usa isso para manter o estado de
      // "carregando" em vez de mostrar "não encontrado".
      return res.status(409).json({ error: 'Arquivo ainda não disponível.', status: mensagem.midia_status });
    }

    const { url, expiraEm } = await urlAssinada(objeto, {
      nomeDownload: req.query.baixar === '1' ? (mensagem.midia_nome ?? undefined) : undefined,
      // O tipo decide inline vs. attachment (midiaStorage.podeServirInline).
      // Sem ele o default é attachment, e o player de áudio/vídeo do
      // navegador para de funcionar.
      tipoMime: mensagem.midia_tipo ?? undefined,
    });
    res.status(200).json({
      url,
      expiraEm,
      nome: mensagem.midia_nome,
      tipo: mensagem.midia_tipo,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Envio de arquivo/áudio pelo atendente.
 *
 * Rota SEPARADA de POST /conversas/:id/mensagens de propósito: multipart e
 * JSON não convivem bem no mesmo handler, e — mais importante — a rota de
 * texto é o caminho crítico do atendimento, que não deve herdar o risco de
 * uma feature de upload.
 *
 * Ordem: valida → sobe ao bucket → envia ao WhatsApp → grava a linha. Subir
 * antes de enviar é o que permite o reenvio sem novo upload
 * (POST /mensagens/:id/reenviar).
 */
mensagensRouter.post('/conversas/:id/midia', receberArquivo, async (req, res) => {
  try {
    if (!midiaConfigurada()) {
      return res.status(503).json({
        error: 'Envio de arquivos não está configurado neste servidor (GCS_BUCKET_MIDIA).',
      });
    }
    const arquivo = req.file;
    if (!arquivo?.buffer?.length) {
      return res.status(400).json({ error: 'Nenhum arquivo recebido.' });
    }

    const conversaId = req.params.id;
    const autorizado = await autorizarConversa(req.auth!.userId, conversaId);
    if ('erro' in autorizado) return res.status(autorizado.erro).json({ error: autorizado.mensagem });
    const { atendente, conversa } = autorizado;

    const legenda = typeof req.body?.legenda === 'string' ? req.body.legenda.trim() : '';
    const ehVoz = req.body?.ehVoz === 'true' || req.body?.ehVoz === true;
    const duracaoSeg = Number(req.body?.duracaoSeg) || undefined;

    // Tipo REAL por magic bytes. O Content-Type do multipart é escrito pelo
    // navegador (ou por quem estiver chamando a rota) e não prova nada — um
    // .exe renomeado para .pdf chega como application/pdf.
    const detectado = await fileTypeFromBuffer(arquivo.buffer);
    const nomeOriginal = arquivo.originalname?.trim() || 'arquivo';
    const mimeReal = detectado?.mime ?? arquivo.mimetype ?? 'application/octet-stream';
    const extensao = detectado?.ext ?? extensaoDe(mimeReal, nomeOriginal);

    if (EXTENSOES_BLOQUEADAS.has(extensao.toLowerCase())) {
      return res.status(415).json({
        error: `Arquivos .${extensao} não podem ser enviados pelo Hub. Compacte em .zip se precisar entregá-lo.`,
      });
    }

    let buffer = arquivo.buffer;
    let mime = mimeReal;
    let classe: ClasseMidia = ehVoz ? 'voz' : classeDoMime(mimeReal);

    if (ehVoz) {
      // Sem esta conversão, o áudio gravado no navegador (webm/opus) chega ao
      // celular do cliente como anexo que muitos Androids não tocam — ver
      // services/audioVoz.ts.
      try {
        const convertido = await converterParaNotaDeVoz(arquivo.buffer);
        buffer = convertido.buffer;
        mime = 'audio/ogg; codecs=opus';
      } catch (err) {
        return res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } else if (classe === 'audio' && !detectado) {
      // Áudio que nem o detector reconheceu: manda como documento, que é
      // honesto, em vez de um player que não vai tocar.
      classe = 'documento';
    }

    const { data: cliente, error: erroCliente } = await supabaseAdmin
      .from('clientes')
      .select('telefone, wa_jid')
      .eq('id', conversa.cliente_id)
      .single<{ telefone: string; wa_jid: string | null }>();
    if (erroCliente || !cliente) {
      return res.status(500).json({ error: erroCliente?.message ?? 'Cliente da conversa não encontrado.' });
    }

    const empresaId = conversa.canais?.empresa_id ?? conversa.setores?.empresa_id;
    if (!empresaId) {
      return res.status(500).json({ error: 'Conversa sem empresa resolvível — não é possível guardar o arquivo.' });
    }

    // Chave do objeto: para SAÍDA ainda não existe wa_message_id (ele só nasce
    // quando o WhatsApp aceita), então um uuid faz o papel.
    const chaveObjeto = randomUUID();
    const caminho = montarCaminho({
      empresaId,
      conversaId,
      waMessageId: chaveObjeto,
      extensao: ehVoz ? 'ogg' : extensao,
    });
    const tamanho = await subirBuffer(caminho, buffer, { tipoMime: mime, nomeArquivo: nomeOriginal });

    const canal = await obterOuCriarCanal(conversa.canal_id);
    const resultado = await canal.enviar({
      conversaId,
      telefone: cliente.telefone,
      waJidDestino: cliente.wa_jid ?? undefined,
      texto: legenda || undefined,
      midiaBuffer: buffer,
      // Baileys manda o binário; Twilio precisa de uma URL que ela busque.
      // Mandar os dois deixa o adapter escolher sem a rota saber o transporte.
      midiaObjeto: caminho,
      midiaTipo: mime,
      midiaClasse: classe,
      midiaNome: nomeOriginal,
      midiaDuracaoSeg: duracaoSeg,
    });

    const { data: mensagem, error: erroInsert } = await supabaseAdmin
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        wa_message_id: resultado.waMessageId || null,
        autor: 'atendente',
        atendente_id: atendente.id,
        direcao: 'saida',
        texto: legenda,
        tipo_mensagem: tipoDaClasse(classe),
        midia_objeto: caminho,
        midia_tipo: mime,
        midia_nome: nomeOriginal,
        midia_tamanho: tamanho || buffer.length,
        midia_duracao_seg: duracaoSeg ?? null,
        // 'pronta' já no insert: o arquivo é NOSSO, subiu antes de o WhatsApp
        // ver — não há download pendente como acontece na entrada.
        midia_status: 'pronta',
        status_entrega: resultado.status === 'enviada' ? 'enviada' : 'falhou',
        erro: resultado.erro ?? null,
      })
      .select('id')
      .single<{ id: string }>();

    if (erroInsert || !mensagem) {
      return res.status(500).json({
        error: `Envio ${resultado.status} no canal, mas falhou ao gravar hub.mensagens: ${erroInsert?.message ?? 'sem dados'}`,
      });
    }

    // Mesma assimetria fechada da rota de texto: a conversa sobe na lista e
    // deixa de estar não lida para quem acabou de responder.
    await supabaseAdmin
      .from('conversas')
      .update({ atualizado_em: new Date().toISOString(), nao_lidas: 0 })
      .eq('id', conversaId);

    if (resultado.status === 'enviada') await marcarPrimeiraResposta(conversaId);

    res.status(202).json({
      status: 'accepted',
      mensagemId: mensagem.id,
      waMessageId: resultado.waMessageId || undefined,
      envio: resultado.status,
      erro: resultado.erro,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Reenvia uma mensagem de mídia que já está no bucket.
 *
 * Existe para que "Reenviar" numa bolha vermelha de arquivo não obrigue o
 * atendente a subir 15 MB de novo — e para que o reenvio continue possível
 * depois de recarregar a página, quando o front já não tem mais o arquivo em
 * memória.
 */
mensagensRouter.post('/mensagens/:id/reenviar', async (req, res) => {
  try {
    const { data: mensagem, error } = await supabaseAdmin
      .from('mensagens')
      .select('id, conversa_id, midia_objeto, midia_nome, midia_tipo, midia_status, tipo_mensagem, texto, midia_duracao_seg')
      .eq('id', req.params.id)
      .maybeSingle<MensagemComMidia & { texto: string; midia_duracao_seg: number | null }>();
    if (error) return res.status(500).json({ error: error.message });
    if (!mensagem?.conversa_id) return res.status(404).json({ error: 'Mensagem não encontrada.' });
    if (!mensagem.midia_objeto) {
      return res.status(400).json({ error: 'Esta mensagem não tem arquivo para reenviar.' });
    }

    const autorizado = await autorizarConversa(req.auth!.userId, mensagem.conversa_id);
    if ('erro' in autorizado) return res.status(autorizado.erro).json({ error: autorizado.mensagem });
    const { conversa } = autorizado;

    const { data: cliente } = await supabaseAdmin
      .from('clientes')
      .select('telefone, wa_jid')
      .eq('id', conversa.cliente_id)
      .single<{ telefone: string; wa_jid: string | null }>();
    if (!cliente) return res.status(500).json({ error: 'Cliente da conversa não encontrado.' });

    const { baixarBuffer } = await import('../services/midiaStorage.js');
    const buffer = await baixarBuffer(mensagem.midia_objeto);

    const canal = await obterOuCriarCanal(conversa.canal_id);
    const resultado = await canal.enviar({
      conversaId: mensagem.conversa_id,
      telefone: cliente.telefone,
      waJidDestino: cliente.wa_jid ?? undefined,
      texto: mensagem.texto || undefined,
      midiaBuffer: buffer,
      midiaObjeto: mensagem.midia_objeto,
      midiaTipo: mensagem.midia_tipo ?? 'application/octet-stream',
      midiaClasse: (mensagem.tipo_mensagem as ClasseMidia) ?? 'documento',
      midiaNome: mensagem.midia_nome ?? 'arquivo',
      midiaDuracaoSeg: mensagem.midia_duracao_seg ?? undefined,
    });

    await supabaseAdmin
      .from('mensagens')
      .update({
        wa_message_id: resultado.waMessageId || null,
        status_entrega: resultado.status === 'enviada' ? 'enviada' : 'falhou',
        erro: resultado.erro ?? null,
      })
      .eq('id', mensagem.id);

    if (resultado.status === 'enviada') await marcarPrimeiraResposta(mensagem.conversa_id);

    res.status(202).json({ status: 'accepted', mensagemId: mensagem.id, envio: resultado.status });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

mensagensRouter.post('/conversas/:id/mensagens', async (req, res) => {
  try {
    const conversaId = req.params.id;
    const { texto, midiaUrl, midiaTipo, respondendoA } = (req.body ?? {}) as {
      texto?: string;
      midiaUrl?: string;
      midiaTipo?: string;
      respondendoA?: string;
    };

    if (!texto && !midiaUrl) {
      return res.status(400).json({ error: 'Informe texto ou midiaUrl.' });
    }

    // REGRA DE OURO do plano-base: atendente resolvido por tabela
    // (user_id = req.auth.userId), nunca por e-mail nem por claim do JWT.
    const atendente = await buscarAtendenteAutenticado(req.auth!.userId);
    if (!atendente) {
      return res.status(403).json({ error: 'Usuário autenticado não corresponde a um atendente ativo em hub.atendentes.' });
    }

    const { data: conversa, error: erroConversa } = await supabaseAdmin
      .from('conversas')
      .select('id, canal_id, cliente_id, atendente_id, setor_id, setores(empresa_id), canais(empresa_id)')
      .eq('id', conversaId)
      .maybeSingle<ConversaComEscopo>();

    if (erroConversa) {
      return res.status(500).json({ error: erroConversa.message });
    }
    if (!conversa) {
      return res.status(404).json({ error: 'Conversa não encontrada.' });
    }

    if (!(await conversaNoEscopo(atendente, conversa))) {
      return res.status(403).json({ error: 'Conversa fora do escopo deste atendente.' });
    }

    const { data: cliente, error: erroCliente } = await supabaseAdmin
      .from('clientes')
      .select('telefone, wa_jid')
      .eq('id', conversa.cliente_id)
      .single<{ telefone: string; wa_jid: string | null }>();

    if (erroCliente || !cliente) {
      return res.status(500).json({ error: erroCliente?.message ?? 'Cliente da conversa não encontrado em hub.clientes.' });
    }

    const canal = await obterOuCriarCanal(conversa.canal_id);
    const resultado = await canal.enviar({
      conversaId,
      telefone: cliente.telefone,
      waJidDestino: cliente.wa_jid ?? undefined,
      texto,
      midiaUrl,
      midiaTipo,
      respondendoA,
    });

    const { data: mensagem, error: erroInsert } = await supabaseAdmin
      .from('mensagens')
      .insert({
        conversa_id: conversaId,
        // '' vira null: o índice único de wa_message_id é parcial (where not
        // null) — string vazia colidiria entre dois envios que falharam.
        wa_message_id: resultado.waMessageId || null,
        autor: 'atendente',
        atendente_id: atendente.id,
        direcao: 'saida',
        texto: texto ?? '',
        midia_url: midiaUrl ?? null,
        midia_tipo: midiaTipo ?? null,
        status_entrega: resultado.status === 'enviada' ? 'enviada' : 'falhou',
        erro: resultado.erro ?? null,
        respondendo_a: respondendoA ?? null,
      })
      .select('id')
      .single<{ id: string }>();

    if (erroInsert || !mensagem) {
      return res.status(500).json({
        error: `Envio ${resultado.status} no canal, mas falhou ao gravar hub.mensagens: ${erroInsert?.message ?? 'sem dados'}`,
      });
    }

    // Fecha a assimetria com o fluxo de entrada (services/mensagens.ts):
    // conversa respondida pelo app também sobe na lista, e o atendente que
    // acabou de responder não continua com a conversa marcada como não
    // lida para si mesmo. Independe do resultado do envio — a ação de
    // responder já aconteceu do lado do atendente mesmo se o canal falhar.
    // Bookkeeping secundário: loga e ainda devolve 202, não derruba a
    // resposta já enviada/gravada por causa disto.
    const { error: erroAtualizarConversa } = await supabaseAdmin
      .from('conversas')
      .update({ atualizado_em: new Date().toISOString(), nao_lidas: 0 })
      .eq('id', conversaId);

    if (erroAtualizarConversa) {
      // eslint-disable-next-line no-console
      console.error(`falha ao atualizar hub.conversas após resposta (conversa=${conversaId}):`, erroAtualizarConversa.message);
    }

    // Primeira resposta — SÓ quando a mensagem saiu de verdade (auditoria
    // 2026-08-09, item 4). A regra vem da Caixa, que já a documentava: marcar
    // com o canal recusando o envio gravava "respondido no prazo" para um
    // cliente que não recebeu nada. Agora ela mora aqui, onde `resultado.status`
    // é conhecido, e o front deixou de escrever nesta coluna — o valor volta
    // para a tela pelo Realtime de hub.conversas.
    if (resultado.status === 'enviada') await marcarPrimeiraResposta(conversaId);

    // mensagemId: chave que o front usa pra trocar a bolha otimista pela
    // linha real (reconciliação por id, não por texto — texto repetido tipo
    // "ok" quebraria o match). waMessageId só vem preenchido quando o canal
    // aceitou de fato; em falha (`resultado.status === 'falhou'`) a linha
    // existe em hub.mensagens mesmo assim, só sem wa_message_id.
    res.status(202).json({
      status: 'accepted',
      mensagemId: mensagem.id,
      waMessageId: resultado.waMessageId || undefined,
      envio: resultado.status,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
