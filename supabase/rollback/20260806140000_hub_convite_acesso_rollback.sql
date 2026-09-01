-- =====================================================================
-- ROLLBACK — reverte 20260806140000_hub_convite_acesso.sql
-- =====================================================================
--
-- Reverte a coluna `convite_enviado_em`, o índice único de `user_id` e
-- recria `hub.vincular_usuario` na versão antiga (`returns void`).
--
-- ⚠️  Rodar SOMENTE se a validação pós-aplicação falhar. Como o índice
--     do bloco 2 é parcial e não tinha nenhuma linha para violar no
--     momento em que foi criado (pré-requisito da migration original),
--     este rollback é fiel — não há perda de dado além do que a própria
--     migration adicionou (a coluna nova e o índice).
-- =====================================================================

begin;

drop index if exists hub.atendentes_user_id_unico;

alter table hub.atendentes
  drop column if exists convite_enviado_em;

drop function if exists hub.vincular_usuario(uuid, text);

create function hub.vincular_usuario(p_user_id uuid, p_email text)
returns void
language sql
security definer
set search_path = hub, public
as $$
  update hub.atendentes
  set user_id = p_user_id
  where user_id is null
    and lower(email) = lower(p_email)
$$;

revoke all on function hub.vincular_usuario(uuid, text) from public, anon, authenticated;
grant execute on function hub.vincular_usuario(uuid, text) to service_role;

commit;

-- ---------------------------------------------------------------------
-- Remover o registro da migration, para poder reaplicar depois
--    Rodar SÓ se a migration original foi aplicada via `supabase db push`.
-- ---------------------------------------------------------------------
-- delete from supabase_migrations.schema_migrations
-- where version = '20260806140000';
