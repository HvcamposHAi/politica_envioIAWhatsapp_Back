import { Router } from 'express';

// GET /health — liveness (plano-base §4.5, §5). Uptime check do Cloud Run
// e checagem da rede interna do worker apontam para aqui.
export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'agrotimbo_hubwhatsapp_bkend', ts: new Date().toISOString() });
});
