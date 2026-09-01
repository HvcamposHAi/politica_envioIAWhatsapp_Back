-- =====================================================================
-- Cadastro completo de empresas: razão social, nome fantasia, CNPJ e
-- exclusão reversível (soft-delete)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Configurações -> Empresas era só leitura: sem criar, sem editar, e
-- `hub.empresas` só tinha `nome`/`tipo`/`cnpj` (cnpj já existia, sem
-- validação nem uso na UI). Pedido: abrir CRUD completo, capturando
-- razão social e nome fantasia além do CNPJ, e permitir "excluir".
--
-- "Excluir" NÃO é DELETE físico. `hub.canais.empresa_id` e
-- `hub.atendentes.empresa_id` não têm ON DELETE (bloqueiam a exclusão se
-- houver linha vinculada); se essas fossem removidas antes, o DELETE em
-- cascata apagaria para sempre hub.clientes, hub.disparos (+
-- disparo_alvos), hub.motivos_perda e hub.auditoria — que é append-only
-- por design. Em vez disso, esta migration adiciona `ativo`, no mesmo
-- padrão já usado em hub.atendentes.ativo e hub.motivos_perda.ativo.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · Nenhum ON DELETE/FK muda — zero risco às cascatas já existentes.
--   · trg_empresas_sincroniza_acesso_total (AFTER INSERT em hub.empresas,
--     migrations_pendentes/20260806150000) só dispara em criação, não em
--     UPDATE de `ativo` — não precisa de ajuste.
--   · hub.minhas_empresas()/hub.meus_setores() não mudam — desativar uma
--     empresa NÃO revoga acesso já concedido a setores/conversas dela,
--     só tira ela dos cadastros de "novo registro" (empresas_select).
--   · empresas_admin_write (INSERT/UPDATE/DELETE do admin) não muda.
-- =====================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Colunas novas. Nenhuma é NOT NULL exceto `ativo` (com default true,
--    preserva o comportamento atual de toda empresa existente).
-- ---------------------------------------------------------------------
alter table hub.empresas
  add column if not exists razao_social  text,
  add column if not exists nome_fantasia text,
  add column if not exists ativo         boolean not null default true;

-- ---------------------------------------------------------------------
-- 2. Índice único parcial: impede duas empresas ATIVAS com o mesmo CNPJ.
--    Ignora nulos e empresas desativadas (reaproveitar um CNPJ "liberado"
--    por uma exclusão anterior não fica bloqueado por uma linha morta).
--    Só cria se não houver duplicata hoje — se houver, avisa e segue sem
--    o índice (resolver os duplicados e criar o índice à parte depois).
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select cnpj from hub.empresas
    where cnpj is not null and ativo
    group by cnpj having count(*) > 1
  ) then
    raise notice 'AVISO: já existem CNPJs duplicados entre empresas ativas — índice único NÃO criado.';
  else
    create unique index if not exists empresas_cnpj_ativo_unique_idx
      on hub.empresas (cnpj) where cnpj is not null and ativo;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. RLS: empresa desativada some da leitura de quem NÃO é admin.
--    hub.sou_admin() continua enxergando tudo (precisa, para reativar).
-- ---------------------------------------------------------------------
drop policy if exists empresas_select on hub.empresas;
create policy empresas_select on hub.empresas for select to authenticated
  using (hub.sou_admin() or (ativo and id in (select hub.minhas_empresas())));

-- ---------------------------------------------------------------------
-- 4. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'empresas' and column_name = 'ativo'
  ) then
    raise exception 'ativo não foi criada — migration incompleta.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'empresas' and column_name = 'razao_social'
  ) then
    raise exception 'razao_social não foi criada — migration incompleta.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'empresas' and column_name = 'nome_fantasia'
  ) then
    raise exception 'nome_fantasia não foi criada — migration incompleta.';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hub' and tablename = 'empresas' and policyname = 'empresas_select'
  ) then
    raise exception 'policy empresas_select não foi recriada — migration incompleta.';
  end if;

  raise notice '=== OK: razao_social, nome_fantasia, ativo e RLS aplicados em hub.empresas. ===';
end $$;

commit;

-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select column_name from information_schema.columns
--    where table_schema = 'hub' and table_name = 'empresas';
--    -> deve incluir razao_social, nome_fantasia, ativo.
--
-- 2. select id, nome, tipo, cnpj, razao_social, nome_fantasia, ativo
--    from hub.empresas;
--    -> as empresas existentes devem vir com ativo = true, sem perder
--       nenhum dado de nome/tipo/cnpj.
--
-- 3. select policyname, qual from pg_policies
--    where schemaname = 'hub' and tablename = 'empresas'
--      and policyname = 'empresas_select';
--    -> o texto deve conter "ativo".
--
-- 4. Teste do soft-delete, dentro de uma transação que você desfaz
--    (rollback) — não precisa sujar o banco para validar:
--
--      begin;
--        update hub.empresas set ativo = false where nome = 'Casa do Colono';
--        select id, nome, ativo from hub.empresas where nome = 'Casa do Colono';
--        -- -> ativo deve vir "false" aqui
--      rollback;
--      -- -> depois do rollback, ativo volta a "true"
--
-- 5. Se algo falhar: aplicar
--    20260807120000_hub_empresas_cadastro_completo_rollback.sql
-- =====================================================================
