-- =====================================================================
-- ROLLBACK de 20260808220000_hub_conversas_coach.sql
-- =====================================================================
--
-- NÃO EXECUTE ISTO JUNTO DA MIGRATION. No SQL Editor do Supabase, um script
-- carregado no editor e um script executado devolvem exatamente a mesma coisa
-- ("Success. No rows returned") — em 08/08/2026 um rollback rodou por engano
-- logo depois da migration e o estado só apareceu na conferência ampliada.
-- Antes de rodar: limpe o editor e cole APENAS este arquivo.
--
-- Seguro a qualquer momento: nada no schema depende destas colunas — sem FK,
-- sem índice, sem view, sem constraint. Com as colunas removidas e o código
-- novo ainda no ar, o UPDATE do coach falha e vai para analise_ia_erro; o
-- front trata ausência como lista vazia e simplesmente não mostra a faixa.
-- Sentimento, risco e banner continuam funcionando.
-- =====================================================================

begin;

alter table hub.conversas
  drop column if exists coach_sugestoes,
  drop column if exists coach_orientacoes,
  drop column if exists coach_atualizado_em;

do $$
declare
  sobrando text;
begin
  select string_agg(column_name, ', ')
    into sobrando
  from information_schema.columns
  where table_schema = 'hub' and table_name = 'conversas'
    and column_name in ('coach_sugestoes', 'coach_orientacoes', 'coach_atualizado_em');
  if sobrando is not null then
    raise exception 'colunas do coach ainda existem em hub.conversas: % — rollback incompleto.', sobrando;
  end if;
  raise notice '=== OK: colunas do coach removidas de hub.conversas. ===';
end $$;

commit;
