-- ROLLBACK de 20260809120000_hub_meu_perfil_ativo.sql
--
-- ⚠️ NUNCA cole este arquivo junto com o de aplicação. Um rollback rodado por
-- engano já custou um ciclo inteiro neste projeto.
--
-- Restaura a versão ORIGINAL de hub.meu_perfil() — resolução por e-mail, sem
-- filtro de `ativo`. Ao rodar isto, atendente com `ativo = false` e perfil
-- 'admin' volta a ter acesso administrativo total via RLS.
--
-- Antes de reverter, considere a alternativa mais provável: se alguém perdeu
-- acesso indevidamente, o certo costuma ser reativar a pessoa
--   update hub.atendentes set ativo = true where id = '<id>';
-- e não devolver o furo para todo mundo.

begin;

create or replace function hub.meu_perfil()
returns text
language sql
stable
security definer
set search_path = hub, public
as $$
  select a.perfil from hub.atendentes a
  where lower(a.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
  limit 1
$$;

revoke all on function hub.meu_perfil() from public;
grant execute on function hub.meu_perfil() to authenticated, service_role;

do $$
declare v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'hub' and p.proname = 'meu_perfil';
  if position('auth.users' in v_src) = 0 then
    raise exception 'rollback não pegou — hub.meu_perfil() não voltou a resolver por e-mail.';
  end if;
  raise notice '=== OK: hub.meu_perfil() revertida para a versão por e-mail (SEM filtro de ativo). ===';
end $$;

commit;
