-- =====================================================================
-- 20260809120000_hub_meu_perfil_ativo.sql
-- Auditoria 2026-08-09, item 2.
-- =====================================================================
--
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- `hub.meu_perfil()` nasceu em 20260731000100 resolvendo o atendente por
-- e-mail, sem filtrar `ativo` — enquanto `hub.meu_atendente_id()`, escrita no
-- mesmo arquivo, filtra `ativo` e prefere o vínculo explícito por `user_id`.
-- As duas funções de identidade divergiram, com duas consequências:
--
--   1. ATENDENTE DESLIGADO CONTINUA ADMIN. `ativo = false` mata
--      meu_atendente_id() e minhas_empresas(), mas não meu_perfil() — então
--      hub.sou_admin() segue devolvendo true e a RLS libera leitura e escrita
--      em TODAS as tabelas de TODAS as empresas. O comentário do schema diz
--      que `ativo` existe justamente para "excluir atendente desligado da
--      resolução de identidade"; a função de perfil ficou de fora.
--      O backend não é afetado (usa service_role e checa `ativo` em
--      buscarAtendenteAutenticado); o front, que fala direto com o PostgREST
--      sob RLS, é.
--
--   2. ADMIN COM E-MAIL TROCADO NO AUTH PERDE O PERFIL. meu_atendente_id()
--      casa por user_id; meu_perfil() só por e-mail. Trocar o e-mail no
--      auth.users mantinha a identidade e zerava o perfil, em silêncio.
--
-- A correção é derivar o perfil de meu_atendente_id(), herdando as duas regras
-- de uma vez. O fallback por e-mail (primeiro login, antes de
-- hub.vincular_usuario gravar o vínculo) NÃO é perdido — ele mora dentro de
-- meu_atendente_id().
--
-- IMPACTO: hub.sou_admin() lê daqui, e sou_admin() aparece em ~20 policies.
-- Rode o DIAGNÓSTICO abaixo ANTES de aplicar — cada linha devolvida é uma
-- pessoa que perde acesso administrativo:
--
--   select a.id, a.nome, a.email, a.perfil, a.ativo
--   from hub.atendentes a
--   where a.perfil in ('admin','supervisor')
--     and (a.ativo = false or a.ativo is null);
--
-- Rollback: 20260809120000_hub_meu_perfil_ativo_rollback.sql
-- =====================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'hub' and p.proname = 'meu_atendente_id'
  ) then
    raise exception 'hub.meu_atendente_id() não existe — pré-requisito ausente.';
  end if;
end $$;

create or replace function hub.meu_perfil()
returns text
language sql
stable
security definer
set search_path = hub, public
as $$
  -- Deriva de meu_atendente_id() de propósito: era a ÚNICA função de
  -- identidade que não filtrava `ativo` nem preferia user_id sobre e-mail.
  select a.perfil from hub.atendentes a where a.id = hub.meu_atendente_id()
$$;

-- create or replace preserva grants; reafirmados por segurança.
revoke all on function hub.meu_perfil() from public;
grant execute on function hub.meu_perfil() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Autovalidação. Qualquer asserção falhando aborta a transação inteira.
-- "Success. No rows returned" não prova nada — a prova é a NOTICE final.
-- ---------------------------------------------------------------------
do $$
declare
  v_src  text;
  v_sec  boolean;
  v_vol  char;
  v_cfg  text[];
  v_auth boolean;
begin
  select p.prosrc, p.prosecdef, p.provolatile, p.proconfig
    into v_src, v_sec, v_vol, v_cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'hub' and p.proname = 'meu_perfil';

  if v_src is null then
    raise exception 'hub.meu_perfil() sumiu depois do replace.';
  end if;
  if position('meu_atendente_id' in v_src) = 0 then
    raise exception 'hub.meu_perfil() NÃO passou a usar meu_atendente_id() — corpo: %', v_src;
  end if;
  if position('auth.users' in v_src) > 0 then
    raise exception 'hub.meu_perfil() ainda resolve por auth.users — replace não pegou.';
  end if;
  if not v_sec then
    raise exception 'hub.meu_perfil() perdeu SECURITY DEFINER.';
  end if;
  if v_vol <> 's' then
    raise exception 'hub.meu_perfil() deixou de ser STABLE (volatile=%).', v_vol;
  end if;
  if v_cfg is null or not (v_cfg @> array['search_path=hub, public']) then
    raise exception 'hub.meu_perfil() sem search_path fixo — proconfig: %', v_cfg;
  end if;

  select has_function_privilege('authenticated', 'hub.meu_perfil()', 'EXECUTE')
    into v_auth;
  if not v_auth then
    raise exception 'authenticated perdeu EXECUTE em hub.meu_perfil().';
  end if;

  raise notice '=== OK: hub.meu_perfil() agora deriva de meu_atendente_id(), SECURITY DEFINER + STABLE + search_path fixo, EXECUTE preservado. ===';
end $$;

commit;
