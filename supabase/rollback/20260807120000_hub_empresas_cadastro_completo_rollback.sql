-- Rollback de 20260807120000_hub_empresas_cadastro_completo.sql
begin;

drop policy if exists empresas_select on hub.empresas;
create policy empresas_select on hub.empresas for select to authenticated
  using (hub.sou_admin() or id in (select hub.minhas_empresas()));

drop index if exists hub.empresas_cnpj_ativo_unique_idx;

alter table hub.empresas
  drop column if exists razao_social,
  drop column if exists nome_fantasia,
  drop column if exists ativo;

commit;
