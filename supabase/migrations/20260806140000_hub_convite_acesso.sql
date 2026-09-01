-- =====================================================================
-- Convite de acesso para integrantes da equipe (hub.atendentes)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Hoje criar um integrante em Configurações -> Equipe só grava uma linha
-- em hub.atendentes; não existe nenhum caminho (tela ou backend) para
-- transformar isso num login de verdade. `hub.vincular_usuario`
-- (20260731000100_hub_funcoes_rls.sql) já existia para linkar
-- `user_id` <-> atendente por e-mail, mas nunca era chamada por nenhum
-- código, e não informava se o vínculo aconteceu ou não (`returns void`,
-- sem contagem de linhas). Esta migration:
--
--   1. Adiciona `convite_enviado_em` em hub.atendentes, para a tela
--      distinguir "sem acesso" de "convite enviado" (hoje só existe o
--      binário `user_id is null`).
--   2. Cria um índice único parcial em `user_id`, hoje sem nenhuma
--      restrição de unicidade — nada impede duas linhas de
--      hub.atendentes apontarem para o mesmo auth.users.
--   3. Recria `hub.vincular_usuario` como `returns boolean`, para o
--      backend (rota nova /atendentes/vincular) saber se o vínculo
--      realmente aconteceu, em vez de falhar em silêncio.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO
-- ---------------------------------------------------------------------
--   · Nenhuma policy de RLS muda — as novas rotas do backend usam o
--     cliente service_role (bypassa RLS), mesmo padrão já usado em
--     mensagens.ts.
--   · `atendentes_email_unico` (índice existente) não muda.
--   · GRANT de `hub.vincular_usuario` continua restrito a `service_role`.
--
-- ⚠️  PRÉ-REQUISITO antes de aplicar: rodar a query abaixo e confirmar
--     que devolve 0 linhas (senão o índice único do bloco 2 falha):
--
--       select user_id, count(*)
--       from hub.atendentes
--       where user_id is not null
--       group by user_id
--       having count(*) > 1;
--
-- ⚠️  AÇÃO FORA DESTE SQL (obrigatória para o link do convite funcionar):
--     no painel do Supabase, em Authentication -> URL Configuration ->
--     Redirect URLs, adicionar a URL do front terminando em
--     `/definir-senha` (produção e, se for testar local, localhost).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Guarda: abortar se rodar contra o projeto errado
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes' and column_name = 'user_id'
  ) then
    raise exception
      'hub.atendentes.user_id não existe — rodar antes as migrations '
      'base do Hub (20260731000000_hub_schema.sql e seguintes).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Rastrear quando um convite foi disparado. Não mexe em user_id.
-- ---------------------------------------------------------------------
alter table hub.atendentes
  add column if not exists convite_enviado_em timestamptz;

-- ---------------------------------------------------------------------
-- 2. Impedir que o mesmo auth.users fique vinculado a duas linhas de
--    atendentes. Parcial (where user_id is not null) para não travar
--    as linhas legadas, todas com user_id nulo hoje.
-- ---------------------------------------------------------------------
create unique index if not exists atendentes_user_id_unico
  on hub.atendentes (user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------
-- 3. Recriar hub.vincular_usuario com `returns boolean`, para o
--    chamador (backend) saber se o vínculo aconteceu. Mesma condição de
--    guarda de antes (`where user_id is null`) — não relinka quem já
--    tem vínculo.
-- ---------------------------------------------------------------------
drop function if exists hub.vincular_usuario(uuid, text);

create function hub.vincular_usuario(p_user_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = hub, public
as $$
declare
  v_linhas int;
begin
  update hub.atendentes
  set user_id = p_user_id
  where user_id is null
    and lower(email) = lower(p_email);
  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$$;

revoke all on function hub.vincular_usuario(uuid, text) from public, anon, authenticated;
grant execute on function hub.vincular_usuario(uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 4. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes'
      and column_name = 'convite_enviado_em'
  ) then
    raise exception 'convite_enviado_em não foi criada — migration incompleta.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'hub' and tablename = 'atendentes'
      and indexname = 'atendentes_user_id_unico'
  ) then
    raise exception 'atendentes_user_id_unico não foi criado — migration incompleta.';
  end if;

  if (select pg_get_function_result(oid) from pg_proc
      where proname = 'vincular_usuario'
        and pronamespace = 'hub'::regnamespace) <> 'boolean' then
    raise exception 'hub.vincular_usuario não está retornando boolean — migration incompleta.';
  end if;

  raise notice '=== OK: convite_enviado_em, índice único e vincular_usuario(boolean) aplicados. ===';
end $$;

commit;

-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select id, nome, email, user_id, convite_enviado_em
--    from hub.atendentes order by nome;
--    -> convite_enviado_em deve vir null para todo mundo (coluna nova).
--
-- 2. select hub.vincular_usuario('00000000-0000-0000-0000-000000000000',
--                                 'email-que-nao-existe@x.com');
--    -> deve devolver false.
--
-- 3. Depois do deploy do backend/front (rota /atendentes/vincular),
--    conferir que hub.atendentes.user_id dos admins que já usam o
--    sistema hoje (ex.: Humberto) foi preenchido no primeiro login
--    pós-deploy.
--
-- 4. Se algo falhar: aplicar
--    20260806140000_hub_convite_acesso_rollback.sql
-- =====================================================================
