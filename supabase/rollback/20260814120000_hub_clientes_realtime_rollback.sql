-- ROLLBACK de 20260814120000_hub_clientes_realtime.sql
--
-- ATENÇÃO: tirar hub.clientes da publicação com o front novo no ar não
-- quebra a Caixa, mas devolve o defeito relatado — o nome do contato volta
-- a só aparecer depois de sair e voltar da tela. Só rode isto se a
-- publicação estiver causando problema de WAL/carga, e prefira reverter o
-- front junto.

begin;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'clientes'
  ) then
    alter publication supabase_realtime drop table hub.clientes;
    raise notice 'removida da publicação: hub.clientes';
  else
    raise notice 'nada a fazer: hub.clientes não estava publicada';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'clientes'
  ) then
    raise exception 'rollback incompleto: hub.clientes ainda está na publicação.';
  end if;
  raise notice 'rollback de hub.clientes no Realtime OK.';
end $$;

commit;
