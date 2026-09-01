-- Rollback de 20260808180000_hub_mensagens_wa_message_id_por_conversa.sql
--
-- ATENÇÃO: o rollback só funciona se não houver wa_message_id repetido
-- entre conversas (mensagens espelhadas entre as duas linhas gravadas
-- depois da migration). Se houver, o create unique abaixo falha — apagar
-- uma das cópias antes, ou aceitar conviver com o índice por conversa.

drop index if exists hub.mensagens_wa_message_id_unico;

create unique index if not exists mensagens_wa_message_id_unico
  on hub.mensagens (wa_message_id)
  where wa_message_id is not null;
