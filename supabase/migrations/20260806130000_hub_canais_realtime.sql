-- =====================================================================
-- FASE 5 (teste de pareamento real) — hub.canais no Realtime
-- =====================================================================
--
-- O semáforo da lista de canais (front, TabCanais) precisa refletir
-- `conexao_status` no instante em que o Baileys muda (channels/
-- baileys.adapter.ts -> atualizarStatusCanal()), não só quando o
-- usuário reabre a tela ou clica em algo que dispara um refetch manual.
-- Mesmo contrato de 20260806120000 (eventos_canal): backend grava,
-- Realtime propaga, front nunca faz polling.
--
-- Não precisa de `replica identity full`: o front só consome o valor
-- NOVO de conexao_status/ultima_conexao (INSERT/UPDATE sempre carregam a
-- linha nova inteira, com qualquer replica identity); ninguém depende do
-- valor ANTERIOR em UPDATE nem de DELETE nesta tabela.
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
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'canais'
  ) then
    raise notice 'já publicada: hub.canais';
  else
    alter publication supabase_realtime add table hub.canais;
    raise notice 'publicada: hub.canais';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'canais'
  ) then
    raise exception 'Realtime incompleto: hub.canais não está na publicação.';
  end if;
  raise notice '=== OK: hub.canais publicada no Realtime. ===';
end $$;

commit;
