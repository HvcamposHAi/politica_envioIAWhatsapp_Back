// Mesmo incidente de src/auth/middleware.websocket.test.ts, segundo call
// site: `supabaseAdmin` é um singleton preguiçoso (Proxy) que só constrói o
// client real no primeiro acesso a uma propriedade — precisa do mesmo
// `realtime.transport` ou lança "native WebSocket not found" na primeira
// query que qualquer rota fizer via service_role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('supabaseAdmin sob Node sem WebSocket global (repro do incidente 2026-08-07)', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeAll(() => {
    process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_teste';
  });

  afterAll(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('não lança ao construir o client real no primeiro acesso a uma propriedade', async () => {
    // @ts-expect-error - simula Node 20, que não tem WebSocket global
    delete globalThis.WebSocket;

    const { supabaseAdmin } = await import('./client.server.js');

    expect(() => supabaseAdmin.from).not.toThrow();
  });
});
