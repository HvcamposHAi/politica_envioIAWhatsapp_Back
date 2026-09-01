-- 20260808230000_hub_conversas_aberta_em_idx_rollback.sql
-- Desfaz 20260808230000_hub_conversas_aberta_em_idx.sql.
--
-- Rodar isto NÃO quebra a feature: o índice só melhora o plano de execução do
-- contexto da Alice, nenhum código depende de ele existir.

begin;

drop index if exists hub.conversas_aberta_em_idx;

do $$
begin
  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'hub' and c.relname = 'conversas_aberta_em_idx'
  ) then
    raise exception 'FALHOU: hub.conversas_aberta_em_idx ainda existe ao fim do rollback';
  end if;
end $$;

commit;
