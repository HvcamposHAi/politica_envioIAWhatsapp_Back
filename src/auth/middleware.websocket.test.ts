// Teste pontual do incidente 2026-08-07 ("Convidar" 401 em produção):
// createClient() do @supabase/supabase-js monta um RealtimeClient eager que
// exige WebSocket global — ausente no Node 20 (a imagem de runtime deste
// serviço, ver Dockerfile). Sem o `transport` explícito, createClient()
// lançava "Node.js detected but native WebSocket not found" na hora, e o
// catch-all de requireSupabaseAuth() virava 401 para todo request.
//
// Este teste NÃO mocka @supabase/supabase-js (diferente de middleware.test.ts)
// porque precisa exercitar a construção real do client — é exatamente esse
// construtor que quebrava.
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

describe('createClient() sob Node sem WebSocket global (repro do incidente 2026-08-07)', () => {
  const originalWebSocket = globalThis.WebSocket;

  afterAll(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('lança "native WebSocket not found" sem a opção transport (comportamento pré-patch)', () => {
    // @ts-expect-error - simula Node 20, que não tem WebSocket global
    delete globalThis.WebSocket;

    expect(() =>
      createClient('https://exemplo.supabase.co', 'sb_publishable_teste', {
        db: { schema: 'hub' },
        auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      }),
    ).toThrow(/native WebSocket not found/);
  });

  it('não lança quando `realtime.transport` é fornecido (patch aplicado em middleware.ts e client.server.ts)', () => {
    // @ts-expect-error - simula Node 20, que não tem WebSocket global
    delete globalThis.WebSocket;

    expect(() =>
      createClient('https://exemplo.supabase.co', 'sb_publishable_teste', {
        db: { schema: 'hub' },
        auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        realtime: { transport: WebSocket as any },
      }),
    ).not.toThrow();
  });
});
