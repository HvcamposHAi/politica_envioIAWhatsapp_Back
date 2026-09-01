-- 20260808230000_hub_conversas_aberta_em_idx.sql
-- Painel clicável + Alice contextual (PLANO_PAINEL_CLICAVEL_ALICE_CONTEXTUAL.md, §4.2).
--
-- POR QUE. O contexto da Alice (services/alice.ts) filtra `aberta_em >= …` SEM
-- filtro de status. O único índice existente com essa coluna é
-- conversas_status_aberta_idx (status, aberta_em desc) — com `status` como
-- coluna líder, ele não atende essa consulta, que hoje faz seq scan.
--
-- Com o indicador em foco a consulta piora em dois eixos ao mesmo tempo: a
-- janela DOBRA (atual + anterior, para o delta) e ela passa a rodar a cada
-- clique de card, não a cada pergunta digitada.
--
-- NÃO É OBRIGATÓRIO. A feature funciona sem este índice; a base de hoje tem
-- dezenas de conversas. Isto é o que evita que o Painel vire o gargalo quando
-- ela crescer.
--
-- `create index` comum, NÃO concurrently: concurrently não roda dentro de
-- transação, e é a transação que dá a autovalidação do fim do bloco. A tabela
-- é pequena; o lock de escrita dura milissegundos.
--
-- Seguro a qualquer momento, antes ou depois do deploy do código: não muda
-- comportamento nenhum, só o plano de execução.

begin;

create index if not exists conversas_aberta_em_idx
  on hub.conversas (aberta_em desc);

comment on index hub.conversas_aberta_em_idx is
  'Janela temporal do contexto da Alice (services/alice.ts) e do Painel. '
  'Complementa conversas_status_aberta_idx, que só serve a consultas com status.';

-- Autovalidação. Sem isto, "Success. No rows returned" no editor do Supabase
-- seria indistinguível entre "aplicou" e "colei no editor e não rodei" — foi
-- exatamente assim que um rollback rodado por engano passou despercebido uma
-- vez neste projeto. Com o raise, "sem erro" vira prova de aplicação, e uma
-- falha parcial desfaz sozinha em vez de deixar meio estado.
do $$
begin
  if not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'hub'
       and c.relname = 'conversas_aberta_em_idx'
       and c.relkind = 'i'
  ) then
    raise exception 'FALHOU: hub.conversas_aberta_em_idx não existe ao fim do bloco';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- CONFERÊNCIA — rode SEPARADO, em uma segunda execução.
-- Ela RETORNA LINHA: é isso que prova que o índice existe, e não a ausência de
-- erro do bloco acima. Esperado: exatamente 2 linhas.
-- ---------------------------------------------------------------------------
-- select
--   i.relname                                as indice,
--   pg_get_indexdef(i.oid)                   as definicao,
--   pg_size_pretty(pg_relation_size(i.oid))  as tamanho
-- from pg_class i
-- join pg_namespace n on n.oid = i.relnamespace
-- where n.nspname = 'hub'
--   and i.relname in ('conversas_aberta_em_idx', 'conversas_status_aberta_idx')
-- order by i.relname;
