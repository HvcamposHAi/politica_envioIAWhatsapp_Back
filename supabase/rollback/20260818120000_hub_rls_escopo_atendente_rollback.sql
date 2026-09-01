-- =====================================================================
-- ROLLBACK de 20260818120000_hub_rls_escopo_atendente.sql
-- =====================================================================
--
-- ATENÇÃO — NUNCA cole este arquivo junto com o de aplicação. Já houve um
-- rollback rodado por engano neste projeto e custou um ciclo inteiro.
--
-- O QUE ESTE ROLLBACK FAZ: devolve o escopo de conversa para o nível de
-- EMPRESA. Ou seja, REABRE o vazamento relatado em 2026-08-17 — todo
-- atendente volta a ler todas as conversas e mensagens das empresas
-- vinculadas a ele. Use só se a Fase 1 tiver quebrado a operação, e nesse
-- caso avise o cliente de que a restrição voltou a ser cosmética.
--
-- Antes de rodar, considere a alternativa menos ruim: manter a RLS nova e
-- cadastrar a supervisão que está faltando (hub.supervisao), que é a causa
-- provável de "sumiu conversa do supervisor".
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Policies de volta ao escopo de empresa (texto original de
--    20260731000100_hub_funcoes_rls.sql)
-- ---------------------------------------------------------------------
drop policy if exists conversas_select on hub.conversas;
create policy conversas_select on hub.conversas for select to authenticated
  using (
    hub.sou_admin()
    or setor_id in (select hub.meus_setores())
    or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );

drop policy if exists conversas_update on hub.conversas;
create policy conversas_update on hub.conversas for update to authenticated
  using (
    hub.sou_admin()
    or atendente_id = hub.meu_atendente_id()
    or setor_id in (select hub.meus_setores())
  )
  with check (
    hub.sou_admin()
    or setor_id in (select hub.meus_setores())
  );

-- ---------------------------------------------------------------------
-- 2. hub.minhas_conversas() volta a ser "empresa inteira"
--    Precisa vir ANTES das policies filhas, que dependem dela.
-- ---------------------------------------------------------------------
create or replace function hub.minhas_conversas()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select co.id from hub.conversas co
  where co.setor_id in (select hub.meus_setores())
     or co.canal_id in (
          select c.id from hub.canais c
          where c.empresa_id in (select hub.minhas_empresas())
        )
$$;

drop policy if exists mensagens_select on hub.mensagens;
create policy mensagens_select on hub.mensagens for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

drop policy if exists mensagens_insert on hub.mensagens;
create policy mensagens_insert on hub.mensagens for insert to authenticated
  with check (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

drop policy if exists transferencias_select on hub.transferencias;
create policy transferencias_select on hub.transferencias for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

drop policy if exists transferencias_insert on hub.transferencias;
create policy transferencias_insert on hub.transferencias for insert to authenticated
  with check (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

do $$
begin
  if to_regclass('hub.conversa_notas') is not null then
    execute 'drop policy if exists conversa_notas_select on hub.conversa_notas';
    execute 'create policy conversa_notas_select on hub.conversa_notas '
            'for select to authenticated '
            'using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()))';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. hub.v_conversao volta ao escopo por empresa
-- ---------------------------------------------------------------------
create or replace view hub.v_conversao as
select
  co.id                       as conversa_id,
  co.canal_id,
  co.setor_id,
  co.atendente_id,
  at.nome                     as atendente_nome,
  hc.empresa_id,
  hc.cod_cliente,
  co.status,
  co.desfecho,
  co.aberta_em,
  co.fechada_em,
  co.valor_venda              as valor_informado,
  co.nota_satisfacao,
  mp.nome                     as motivo_perda_nome,
  fat.notas,
  fat.valor_faturado,
  fat.primeira_nota_em,
  (fat.notas is not null and fat.notas > 0) as converteu
from hub.conversas co
join hub.clientes hc on hc.id = co.cliente_id
left join hub.atendentes    at on at.id = co.atendente_id
left join hub.motivos_perda mp on mp.id = co.motivo_perda_id
left join lateral (
  select
    count(*)                    as notas,
    sum(f.vl_venda)             as valor_faturado,
    min(f.dt_saida)             as primeira_nota_em
  from public.faturamento f
  where f.cod_cliente = hc.cod_cliente
    and f.cod_oper = 'S'
    and f.dt_cancel is null
    and f.dt_saida >= co.aberta_em::date
    and f.dt_saida <= coalesce(co.fechada_em::date, current_date) + 7
) fat on true
where hub.sou_admin()
   or hc.empresa_id in (select hub.minhas_empresas());

-- ---------------------------------------------------------------------
-- 4. Funções que só a Fase 1 usava
-- ---------------------------------------------------------------------
drop function if exists hub.posso_ver_conversa(uuid);
drop function if exists hub.conversas_que_transferi();
drop function if exists hub.canais_do_admin();
drop function if exists hub.meus_setores_supervisionados();

-- Os ÍNDICES ficam de propósito: são inertes, úteis nos dois modelos, e
-- derrubá-los num rollback de emergência só adiciona I/O a um momento
-- em que já há algo errado.

-- ---------------------------------------------------------------------
-- 5. Autovalidação do rollback
-- ---------------------------------------------------------------------
do $$
declare v_qual text;
begin
  select pg_get_expr(pol.polqual, pol.polrelid) into v_qual
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'hub' and c.relname = 'conversas'
    and pol.polname = 'conversas_select';

  if v_qual is null then
    raise exception 'rollback deixou hub.conversas sem policy de select.';
  end if;
  if position('meus_setores' in v_qual) = 0 then
    raise exception
      'rollback não pegou — conversas_select não voltou ao escopo de empresa: %', v_qual;
  end if;
  if position('posso_ver_conversa' in pg_get_viewdef('hub.v_conversao'::regclass)) > 0 then
    raise exception 'hub.v_conversao não voltou ao escopo de empresa.';
  end if;

  raise warning
    'ROLLBACK APLICADO: o escopo de conversa voltou a ser por EMPRESA. '
    'Todo atendente lê todas as conversas das empresas vinculadas a ele. '
    'A restrição por operador voltou a existir apenas no frontend.';
  raise notice '=== OK: escopo revertido para EMPRESA. ===';
end $$;

commit;
