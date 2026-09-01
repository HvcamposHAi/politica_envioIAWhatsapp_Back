-- ROLLBACK de 20260810141000_hub_tocar_conversa.sql
--
-- ATENÇÃO: só rode isto DEPOIS de o backend voltar à revisão anterior.
-- services/mensagens.ts (versão nova) chama esta função em TODA mensagem
-- recebida; derrubá-la com o código novo no ar faz toda mensagem de entrada
-- falhar (FA-19 do plano).

begin;

drop function if exists hub.tocar_conversa(uuid, timestamptz, boolean);

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname='hub' and p.proname='tocar_conversa') then
    raise exception 'rollback incompleto: hub.tocar_conversa ainda existe.';
  end if;
  raise notice 'rollback de tocar_conversa OK.';
end $$;

commit;
