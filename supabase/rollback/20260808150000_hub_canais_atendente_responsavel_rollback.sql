-- Rollback de 20260808150000_hub_canais_atendente_responsavel.sql
begin;
alter table hub.canais drop column if exists atendente_id;
commit;
