-- =====================================================================
-- FASE 5 (teste de pareamento real) — hub.eventos_canal no Realtime
-- =====================================================================
--
-- A tela de conectar canal do front precisa ler o QR real assim que o
-- Baileys emite (channels/baileys.adapter.ts grava em hub.eventos_canal,
-- tipo='qr_gerado', detalhe->>'qr') via Realtime — é o contrato do
-- plano-base §5 ("backend devolve 202, resultado chega por Realtime").
--
-- 20260731000200_hub_realtime.sql só publicou hub.conversas e
-- hub.mensagens (o que existia na hora em que foi escrita — eventos_canal
-- só nasceu na migration seguinte, 20260731000300). Sem isto, a assinatura
-- `postgres_changes` do front em hub.eventos_canal não recebe nada: a
-- tabela grava normal, só não propaga.
--
-- Não precisa de `replica identity full`: eventos_canal é append-only
-- (só INSERT — não há política de update/delete para ninguém, nem update/
-- delete em código), e INSERT sempre carrega a linha inteira no WAL
-- independente da replica identity. A ressalva de custo de WAL que
-- 20260731000200 registra para `replica identity full` é sobre
-- update/delete, não se aplica aqui.
-- =====================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'Publicação `supabase_realtime` não existe neste projeto — mesma falha fechada '
      'de 20260731000200_hub_realtime.sql.';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'eventos_canal'
  ) then
    raise notice 'já publicada: hub.eventos_canal';
  else
    alter publication supabase_realtime add table hub.eventos_canal;
    raise notice 'publicada: hub.eventos_canal';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'eventos_canal'
  ) then
    raise exception 'Realtime incompleto: hub.eventos_canal não está na publicação.';
  end if;
  raise notice '=== OK: hub.eventos_canal publicada no Realtime. ===';
end $$;

commit;
