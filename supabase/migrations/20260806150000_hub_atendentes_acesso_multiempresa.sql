-- =====================================================================
-- Acesso multiempresa por atendente (hub.atendentes.acesso_todas_empresas)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Configurações -> Equipe cadastrava, na prática, um atendente por
-- empresa: dar acesso à mesma pessoa em duas empresas exigia duas linhas
-- em hub.atendentes (dois "cadastros" para uma pessoa só), porque a tela
-- só sabia gravar UMA empresa por integrante ao criar. `hub.atendente_empresas`
-- (N:N) já existia por baixo e já era a fonte que RLS e o backend liam,
-- mas nada na UI expunha "esta pessoa acessa todas as empresas / só a X /
-- X e Y" — e nada garantia que alguém marcado como "acesso total" continuasse
-- com acesso total quando uma empresa nova fosse cadastrada depois.
--
-- Esta migration:
--
--   1. Adiciona `hub.atendentes.acesso_todas_empresas boolean`, para a
--      tela guardar a INTENÇÃO do admin (não só o resultado materializado
--      em atendente_empresas).
--   2. Cria um trigger em hub.empresas: toda vez que uma empresa nova é
--      inserida, todo atendente com acesso_todas_empresas = true ganha
--      automaticamente uma linha em atendente_empresas para ela. Sem
--      isso, "acesso a todas as empresas" descreveria só as empresas que
--      existiam no momento em que foi marcado — ficaria desatualizado a
--      cada empresa nova.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · hub.minhas_empresas() e toda a RLS que depende dela — continuam
--     lendo só hub.atendente_empresas, sem saber que a flag existe.
--     hub.atendente_empresas continua sendo a ÚNICA fonte de verdade que
--     RLS e o backend enxergam; a flag só ajuda a MANTER essa tabela
--     completa e a lembrar a intenção na tela de edição.
--   · agrotimbo_hubwhatsapp_bkend/src/routes/mensagens.ts
--     (empresasDoAtendente) — lê atendente_empresas direto, mesmo motivo
--     acima: continua correto sem mudar uma linha de código.
--   · Atendentes existentes: a coluna nasce `false` para todo mundo,
--     nenhum vínculo em atendente_empresas é alterado por esta migration.
--
-- ⚠️  AÇÃO FORA DESTE SQL, opcional e recomendada — depois do deploy do
--     front (formulário novo em Configurações > Equipe), marcar
--     humberto@hai.expert como acesso_todas_empresas pela própria tela de
--     edição (ela já materializa atendente_empresas ao salvar). Se
--     preferir fazer por SQL direto em vez de pela UI:
--
--       update hub.atendentes set acesso_todas_empresas = true
--       where lower(email) = 'humberto@hai.expert';
--
--       insert into hub.atendente_empresas (atendente_id, empresa_id)
--       select a.id, e.id from hub.atendentes a cross join hub.empresas e
--       where a.acesso_todas_empresas
--       on conflict do nothing;
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
    select 1 from information_schema.tables
    where table_schema = 'hub' and table_name = 'atendente_empresas'
  ) then
    raise exception
      'hub.atendente_empresas não existe — rodar antes as migrations '
      'base do Hub (20260731000000_hub_schema.sql e seguintes).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Flag de intenção. Default false preserva o comportamento atual de
--    todo mundo até que a tela seja usada para marcar alguém.
-- ---------------------------------------------------------------------
alter table hub.atendentes
  add column if not exists acesso_todas_empresas boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. Materializa atendente_empresas quando uma empresa nova é criada,
--    para quem já tem acesso_todas_empresas = true. SECURITY DEFINER
--    porque quem insere em hub.empresas (admin, via RLS) não
--    necessariamente tem grant de INSERT em atendente_empresas para
--    OUTROS atendentes — mesmo padrão de hub.vincular_usuario.
-- ---------------------------------------------------------------------
create or replace function hub.sincroniza_acesso_total_nova_empresa()
returns trigger
language plpgsql
security definer
set search_path = hub, public
as $$
begin
  insert into hub.atendente_empresas (atendente_id, empresa_id)
  select a.id, new.id
  from hub.atendentes a
  where a.acesso_todas_empresas
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function hub.sincroniza_acesso_total_nova_empresa() from public, anon, authenticated;

drop trigger if exists trg_empresas_sincroniza_acesso_total on hub.empresas;
create trigger trg_empresas_sincroniza_acesso_total
  after insert on hub.empresas
  for each row
  execute function hub.sincroniza_acesso_total_nova_empresa();

-- ---------------------------------------------------------------------
-- 3. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes'
      and column_name = 'acesso_todas_empresas'
  ) then
    raise exception 'acesso_todas_empresas não foi criada — migration incompleta.';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_empresas_sincroniza_acesso_total'
      and not tgisinternal
  ) then
    raise exception 'trigger de sincronização não foi criado — migration incompleta.';
  end if;

  raise notice '=== OK: acesso_todas_empresas e trigger de sincronização aplicados. ===';
end $$;

commit;

-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select id, nome, acesso_todas_empresas from hub.atendentes order by nome;
--    -> acesso_todas_empresas deve vir false para todo mundo (coluna nova).
--
-- 2. Teste do trigger, dentro de uma transação que você desfaz (rollback)
--    — não precisa sujar o banco para validar:
--
--      begin;
--        update hub.atendentes set acesso_todas_empresas = true
--        where lower(email) = 'humberto@hai.expert';
--        insert into hub.empresas (nome, tipo) values ('Empresa Teste Trigger', 'varejo');
--        select ae.* from hub.atendente_empresas ae
--        join hub.atendentes a on a.id = ae.atendente_id
--        join hub.empresas e on e.id = ae.empresa_id
--        where lower(a.email) = 'humberto@hai.expert' and e.nome = 'Empresa Teste Trigger';
--        -- -> deve devolver 1 linha
--      rollback;
--
-- 3. supabase gen types typescript --project-id zfbjwhaltqewbluqfmtt
--    (ou equivalente) para substituir o patch manual em
--    multi-whats-magic/src/integrations/supabase/types.ts pelo tipo real.
--
-- 4. Se algo falhar: aplicar
--    20260806150000_hub_atendentes_acesso_multiempresa_rollback.sql
-- =====================================================================
