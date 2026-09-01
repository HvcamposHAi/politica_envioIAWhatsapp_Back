-- 20260810140000_hub_mensagens_criada_em.sql
-- Ordenação cronológica por atividade real (PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md §5.1).
--
-- POR QUE. `hub.mensagens.enviada_em` passa a carregar o relógio do WhatsApp
-- (messageTimestamp), não o instante em que o Hub processou o evento. O adapter
-- já resolvia esse valor (channels/baileys.adapter.ts) e o insert o descartava:
-- `enviada_em` caía no `default now()`. Em tempo real a diferença é de
-- milissegundos; o problema é o BACKLOG — o Baileys entrega de uma vez tudo que
-- chegou enquanto a sessão esteve fora, e este processo reinicia a cada deploy
-- do Cloud Run. A tarde inteira do cliente entrava com o carimbo da reconexão.
--
-- O EFEITO COLATERAL QUE ESTA COLUNA EXISTE PARA IMPEDIR. A varredura de mídia
-- presa (services/filaMidia.ts) procura `midia_status in ('pendente','baixando')`
-- com `enviada_em < now() - 15min`. Com `enviada_em` no passado, toda foto de
-- backlog nasceria JÁ VENCIDA pelo corte e seria varrida antes de o primeiro
-- download terminar — download duplicado, ou 'falhou' numa mídia que estava
-- chegando bem. O que aquele corte quer medir é há quanto tempo a LINHA está
-- presa aqui dentro. Isso é `criada_em`.
--
-- BACKFILL EXATO, não aproximado: hoje `enviada_em` É o instante de criação da
-- linha (default now(), nenhum caminho escreve nela). Copiar reconstrói o valor
-- verdadeiro; não é chute.
--
-- SEGURA ANTES DO DEPLOY: aditiva. O código atual ignora a coluna nova.
-- Aplicar ANTES de subir o backend novo — ele depende dela.

begin;

alter table hub.mensagens add column if not exists criada_em timestamptz;
update hub.mensagens set criada_em = enviada_em where criada_em is null;
alter table hub.mensagens alter column criada_em set default now();
alter table hub.mensagens alter column criada_em set not null;

comment on column hub.mensagens.criada_em is
  'Quando a linha nasceu no Hub (relogio do servidor). Use em varreduras '
  'operacionais (filaMidia). Para "quando a mensagem foi enviada de verdade", '
  'use enviada_em.';

comment on column hub.mensagens.enviada_em is
  'Quando a mensagem foi enviada de verdade: messageTimestamp do WhatsApp na '
  'entrada, instante do envio na saida. Pode ser ANTERIOR a criada_em em backlog '
  'de reconexao. E a coluna de ordem cronologica do fio da conversa.';

-- Parcial: a varredura só olha mídia não resolvida. O índice acompanha o
-- predicado dela em vez de indexar a tabela inteira.
create index if not exists mensagens_midia_presa_idx
  on hub.mensagens (criada_em)
  where midia_status in ('pendente','baixando');

-- Autovalidação. "Success. No rows returned" no editor do Supabase é
-- indistinguível entre "aplicou" e "colei e não rodei" — foi assim que um
-- rollback rodado por engano passou despercebido uma vez neste projeto.
do $$
declare n_col int; n_nulos bigint;
begin
  select count(*) into n_col from information_schema.columns
   where table_schema='hub' and table_name='mensagens' and column_name='criada_em';
  if n_col <> 1 then
    raise exception 'criada_em nao foi criada em hub.mensagens.';
  end if;

  select count(*) into n_nulos from hub.mensagens where criada_em is null;
  if n_nulos <> 0 then
    raise exception 'criada_em: % linhas nulas apos o backfill.', n_nulos;
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname='hub' and indexname='mensagens_midia_presa_idx') then
    raise exception 'indice mensagens_midia_presa_idx ausente.';
  end if;

  raise notice 'criada_em OK.';
end $$;

commit;
