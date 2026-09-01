-- ROLLBACK de 20260810140000_hub_mensagens_criada_em.sql
--
-- ATENÇÃO: só rode isto DEPOIS de o backend voltar à revisão anterior.
-- services/filaMidia.ts (versão nova) filtra por `criada_em`; sem a coluna, a
-- varredura de mídia presa passa a devolver erro a cada ciclo.
--
-- Na prática esta migration raramente precisa ser desfeita: a coluna é aditiva
-- e inofensiva para o código antigo, que simplesmente a ignora. Desfazer só faz
-- sentido num rollback completo da feature.

begin;

drop index if exists hub.mensagens_midia_presa_idx;
alter table hub.mensagens drop column if exists criada_em;

comment on column hub.mensagens.enviada_em is null;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='hub' and table_name='mensagens' and column_name='criada_em') then
    raise exception 'rollback incompleto: criada_em ainda existe.';
  end if;
  raise notice 'rollback de criada_em OK.';
end $$;

commit;
