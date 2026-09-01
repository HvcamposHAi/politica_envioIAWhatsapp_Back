// Adaptado de multi-whats-magic/src/integrations/supabase/auth-middleware.ts
// na ejeção do Lovable (Fase 3.8) — reescrito para Express, não copiado.
//
// O ORIGINAL usava `createMiddleware` do @tanstack/react-start e `getRequest()`
// do runtime do TanStack Start. São APIs de framework SSR — não existem fora
// dele. "Vira middleware Express" (plano-base §3.2) exigia reescrita, não
// port mecânico.
//
// MÉTODO DE VALIDAÇÃO — por que `getClaims()` via chamada à API, e não
// verificação local com `jose`:
// O plano-base descreve a stack de auth como "JWT do Supabase validado com
// jose" (§5, checklist da Fase 5). Mas o código ORIGINAL, já em produção no
// protótipo, não usa jose — ele delega a validação para
// `supabase.auth.getClaims(token)`, que chama a API do Supabase. Preservei o
// método verificado (este arquivo já existia e funcionava) em vez de trocar
// por uma implementação nova de verificação local de JWT (HS256 com JWT
// secret, ou JWKS) que eu não teria como testar sem acesso ao segredo do
// projeto — que não foi extraído desta sessão de propósito: é credencial
// mais sensível que anon/service_role e não deveria ser puxada só para
// escrever este arquivo.
//
// Migrar para verificação local com `jose` é otimização legítima (evita uma
// chamada de rede por request), mas é troca de método com custo de teste
// próprio — não fazer no mesmo commit que a ejeção.
//
// REGRA DE OURO do plano-base: resolver atendente por TABELA, nunca pelo
// JWT. Este middleware para no `userId`/`claims` do Supabase Auth; a
// resolução de `hub.atendentes` por e-mail é responsabilidade de quem
// consome `req.auth` depois (rotas), não deste arquivo.

import type { NextFunction, Request, Response } from 'express';
import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type { Database } from '../db/types.js';

export interface AuthContext {
  userId: string;
  claims: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

// Exportado para routes/conta.ts, que precisa de um client anônimo próprio
// (ele valida a senha atual com signInWithPassword). Sem isto seria a
// TERCEIRA cópia do mesmo tratamento de apikey no repo — a segunda vive em
// db/client.server.ts.
export function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof globalThis.Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    if (isNewSupabaseApiKey(supabaseKey) && headers.get('Authorization') === `Bearer ${supabaseKey}`) {
      headers.delete('Authorization');
    }
    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

/**
 * Middleware Express: exige `Authorization: Bearer <jwt>` válido do
 * Supabase Auth. Em sucesso, popula `req.auth = { userId, claims }`.
 *
 * Não resolve perfil/atendente — isso é decisão de rota, consultando
 * `hub.atendentes` por e-mail (nunca confiar em claim de perfil do JWT).
 */
export function requireSupabaseAuth() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      'Variável(is) de ambiente do Supabase faltando (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY). ' +
      'Configurar via Secret Manager antes de montar este middleware.',
    );
  }

  return async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).json({ error: 'Unauthorized: no authorization header provided' });
      }
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: only Bearer tokens are supported' });
      }

      const token = authHeader.replace('Bearer ', '');
      if (!token || token.split('.').length !== 3) {
        return res.status(401).json({ error: 'Unauthorized: invalid token' });
      }

      // Ver nota equivalente em db/client.server.ts sobre o explicit 'hub'.
      //
      // `realtime.transport`: o construtor de SupabaseClient monta um
      // RealtimeClient mesmo quando nada aqui usa realtime, e este último
      // resolve seu WebSocket de forma síncrona e eager (getWebSocketConstructor
      // em @supabase/realtime-js). Em Node 20 (a imagem de runtime deste
      // serviço, ver Dockerfile) não existe WebSocket global — sem este
      // `transport` explícito, createClient() lança na hora e todo request
      // autenticado vira 401 (incidente 2026-08-07, "native WebSocket not
      // found"). `ws` supre esse construtor.
      const supabase = createClient<Database, 'hub'>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        db: { schema: 'hub' },
        global: {
          fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY),
          headers: { Authorization: `Bearer ${token}` },
        },
        auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        // `as any`: os overloads de construtor de `ws` (inclui modo
        // servidor com `address: null`) não casam estruturalmente com o
        // tipo WebSocketLikeConstructor de @supabase/realtime-js — atrito
        // de tipos entre pacotes, não incompatibilidade real. A própria
        // realtime-js documenta `ws` como implementação suportada para
        // Node, e middleware.websocket.test.ts prova em runtime que
        // funciona sem WebSocket global.
        realtime: { transport: WebSocket as any },
      });

      const { data, error } = await supabase.auth.getClaims(token);
      if (error || !data?.claims) {
        // Incidente 2026-08-07: um cold start do hub-api (ou qualquer soluço
        // de rede até a API de Auth do Supabase) fazia getClaims() falhar e
        // caía direto aqui como "token inválido" — o front (chamarBackend)
        // via isso como sessão morta e deslogava o admin inteiro por um
        // problema deste serviço, não do usuário. isAuthRetryableFetchError
        // é como o próprio @supabase/supabase-js marca esse tipo de falha
        // (fetch/DNS/timeout — ver auth-js/lib/fetch.js), distinto de um
        // token genuinamente rejeitado (AuthApiError/AuthInvalidJwtError).
        // 503 é retryable e não implica sessão inválida; só 401 deveria.
        if (error && isAuthRetryableFetchError(error)) {
          console.error('[auth] getClaims falhou por erro de rede/infra (retryable):', error.name, error.message);
          return res
            .status(503)
            .json({ error: 'Serviço de autenticação temporariamente indisponível. Tente novamente.' });
        }
        console.error('[auth] getClaims rejeitou o token:', error?.name, error?.message);
        return res.status(401).json({ error: 'Unauthorized: invalid token' });
      }
      if (!data.claims.sub) {
        console.error('[auth] token validado sem claim "sub".');
        return res.status(401).json({ error: 'Unauthorized: no user ID found in token' });
      }

      req.auth = { userId: data.claims.sub as string, claims: data.claims as Record<string, unknown> };
      next();
    } catch (err) {
      console.error('[auth] erro inesperado no middleware:', err instanceof Error ? err.message : String(err));
      if (isAuthRetryableFetchError(err)) {
        return res
          .status(503)
          .json({ error: 'Serviço de autenticação temporariamente indisponível. Tente novamente.' });
      }
      // Falha fechada: qualquer outro erro inesperado na validação é 401,
      // não passagem silenciosa.
      res.status(401).json({ error: 'Unauthorized', detail: err instanceof Error ? err.message : String(err) });
    }
  };
}
