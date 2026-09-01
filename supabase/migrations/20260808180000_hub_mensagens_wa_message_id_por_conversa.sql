-- 20260808180000_hub_mensagens_wa_message_id_por_conversa.sql
-- Idempotência de wa_message_id por CONVERSA, não global.
--
-- CONTEXTO (incidente 2026-08-08, "não vejo as mensagens do 2º número"):
-- quando as duas linhas Baileys da MESMA base conversam entre si, a mesma
-- mensagem chega pelos dois sockets com o mesmo wa_message_id — cada lado
-- é uma testemunha legítima e deveria gravar a sua cópia na SUA conversa
-- (canal Televendas <-> canal Humberto HAI são conversas espelhadas
-- distintas). Com o índice único GLOBAL de 20260731000300, o primeiro
-- insert vencia e o segundo virava no-op "idempotente": cada mensagem caía
-- em só uma das duas conversas, decidido por corrida, deixando buracos nos
-- dois lados.
--
-- O índice único foi desenhado para (a) retry de webhook da Twilio e
-- (b) reemissão de messages.upsert do Baileys pós-reconexão — os dois casos
-- reapresentam a mensagem NA MESMA conversa, então (conversa_id,
-- wa_message_id) preserva a proteção original por inteiro. Também continua
-- cobrindo o eco fromMe do que o Hub enviou (routes/mensagens.ts grava o
-- wa_message_id na mesma conversa que o eco alcança).
--
-- Acompanha mudança de código em services/mensagens.ts
-- (atualizarStatusEntregaPorWaMessageId deixou de usar maybeSingle — com
-- este índice, um wa_message_id pode legitimamente ter 2 linhas).

drop index if exists hub.mensagens_wa_message_id_unico;

-- Parcial como antes: mensagem criada pela UI antes do provedor confirmar
-- não tem wa_message_id (null), e null não pode bloquear inserts.
create unique index if not exists mensagens_wa_message_id_unico
  on hub.mensagens (conversa_id, wa_message_id)
  where wa_message_id is not null;

do $$
declare
  def text;
begin
  select indexdef into def
  from pg_indexes
  where schemaname = 'hub' and tablename = 'mensagens'
    and indexname = 'mensagens_wa_message_id_unico';
  if def is null or position('conversa_id' in def) = 0 then
    raise exception 'mensagens_wa_message_id_unico não ficou por (conversa_id, wa_message_id) — migration incompleta.';
  end if;
  raise notice '=== OK: idempotência de wa_message_id agora é por conversa. ===';
end $$;
