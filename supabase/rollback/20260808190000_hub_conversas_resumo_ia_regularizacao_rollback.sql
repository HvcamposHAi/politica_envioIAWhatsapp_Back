-- Rollback de 20260808190000_hub_conversas_resumo_ia_regularizacao.sql
--
-- NÃO EXECUTE EM PRODUÇÃO. A migration correspondente é um no-op que apenas
-- documenta colunas que já existem e estão EM USO (services/resumoIA.ts grava
-- nelas a cada mensagem recebida; o dialog do Kanban as lê). Derrubá-las
-- apagaria todos os resumos já gerados e quebraria a geração.
--
-- Existe só para completar o par exigido pela convenção de
-- migrations_pendentes/ e para reverter um ambiente descartável (dev local)
-- criado por engano. Descomente conscientemente.

-- begin;
-- alter table hub.conversas
--   drop column if exists resumo_ia,
--   drop column if exists resumo_ia_status,
--   drop column if exists resumo_ia_gerado_em,
--   drop column if exists resumo_ia_modelo,
--   drop column if exists resumo_ia_mensagens_count,
--   drop column if exists resumo_ia_erro;
-- commit;

do $$
begin
  raise exception 'Rollback de resumo_ia está desativado de propósito — leia o cabeçalho do arquivo.';
end $$;
