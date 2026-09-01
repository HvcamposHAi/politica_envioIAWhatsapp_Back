-- =====================================================================
-- URA (menu por teclado) — estado por canal e por conversa
-- =====================================================================
--
-- Origem: `20260804160000_hub_ura_empresa_filiais.sql` do Hub herdado.
-- Aquela migration fazia duas coisas sem relação entre si: criava a URA
-- e corrigia o escopo de uma view de ponte com o ERP de outro cliente
-- (`hub.empresa_filiais` + `hub.v_cliente_inativo`). Na Fase 0 desta
-- plataforma a metade do ERP saiu inteira — não há ERP aqui — e só a URA
-- ficou. Ver docs/PLANO_CAMPANHA_INDIARA.md, Fase 0.
--
-- A URA continua valendo para a campanha: `services/mensagens.ts` grava
-- `conversas.ura_estado` em toda conversa nova, e o menu por teclado é o
-- caminho barato de rotear quem responde a um disparo ("1 para falar com
-- a equipe, 2 para registrar uma demanda do seu bairro") antes de gastar
-- token de IA.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. hub.ura_opcoes — as opções do menu por teclado, por canal
--    Mesmo padrão de escopo de hub.agentes_config: por canal_id, que
--    resolve para empresa via hub.canais.
-- ---------------------------------------------------------------------
create table hub.ura_opcoes (
  id             uuid primary key default gen_random_uuid(),
  canal_id       uuid not null references hub.canais(id) on delete cascade,
  tecla          text not null,
  rotulo         text not null,
  setor_id       uuid references hub.setores(id) on delete set null,
  palavras_chave text[] not null default '{}',
  ordem          int not null default 1,
  ativa          boolean not null default true,
  unique (canal_id, tecla)
);
create index ura_opcoes_canal_idx on hub.ura_opcoes (canal_id);

alter table hub.ura_opcoes enable row level security;
create policy ura_opcoes_select on hub.ura_opcoes for select to authenticated
  using (
    hub.sou_admin() or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );
create policy ura_opcoes_admin_write on hub.ura_opcoes for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

-- ---------------------------------------------------------------------
-- 2. Colunas de URA em hub.canais — liga/desliga, saudação, horário.
--    Horário segue o mesmo padrão de hub.agentes_config (par de `time`
--    com check de ordem), não reaproveita agentes_config porque a URA
--    liga ANTES de decidir se cai no agente de IA ou em setor humano.
-- ---------------------------------------------------------------------
alter table hub.canais
  add column ura_ativa          boolean not null default false,
  add column ura_saudacao       text,
  add column ura_horario_inicio time,
  add column ura_horario_fim    time,
  add constraint canais_ura_horario_check
    check (ura_horario_inicio is null or ura_horario_fim is null
           or ura_horario_inicio < ura_horario_fim);

-- ---------------------------------------------------------------------
-- 3. Colunas de URA em hub.conversas — em que passo do menu o cliente
--    está, e quantas tentativas inválidas já deu (para desistir da URA
--    e cair em humano depois de N erros).
-- ---------------------------------------------------------------------
alter table hub.conversas
  add column ura_estado     text,
  add column ura_tentativas int not null default 0,
  add constraint conversas_ura_tentativas_check check (ura_tentativas >= 0);

-- ---------------------------------------------------------------------
-- 4. Grants — nada novo para `anon`.
--    `alter default privileges` de 20260731000000 já cobre a tabela nova
--    (select/insert/update/delete para authenticated, all para
--    service_role). RLS acima é quem restringe escrita a admin.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 5. Autovalidação
-- ---------------------------------------------------------------------
do $$
declare
  v_sem_rls text;
  v_anon    int;
begin
  select string_agg(c.relname, ', ') into v_sem_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'hub' and c.relkind = 'r' and not c.relrowsecurity
    and c.relname in ('ura_opcoes');

  if v_sem_rls is not null then
    raise exception 'Tabelas novas sem RLS: %', v_sem_rls;
  end if;

  select count(*) into v_anon
  from information_schema.role_table_grants
  where table_schema = 'hub' and grantee = 'anon'
    and table_name in ('ura_opcoes');

  if v_anon > 0 then
    raise exception 'ERRO GRAVE: grant para `anon` em tabela nova de hub.';
  end if;

  raise notice '=== OK: ura_opcoes com RLS e colunas de URA criadas em canais e conversas. ===';
end $$;

commit;
