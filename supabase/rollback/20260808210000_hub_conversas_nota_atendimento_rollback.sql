-- Rollback de 20260808210000_hub_conversas_nota_atendimento.sql
--
-- ATENÇÃO — ORDEM OBRIGATÓRIA: reverta o hub-front para uma revisão ANTERIOR à
-- feature ANTES de rodar isto. O `select("*")` do front sobrevive à ausência
-- das colunas, mas toda gravação de nota passa a falhar com 42703 e o
-- atendente vê erro em cima de erro.
--
-- DESTRUTIVO: apaga as notas vigentes E o histórico. O rastro em hub.auditoria
-- (append-only) permanece — é de lá que dá para reconstruir o que foi escrito.
--
-- BACKUP (rode ANTES, se quiser preservar):
--   create table if not exists hub._backup_nota_atendimento as
--     select id, nota_atendimento, nota_atendimento_por, nota_atendimento_em
--       from hub.conversas where nota_atendimento is not null;
--   create table if not exists hub._backup_conversa_notas as
--     select * from hub.conversa_notas;

begin;

drop trigger if exists conversas_registrar_nota on hub.conversas;
drop function if exists hub.registrar_nota_atendimento();

drop table if exists hub.conversa_notas;

alter table hub.conversas
  drop constraint if exists conversas_nota_atendimento_tamanho,
  drop constraint if exists conversas_nota_atendimento_carimbo;

alter table hub.conversas
  drop column if exists nota_atendimento,
  drop column if exists nota_atendimento_por,
  drop column if exists nota_atendimento_em;

do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'hub' and table_name = 'conversas'
         and column_name like 'nota_atendimento%') <> 0 then
    raise exception 'rollback nota_atendimento: colunas ainda presentes em hub.conversas.';
  end if;
  if to_regclass('hub.conversa_notas') is not null then
    raise exception 'rollback nota_atendimento: hub.conversa_notas ainda existe.';
  end if;
  if exists (select 1 from pg_trigger
             where tgname = 'conversas_registrar_nota'
               and tgrelid = 'hub.conversas'::regclass) then
    raise exception 'rollback nota_atendimento: trigger ainda ativo.';
  end if;
  raise notice '=== OK: nota do atendimento removida (colunas, histórico e trigger). ===';
end $$;

commit;

notify pgrst, 'reload schema';
