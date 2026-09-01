-- Rollback de 20260807160000_hub_clientes_wa_jid.sql
--
-- Remove a coluna wa_jid e o índice — junto vai qualquer backfill que
-- tenha sido aplicado manualmente (passo 3 da validação da migration
-- principal). Reaplicável depois: recriar a coluna e rodar o backfill de
-- novo.

begin;

drop index if exists hub.clientes_wa_jid_empresa;
alter table hub.clientes drop column if exists wa_jid;

commit;
