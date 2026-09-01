-- =====================================================================
-- FASE 2.6 — Realtime do schema `hub`
-- =====================================================================
--
-- Origem: 20260715194854 do protótipo.
--
-- ⚠️  O QUE MUDOU, E POR QUÊ
-- A migration original envolvia o `alter publication` num bloco
-- `exception when undefined_object then null`. Se a publicação
-- `supabase_realtime` não existisse no projeto, a falha era engolida:
-- o Realtime não ligava e ninguém percebia. Como o contrato front/back
-- inteiro depende de Realtime — "o backend devolve 202 e o resultado
-- aparece na tela via Realtime" (plano-base §5) — essa falha silenciosa
-- transformaria o Hub num app que não atualiza, com causa invisível.
--
-- Aqui a ausência da publicação é ERRO, não notice.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Replica identity
--    Necessária para o Realtime entregar o registro ANTERIOR em update
--    e delete. Sem isso o front recebe o evento sem saber o que mudou.
-- ---------------------------------------------------------------------
alter table hub.conversas replica identity full;
alter table hub.mensagens replica identity full;

-- ---------------------------------------------------------------------
-- 2. Publicação — falha fechada
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'Publicação `supabase_realtime` não existe neste projeto. O Realtime '
      'do Hub não funcionaria, e o contrato front/back depende dele. '
      'Criar a publicação (Dashboard -> Database -> Replication) e reaplicar. '
      'NÃO transformar isto em warning: o plano-base §2.2 registra que a '
      'migration do Lovable engolia exatamente esta falha.';
  end if;
end $$;

-- Idempotente por tabela: reaplicar a migration não quebra.
do $$
declare
  t text;
  v_add int := 0;
begin
  foreach t in array array['conversas', 'mensagens']
  loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = t
    ) then
      raise notice 'já publicada: hub.%', t;
    else
      execute format('alter publication supabase_realtime add table hub.%I', t);
      v_add := v_add + 1;
      raise notice 'publicada: hub.%', t;
    end if;
  end loop;
  raise notice '-> % tabela(s) adicionada(s) à publicação.', v_add;
end $$;

-- ---------------------------------------------------------------------
-- 3. Autovalidação — o que o plano-base pedia como passo manual
--    (`select * from pg_publication_tables where pubname = ...`)
--    passa a ser parte da migration.
-- ---------------------------------------------------------------------
do $$
declare v_faltando text;
begin
  select string_agg(t, ', ') into v_faltando
  from unnest(array['conversas','mensagens']) as t
  where not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = t
  );

  if v_faltando is not null then
    raise exception 'Realtime incompleto: hub.{%} não está na publicação.', v_faltando;
  end if;

  raise notice '=== OK: hub.conversas e hub.mensagens publicadas no Realtime. ===';
end $$;

commit;

-- =====================================================================
-- NOTA DE CAPACIDADE (liga com o Risco #4 e com A9.6)
-- =====================================================================
-- `replica identity full` faz o WAL carregar a linha INTEIRA em cada
-- update e delete, não só a chave. O banco já está com 1.024 MB de WAL
-- num compute MICRO (medido em 30/07, ver docs/fase0-fase1-diagnostico.md),
-- sob upsert diário de 2,3 M de linhas em `public.faturamento`.
--
-- `hub.mensagens` é a tabela de maior volume de escrita do Hub. Com
-- `replica identity full`, cada update de status de entrega reescreve a
-- linha completa no WAL.
--
-- Consequência prática: a medição de A9.6 ("avaliar subir o compute do
-- Supabase") deixa de ser opcional. Medir WAL e IO depois do teste de
-- 3 linhas por 48 h (A5.10), antes do go-live.
--
-- Se o WAL virar gargalo, a saída é trocar `replica identity full` por
-- `replica identity default` em `hub.mensagens` e mandar o backend
-- publicar o delta que o front precisa — mas isso muda o contrato do
-- Realtime, então é decisão de arquitetura, não de tuning.
-- =====================================================================
