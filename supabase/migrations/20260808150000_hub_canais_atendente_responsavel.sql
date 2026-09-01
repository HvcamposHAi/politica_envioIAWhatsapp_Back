-- =====================================================================
-- Linha pessoal: hub.canais.atendente_id (atendente responsável)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Pedido 2026-08-08: "um telefone pode pertencer a uma equipe OU a um
-- atendente/função". O modelo até aqui só conhecia linha de equipe:
-- canal -> setor, conversa nasce "Sem dono" e alguém do setor assume.
--
-- Esta migration adiciona `atendente_id` (nullable) em hub.canais:
--   · NULL  = linha de equipe (comportamento atual, inalterado — toda
--             linha existente continua exatamente como era).
--   · Preenchido = linha PESSOAL: toda conversa nova que entra por esse
--     canal já nasce com conversas.atendente_id = canais.atendente_id
--     (quem grava é resolverConversaAberta em services/mensagens.ts) —
--     aparece direto na aba "Meus" do atendente, sem passar por
--     "Sem dono".
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · Conversas já abertas: nada de backfill — dono de conversa em
--     andamento não muda por migration.
--   · setor_id continua obrigatório no fluxo (o setor segue sendo o
--     agrupador de fila/kanban; a linha pessoal só define o DONO inicial).
--   · RLS: nenhuma policy muda — atendente_id em canais é metadado de
--     roteamento, a visibilidade continua vindo de setor/empresa.
--   · on delete set null: desligar/excluir o atendente devolve a linha
--     ao comportamento de equipe em vez de quebrar o canal.
-- =====================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
end $$;

alter table hub.canais
  add column if not exists atendente_id uuid references hub.atendentes(id) on delete set null;

comment on column hub.canais.atendente_id is
  'Linha pessoal: quando preenchido, toda conversa nova deste canal nasce '
  'com este atendente como dono (conversas.atendente_id). NULL = linha de '
  'equipe (conversa nasce Sem dono no setor).';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'canais' and column_name = 'atendente_id'
  ) then
    raise exception 'hub.canais.atendente_id não foi criada — migration incompleta.';
  end if;
  raise notice '=== OK: hub.canais.atendente_id criada. ===';
end $$;

commit;

-- =====================================================================
-- PÓS-APLICAÇÃO (opcional) — tornar uma linha existente pessoal:
--
--   update hub.canais
--   set atendente_id = (select id from hub.atendentes where lower(email) = 'humberto@hai.expert')
--   where nome = 'Humberto HAI';
--
-- Rollback: 20260808150000_hub_canais_atendente_responsavel_rollback.sql
-- =====================================================================
