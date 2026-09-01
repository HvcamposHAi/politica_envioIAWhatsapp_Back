-- Rollback de 20260807180000_hub_empresas_vinculo_criador.sql
-- Remove só o trigger e a função. NÃO desfaz o backfill: reverter um
-- insert de vínculo de acesso às cegas não é seguro — se algum dia for
-- preciso, é uma remoção pontual, decidida caso a caso, não um rollback
-- genérico.
begin;
drop trigger if exists trg_empresas_concede_acesso_criador on hub.empresas;
drop function if exists hub.concede_acesso_criador_empresa();
commit;
