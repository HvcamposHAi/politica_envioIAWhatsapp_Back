// Entry point do backend (plano-base §5): Express + helmet + rate limit.
//
// STATUS (Fase 5 fechando): server, /health, /canais/* e
// /conversas/:id/mensagens sobem de verdade e compilam contra os tipos
// reais do Baileys instalado. O miolo do fluxo de mensagem (aoReceber ->
// services/mensagens.ts -> hub.mensagens) está ligado. O adapter Baileys em
// si (channels/baileys.adapter.ts) NÃO foi testado contra um número real —
// pareamento por QR exige telefone físico e ambiente ao vivo. O que falta,
// escopo de fases seguintes:
//   · URA (Fase 6)
//   · Fase 7 (resumo de IA do chamado): feita, mas não como o comentário
//     antigo previa — não tem ai/anthropic.ts nem /ia/analisar. É
//     services/resumoIA.ts (disparo automático por mensagem, via
//     services/mensagens.ts) + POST /conversas/:id/resumo/gerar
//     (routes/resumo.ts, regeneração manual). Ver plano "Resumo de IA no
//     Kanban de Chamados".
//   · jobs/ (campanhas, reengajamento, health-check) (Fase 8)
//   · /conversas/:id/transferir, /disparos

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { healthRouter } from './routes/health.js';
import { canaisRouter } from './routes/canais.js';
import { mensagensRouter } from './routes/mensagens.js';
import { avaliacaoRouter } from './routes/avaliacao.js';
import { aliceRouter } from './routes/alice.js';
import { coachRouter } from './routes/coach.js';
import { resumoRouter } from './routes/resumo.js';
import { atendentesRouter } from './routes/atendentes.js';
import { contaRouter } from './routes/conta.js';
import { configuracoesRouter } from './routes/configuracoes.js';
import { twilioWebhookRouter } from './webhooks/twilio.js';
import { desconectarTodosOsCanais, reconectarCanaisAoSubir } from './channels/registry.js';
import { iniciarVarreduraMidia } from './services/filaMidia.js';
import { iniciarVigiaDeCanais } from './jobs/vigiaCanais.js';
import { iniciarVigiaSemDono } from './jobs/vigiaSemDono.js';

const PORT = Number(process.env.PORT ?? 8081);

// O front (multi-whats-magic, TanStack Start/Vite) chama estas rotas
// direto do navegador com fetch() — sujeito a CORS, ao contrário de
// server function/SSR. Origem por env var, não hardcoded: dev aponta pro
// Vite local, produção aponta pro domínio real do front. Sem CORS_ORIGIN
// configurada, cai no default de dev (localhost:8080, porta do
// `vite dev` deste projeto) — é conveniência de ambiente local, não
// decisão de segurança; a barreira de verdade continua sendo o Bearer
// JWT que requireSupabaseAuth() exige em cada rota.
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? 'http://localhost:8080').split(',').map((o) => o.trim());

const app = express();

// Cloud Run termina TLS antes do container e é o único proxy na frente
// dele — sempre um hop de X-Forwarded-For, do próprio load balancer do
// Cloud Run. Sem isto, express-rate-limit rejeita toda requisição com
// ValidationError (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) por não confiar
// no XFF por padrão — foi o que derrubou hub-api-00003-26z (500 em toda
// rota) até esta linha ser adicionada. "1" = confia só no hop mais
// próximo (o próprio Cloud Run), não em XFF arbitrário de mais longe.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN, methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type'] }));
app.use(express.json({ limit: '2mb' }));
// Twilio manda webhook como application/x-www-form-urlencoded, não JSON.
// Parser é ativado por content-type — não interfere nas rotas JSON acima.
app.use(express.urlencoded({ extended: false }));

// Webhooks da Twilio: montados ANTES do rate limit global de propósito —
// têm cota própria (twilioWebhookRouter, ver webhooks/twilio.ts) e não
// devem competir com nem ser limitados pelos 300/min da API autenticada.
// Também não passam por requireSupabaseAuth() — a Twilio não tem JWT do
// Supabase; a barreira lá é a assinatura X-Twilio-Signature.
//
// Prefixo OBRIGATÓRIO aqui: twilioWebhookRouter.use(...) (rate limit +
// validarAssinatura, dentro de webhooks/twilio.ts) não tem path próprio,
// então roda pra QUALQUER rota que passar por este router. Montado sem
// prefixo (app.use(twilioWebhookRouter), como estava antes), isso
// derrubava /health, /canais/*, /conversas/*/mensagens e /atendentes/*
// inteiros com 500/403 — confirmado em produção (hub-api-00003-26z,
// 2026-08-07 11:44-11:48, revertido). Com o prefixo, Express só entra
// neste router para requisições que já começam com /webhooks/twilio.
app.use('/webhooks/twilio', twilioWebhookRouter);

// Rate limit global conservador. Rate limit POR LINHA (A9.3, anti-ban do
// WhatsApp) é uma preocupação diferente e vive perto do ChannelPort, não
// aqui — este é só proteção da API em si contra abuso.
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(healthRouter);
app.use(canaisRouter);
app.use(mensagensRouter);
app.use(avaliacaoRouter);
app.use(aliceRouter);
app.use(coachRouter);
app.use(resumoRouter);
app.use(atendentesRouter);
app.use(contaRouter);
app.use(configuracoesRouter);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`agrotimbo_hubwhatsapp_bkend ouvindo na porta ${PORT}`);
});

// Reconecta os canais Baileys que estavam ativos antes deste processo
// subir (incidente 2026-08-07: sem isto, todo restart do Cloud Run — um
// deploy normal incluído — parava de receber mensagens até alguém notar
// e reconectar manualmente). Fire-and-forget: /health fica de pé mesmo
// enquanto as linhas ainda estão reconectando, e uma falha aqui não deve
// derrubar o boot do servidor HTTP.
void reconectarCanaisAoSubir();

// Rede de segurança da fila de mídia, que é em memória por design: todo
// deploy do Cloud Run é um restart, e um download interrompido no meio
// deixaria a bolha em "carregando" para sempre. A varredura reenfileira o que
// ficou para trás usando hub.mensagens.midia_ref (ver services/filaMidia.ts).
iniciarVarreduraMidia();

// Vigia de canais: a cada 60s confere se o que o banco diz que deveria estar
// conectado de fato está, e reconecta o que divergir. Sem isto, a única
// verificação viva do sistema era o poll do front — que só roda com um admin
// olhando a tela de Configurações (ver src/jobs/vigiaCanais.ts).
iniciarVigiaDeCanais();

// Vigia de conversas sem dono: a cada 5 min conta a fila que passou de 15
// minutos e registra COM O SETOR no log. Contrapartida da regra de acesso de
// 2026-08-17 — o operador deixou de ver a fila "Sem dono", e quem responde por
// ela agora e o gestor da area e o admin. O contador na Caixa so alcanca quem
// esta com a tela aberta; isto alcanca a madrugada e o fim de semana.
// Ver src/jobs/vigiaSemDono.ts e PLANO_GOVERNANCA_ACESSOS.md §7.4.
iniciarVigiaSemDono();

// Graceful shutdown (plano-base §4.4): fechar sockets do Baileys antes de
// matar o processo, senão o WhatsApp marca desconexão suja — direto
// relevante para deploy no Cloud Run/VM, onde SIGTERM é como a
// plataforma pede para o processo sair.
async function desligarComCalma(sinal: string) {
  // eslint-disable-next-line no-console
  console.log(`${sinal} recebido, desconectando canais antes de sair...`);
  await desconectarTodosOsCanais();
  server.close(() => process.exit(0));
  // Timeout de segurança: não travar o deploy esperando indefinidamente.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void desligarComCalma('SIGTERM'));
process.on('SIGINT', () => void desligarComCalma('SIGINT'));

// Backstop de resiliência (incidente 2026-08-07, terceira ocorrência da
// mesma classe): exceção não capturada vinda de DENTRO de uma lib (ex.:
// falha de autenticação AES no noise-handler do Baileys, lançada no
// handler de 'message' do WebSocket — fora de qualquer try/catch nosso)
// derruba o processo INTEIRO, e com ele TODAS as linhas de WhatsApp, não
// só a sessão doente. Num gateway stateful multi-linha, o dano de seguir
// com um socket possivelmente inconsistente é muito menor que o de matar
// todas as linhas: o socket doente morre sozinho (close/timeout) e a
// reconexão por backoff ou a guarda de staleness o substituem.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('uncaughtException — processo segue de pé; socket doente será substituído:', err);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('unhandledRejection — processo segue de pé:', reason);
});
