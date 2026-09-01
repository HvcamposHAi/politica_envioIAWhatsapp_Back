-- 20260808200000_hub_conversas_titulo_ia.sql
-- Título de IA do chamado, exibido em destaque no card do Kanban.
--
-- CONTEXTO (PLANO_TITULO_IA_KANBAN.md, 2026-08-08): o card do Kanban usava o
-- nome do cliente como título — que, para cliente não identificado, é o
-- telefone cru. A IA passa a nomear o ASSUNTO da conversa. O título é
-- produzido na MESMA chamada à Anthropic que já gerava resumo_ia
-- (services/resumoIA.ts): uma chamada só, gravação atômica no mesmo update,
-- título e resumo sempre coerentes entre si.
--
-- ORDEM DE DEPLOY (falha F1 do plano): esta migration TEM que ser aplicada
-- ANTES do deploy do hub-api. O título é gravado no mesmo update do resumo —
-- se a coluna não existir, o update inteiro falha e o resumo para de ser
-- gravado junto. Pelo mesmo motivo, o rollback exige reverter o hub-api antes
-- (ou junto).
--
-- Sem backfill de propósito: conversa aberta ganha título na próxima mensagem
-- recebida (ou na hora, pelo botão "Gerar novamente" do dialog), e o front cai
-- no nome do cliente enquanto titulo_ia for null. Conversa fechada não aparece
-- no board — pagar Anthropic por ela seria desperdício.

begin;

alter table hub.conversas
  add column if not exists titulo_ia text,
  add column if not exists titulo_ia_gerado_em timestamptz;

-- Rede de segurança, não a regra: o truncamento real é em 80 chars no código
-- (TITULO_MAX em services/resumoIA.ts). A folga até 120 existe para que um
-- título grande seja cortado silenciosamente lá e este check nunca dispare —
-- um 23514 aqui derrubaria o update inteiro, levando o resumo junto.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversas_titulo_ia_tamanho'
      and conrelid = 'hub.conversas'::regclass
  ) then
    alter table hub.conversas
      add constraint conversas_titulo_ia_tamanho
      check (titulo_ia is null or char_length(titulo_ia) between 1 and 120);
  end if;
end $$;

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'hub' and table_name = 'conversas'
        and column_name in ('titulo_ia', 'titulo_ia_gerado_em')) <> 2 then
    raise exception 'titulo_ia: colunas não criadas em hub.conversas — migration incompleta.';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversas_titulo_ia_tamanho'
      and conrelid = 'hub.conversas'::regclass
  ) then
    raise exception 'titulo_ia: constraint conversas_titulo_ia_tamanho ausente — migration incompleta.';
  end if;
  raise notice '=== OK: hub.conversas.titulo_ia pronta para o card do Kanban. ===';
end $$;

commit;

-- hub.conversas já está na publicação supabase_realtime com replica identity
-- full (20260731000200) — a coluna nova propaga sozinha, sem mexer aqui.
notify pgrst, 'reload schema';
