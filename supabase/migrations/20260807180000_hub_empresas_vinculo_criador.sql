-- =====================================================================
-- Vínculo automático do criador ao criar uma empresa + backfill
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- CRUD de empresas (20260807120000) abriu criação pela UI. `cu.empresas`
-- no front (multi-whats-magic/src/lib/current-user.ts) — que alimenta o
-- switcher do header e os seletores de Configurações — não é "toda
-- empresa que existe", é "toda empresa que o atendente logado tem um
-- vínculo explícito em hub.atendente_empresas". Criar uma empresa pela
-- tela só fazia INSERT em hub.empresas; nada criava esse vínculo para o
-- admin que criou. Resultado observado em produção: empresa "teste"
-- criada, visível na aba Empresas (RLS deixa admin ver tudo), mas ausente
-- do switcher do header e do seletor "em qual empresa" de Configurações.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · Nenhuma policy de RLS muda — só dados (atendente_empresas) e um
--     trigger novo em hub.empresas.
--   · Backfill só concede vínculo a atendentes que já tinham acesso via
--     RLS mesmo (admin bypassa tudo por hub.sou_admin()) — não é
--     permissão nova, só materializa o que já era verdade.
-- =====================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception 'Schema `hub` não existe. Abortando.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Trigger: quem cria uma empresa ganha vínculo automático nela.
--    Guarda contra hub.meu_atendente_id() nulo — se uma empresa for
--    criada fora de um contexto autenticado normal, não deve travar o
--    INSERT em hub.empresas.
-- ---------------------------------------------------------------------
create or replace function hub.concede_acesso_criador_empresa()
returns trigger
language plpgsql
security definer
set search_path = hub, public
as $$
declare
  v_atendente uuid := hub.meu_atendente_id();
begin
  if v_atendente is not null then
    insert into hub.atendente_empresas (atendente_id, empresa_id)
    values (v_atendente, new.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function hub.concede_acesso_criador_empresa() from public, anon, authenticated;

drop trigger if exists trg_empresas_concede_acesso_criador on hub.empresas;
create trigger trg_empresas_concede_acesso_criador
  after insert on hub.empresas
  for each row
  execute function hub.concede_acesso_criador_empresa();

-- ---------------------------------------------------------------------
-- 2. Backfill: corrige agora quem já ficou sem vínculo. Só afeta
--    atendentes com perfil = 'admin'.
-- ---------------------------------------------------------------------
insert into hub.atendente_empresas (atendente_id, empresa_id)
select a.id, e.id
from hub.atendentes a
cross join hub.empresas e
where a.perfil = 'admin' and a.ativo
  and not exists (
    select 1 from hub.atendente_empresas ae
    where ae.atendente_id = a.id and ae.empresa_id = e.id
  )
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. Mesmo backfill para atendente não-admin com acesso_todas_empresas
--    = true, só se essa coluna já existir (migration
--    20260806150000_hub_atendentes_acesso_multiempresa.sql pode ou não
--    ter sido aplicada ainda) — não falha se a coluna não existir.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes'
      and column_name = 'acesso_todas_empresas'
  ) then
    insert into hub.atendente_empresas (atendente_id, empresa_id)
    select a.id, e.id
    from hub.atendentes a
    cross join hub.empresas e
    where a.acesso_todas_empresas
      and not exists (
        select 1 from hub.atendente_empresas ae
        where ae.atendente_id = a.id and ae.empresa_id = e.id
      )
    on conflict do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_empresas_concede_acesso_criador' and not tgisinternal
  ) then
    raise exception 'trigger de vínculo automático não foi criado — migration incompleta.';
  end if;
  if exists (
    select 1 from hub.empresas e
    where e.ativo
      and not exists (
        select 1 from hub.atendentes a
        join hub.atendente_empresas ae on ae.atendente_id = a.id and ae.empresa_id = e.id
        where a.perfil = 'admin'
      )
  ) then
    raise exception 'ainda existe empresa ativa sem nenhum admin vinculado — backfill incompleto.';
  end if;
  raise notice '=== OK: trigger criado e backfill aplicado — toda empresa ativa agora tem pelo menos 1 admin vinculado. ===';
end $$;

commit;

-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select e.nome, a.nome as admin_vinculado
--    from hub.empresas e
--    join hub.atendente_empresas ae on ae.empresa_id = e.id
--    join hub.atendentes a on a.id = ae.atendente_id
--    where a.perfil = 'admin'
--    order by e.nome;
--    -> toda empresa deve aparecer ao menos uma vez.
--
-- 2. select tgname from pg_trigger
--    where tgname = 'trg_empresas_concede_acesso_criador' and not tgisinternal;
--    -> deve retornar 1 linha.
--
-- 3. Se algo falhar: aplicar
--    20260807180000_hub_empresas_vinculo_criador_rollback.sql
-- =====================================================================
