-- =====================================================================
-- ROLLBACK de 20260808200000_hub_ia_analise_csat.sql
-- =====================================================================
--
-- ATENÇÃO — este script DESTRÓI dados:
--   · `risco` / `risco_motivo` e os timestamps de análise: reconstituíveis
--     (a próxima mensagem de cliente reagenda a análise da conversa).
--   · `avaliacao_solicitada_em` / `avaliacao_registrada_em`: NÃO são
--     reconstituíveis. Perder o par significa perder o rastro de quais
--     pesquisas de satisfação foram enviadas — e com ele a guarda de
--     idempotência que impede reenviar pesquisa para o mesmo chamado.
--     `nota_satisfacao` em si sobrevive (a coluna é anterior a esta
--     migration e não é removida aqui), mas fica sem contexto de quando
--     foi pedida nem se a pesquisa chegou a ser respondida.
--
-- Antes de rodar, exportar o que interessa:
--
--   select id, risco, risco_motivo, nota_satisfacao,
--          avaliacao_solicitada_em, avaliacao_registrada_em
--     from hub.conversas
--    where risco is not null or avaliacao_solicitada_em is not null;
--
-- Rodar isto com o hub-api novo no ar coloca o backend em falha contínua
-- e silenciosa: analiseIA.ts escreve nestas colunas e, por contrato de
-- fire-and-forget, engole o erro. Reverter o deploy do backend PRIMEIRO.
-- =====================================================================

begin;

-- Índices antes das colunas: conversas_avaliacao_pendente_idx depende de
-- avaliacao_solicitada_em, e `drop column` levaria o índice junto de
-- qualquer forma — explícito aqui para o rollback ser legível.
drop index if exists hub.conversas_risco_aberto_idx;
drop index if exists hub.conversas_avaliacao_pendente_idx;

-- conversas_nota_satisfacao_valida some com o rollback embora
-- nota_satisfacao permaneça: a coluna é anterior a esta migration e
-- estava sem validação de faixa até aqui. Voltar ao estado anterior é
-- voltar a aceitar qualquer inteiro.
alter table hub.conversas
  drop constraint if exists conversas_risco_valido,
  drop constraint if exists conversas_nota_satisfacao_valida,
  drop column if exists sentimento_atualizado_em,
  drop column if exists risco,
  drop column if exists risco_motivo,
  drop column if exists risco_atualizado_em,
  drop column if exists motivo_perda_sugerido_id,
  drop column if exists analise_ia_modelo,
  drop column if exists analise_ia_erro,
  drop column if exists avaliacao_solicitada_em,
  drop column if exists avaliacao_registrada_em;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'conversas' and column_name = 'risco'
  ) then
    raise exception 'rollback incompleto: hub.conversas.risco ainda existe.';
  end if;
  raise notice '=== OK: colunas de análise de IA e CSAT removidas de hub.conversas. ===';
end $$;

commit;
