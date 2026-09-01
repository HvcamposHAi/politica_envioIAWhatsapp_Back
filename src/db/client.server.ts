// Movido do front (multi-whats-magic/src/integrations/supabase/client.server.ts)
// na ejeção do Lovable, Fase 3.8. Confirmado sem nenhum importador no front
// antes da mudança (`grep -rn "supabaseAdmin" src/` só retornava auto-referência
// dentro do próprio arquivo) — a aposta do plano-base de que a fatia seria
// trivial se confirmou.
//
// Cliente Supabase com service_role — ignora RLS. Só para operações de
// confiança do backend (worker Baileys, jobs, rotas /ia, /disparos).
// NUNCA importar isto de código que também é servido ao navegador.
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type { Database } from './types.js';

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }

    // Chaves novas do Supabase são strings opacas, não bearer JWT.
    if (isNewSupabaseApiKey(supabaseKey) && headers.get('Authorization') === `Bearer ${supabaseKey}`) {
      headers.delete('Authorization');
    }

    headers.set('apikey', supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

function createSupabaseAdminClient() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
      ...(!SUPABASE_SERVICE_ROLE_KEY ? ['SUPABASE_SERVICE_ROLE_KEY'] : []),
    ];
    throw new Error(
      `Variável(is) de ambiente do Supabase faltando: ${missing.join(', ')}. ` +
      'Configurar via Secret Manager (sa-hub-api / sa-hub-worker), não em texto plano.',
    );
  }

  // Segundo type param explícito: com `Database = any` (placeholder, ver
  // ./types.ts), o TS não infere o nome do schema a partir de `db.schema`
  // e trava no default `'public'`. Regenerar types.ts com o schema real
  // deve permitir remover este explicit.
  //
  // `realtime.transport`: mesmo motivo do client de auth.middleware.ts —
  // createClient() monta um RealtimeClient eager que exige WebSocket
  // global, inexistente no Node 20 desta imagem. Sem isto, a primeira
  // propriedade acessada em `supabaseAdmin` (proxy lazy abaixo) lança
  // "native WebSocket not found" (incidente 2026-08-07).
  return createClient<Database, 'hub'>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    // Tabelas do Hub vivem em `hub`, não em `public` (ERP + Alice).
    db: { schema: 'hub' },
    global: {
      fetch: createSupabaseFetch(SUPABASE_SERVICE_ROLE_KEY),
    },
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
    // Ver comentário equivalente em auth/middleware.ts sobre o `as any`:
    // atrito de tipos entre os overloads de `ws` e WebSocketLikeConstructor,
    // não incompatibilidade real (testado em runtime, client.server.test.ts).
    realtime: { transport: WebSocket as any },
  });
}

let _supabaseAdmin: ReturnType<typeof createSupabaseAdminClient> | undefined;

// SEGURANÇA: só use isto em código de servidor de confiança. Nunca
// reexportar por uma rota que também compõe HTML para o navegador.
export const supabaseAdmin = new Proxy({} as ReturnType<typeof createSupabaseAdminClient>, {
  get(_, prop, receiver) {
    if (!_supabaseAdmin) _supabaseAdmin = createSupabaseAdminClient();
    return Reflect.get(_supabaseAdmin, prop, receiver);
  },
});
