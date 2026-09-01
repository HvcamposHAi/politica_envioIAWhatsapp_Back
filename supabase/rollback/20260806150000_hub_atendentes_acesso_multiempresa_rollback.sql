-- =====================================================================
-- ROLLBACK — Acesso multiempresa por atendente
-- Desfaz 20260806150000_hub_atendentes_acesso_multiempresa.sql
-- =====================================================================
--
-- NÃO remove linhas de hub.atendente_empresas que o trigger já tiver
-- criado — são vínculos de acesso reais e materializados; apagá-las por
-- engano revogaria acesso de gente que passou a ter, via UI, entre a
-- aplicação desta migration e o rollback. Se algum vínculo precisar ser
-- desfeito, é uma decisão de acesso, não de schema — fazer manualmente e
-- com intenção, depois deste rollback.
-- =====================================================================

begin;

drop trigger if exists trg_empresas_sincroniza_acesso_total on hub.empresas;
drop function if exists hub.sincroniza_acesso_total_nova_empresa();

alter table hub.atendentes
  drop column if exists acesso_todas_empresas;

commit;
