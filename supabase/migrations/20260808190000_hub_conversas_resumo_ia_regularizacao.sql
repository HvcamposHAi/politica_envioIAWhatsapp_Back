-- 20260808190000_hub_conversas_resumo_ia_regularizacao.sql
-- Regulariza um DRIFT: as colunas resumo_ia* existem em produção desde a
-- Fase 7 ("Resumo de IA no Kanban de Chamados") mas nunca tiveram migration
-- — o ALTER TABLE foi aplicado à mão no banco e o commit da feature tocou só
-- arquivos src/. Descoberto durante PLANO_TITULO_IA_KANBAN.md (2026-08-08).
--
-- Esta migration é NO-OP em produção (tudo `if not exists`): ela não muda o
-- banco, ela DOCUMENTA o schema que já está lá. O valor é para quem
-- reconstruir o banco do zero (dev local, staging, recuperação) — sem ela,
-- um banco novo nasce sem as colunas e services/resumoIA.ts falha em todo
-- update.
--
-- Rode ANTES de 20260808200000_hub_conversas_titulo_ia.sql em qualquer
-- ambiente novo. Em produção a ordem não importa (não faz nada).

begin;

alter table hub.conversas
  add column if not exists resumo_ia text,
  add column if not exists resumo_ia_status text not null default 'pendente',
  add column if not exists resumo_ia_gerado_em timestamptz,
  add column if not exists resumo_ia_modelo text,
  add column if not exists resumo_ia_mensagens_count integer,
  add column if not exists resumo_ia_erro text;

do $$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'hub' and table_name = 'conversas'
        and column_name like 'resumo_ia%') <> 6 then
    raise exception 'resumo_ia: esperadas 6 colunas em hub.conversas — schema divergente.';
  end if;
  raise notice '=== OK: schema de resumo_ia documentado (no-op em produção). ===';
end $$;

commit;
