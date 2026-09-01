-- Rollback de 20260808200000_hub_conversas_titulo_ia.sql
--
-- ATENÇÃO — ORDEM OBRIGATÓRIA: reverta o hub-api para uma revisão ANTERIOR à
-- feature ANTES de rodar isto (ou faça as duas coisas na mesma janela). O
-- código novo grava titulo_ia no MESMO update do resumo; com a coluna
-- derrubada e o código novo no ar, o update inteiro passa a falhar e o
-- resumo_ia para de ser gravado junto (falha F12 do plano).
--
-- Destrutivo: os títulos já gerados são perdidos. Não há como recuperá-los a
-- não ser regerando (botão "Gerar novamente" ou próxima mensagem da conversa),
-- o que custa uma chamada à Anthropic por conversa.

begin;

alter table hub.conversas drop constraint if exists conversas_titulo_ia_tamanho;

alter table hub.conversas
  drop column if exists titulo_ia,
  drop column if exists titulo_ia_gerado_em;

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'hub' and table_name = 'conversas'
        and column_name like 'titulo_ia%') <> 0 then
    raise exception 'rollback titulo_ia: colunas ainda presentes.';
  end if;
  raise notice '=== OK: titulo_ia removida de hub.conversas. ===';
end $$;

commit;

notify pgrst, 'reload schema';
