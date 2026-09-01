-- =====================================================================
-- FASE 2.8 — Camada de operação real
-- =====================================================================
--
-- O schema do protótipo cobre o domínio. Isto é o que faz a coisa
-- funcionar de verdade em produção (plano-base §2.3).
--
-- Regra de segurança que atravessa o arquivo: RLS ligada, e a tabela que
-- guarda segredo (`hub.canal_sessoes`) NÃO recebe política nenhuma para
-- `authenticated`. RLS ligada + zero política = só `service_role` lê.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. hub.canal_sessoes — auth state do Baileys NO BANCO
--    É isto que faz a VM ser descartável: reboot não derruba as linhas,
--    e matar o container não obriga a ler QR de novo (aceite de A5.5).
--
-- ⚠️  CONTEÚDO SECRETO. `creds` e `keys` são o material criptográfico da
--     sessão do WhatsApp. Quem tem isso se passa pela linha do vendedor.
--     Nunca expor ao front, em nenhuma hipótese, nem para admin.
-- ---------------------------------------------------------------------
create table hub.canal_sessoes (
  canal_id      uuid primary key references hub.canais(id) on delete cascade,
  creds         jsonb,
  keys          jsonb,
  atualizado_em timestamptz default now()
);

-- Nenhum grant para `authenticated`. Só o worker, via service_role.
revoke all on hub.canal_sessoes from authenticated;
grant all  on hub.canal_sessoes to service_role;
alter table hub.canal_sessoes enable row level security;
-- Zero políticas, de propósito. Ver cabeçalho.

comment on table hub.canal_sessoes is
  'Auth state do Baileys. SEGREDO: nunca expor ao front. Sem política de '
  'RLS de propósito — só service_role acessa.';

-- ---------------------------------------------------------------------
-- 2. hub.eventos_canal — log de conexão/desconexão/QR
--    Alimenta o semáforo de saúde com dado real, em vez do mock
--    (A6.5). O front LÊ; só o worker ESCREVE.
-- ---------------------------------------------------------------------
create table hub.eventos_canal (
  id         bigserial primary key,
  canal_id   uuid not null references hub.canais(id) on delete cascade,
  tipo       text not null,
  detalhe    jsonb,
  criado_em  timestamptz default now(),
  constraint eventos_canal_tipo_check check (tipo in (
    'qr_gerado','qr_expirado','conectando','conectado','desconectado',
    'reconectando','erro','logout','banido','rate_limit'
  ))
);
create index eventos_canal_canal_idx on hub.eventos_canal (canal_id, criado_em desc);

alter table hub.eventos_canal enable row level security;
create policy eventos_canal_select on hub.eventos_canal for select to authenticated
  using (
    hub.sou_admin() or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );
-- Sem política de insert/update/delete: só o worker escreve, via service_role.

-- ---------------------------------------------------------------------
-- 3. hub.agentes_config — configuração do bot por canal
--    Hoje `canais.bot_ativo` é um boolean solto (A6.3).
-- ---------------------------------------------------------------------
create table hub.agentes_config (
  canal_id       uuid primary key references hub.canais(id) on delete cascade,
  ativo          boolean not null default false,
  prompt         text,
  tom            text default 'cordial',
  -- Prompt versionado em tabela, seguindo o padrão de `public.ai_prompts`
  -- da Alice (que tem 4 linhas de conteúdo real — confirmado em 30/07).
  -- Permite trocar prompt sem deploy (A7.3).
  versao         int not null default 1,
  horario_inicio time,
  horario_fim    time,
  dias_semana    int[] default '{1,2,3,4,5}',   -- 0=domingo .. 6=sábado
  atualizado_em  timestamptz default now(),
  constraint agentes_config_horario_check
    check (horario_inicio is null or horario_fim is null or horario_inicio < horario_fim)
);

alter table hub.agentes_config enable row level security;
create policy agentes_config_select on hub.agentes_config for select to authenticated
  using (
    hub.sou_admin() or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );
create policy agentes_config_admin_write on hub.agentes_config for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

-- ---------------------------------------------------------------------
-- 4. hub.motivos_perda — tabela, não string livre
--    O Marcelo vai querer agrupar isso no painel; com texto livre,
--    "preço" / "Preço" / "preco alto" viram três categorias.
-- ---------------------------------------------------------------------
create table hub.motivos_perda (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid references hub.empresas(id) on delete cascade,
  nome       text not null,
  ordem      int not null default 0,
  ativo      boolean not null default true
);
create unique index motivos_perda_empresa_nome
  on hub.motivos_perda (empresa_id, lower(nome));

alter table hub.motivos_perda enable row level security;
create policy motivos_perda_select on hub.motivos_perda for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));
create policy motivos_perda_admin_write on hub.motivos_perda for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

-- Migra a regra de negócio de texto livre para referência.
-- `motivo_perda` (text) sobrevive como observação complementar; a
-- categoria passa a ser `motivo_perda_id`.
alter table hub.conversas
  add column motivo_perda_id uuid references hub.motivos_perda(id);
create index conversas_motivo_perda_idx on hub.conversas (motivo_perda_id);

alter table hub.conversas drop constraint motivo_obrigatorio;
alter table hub.conversas
  add constraint motivo_obrigatorio
  check (desfecho <> 'nao_vendeu' or motivo_perda_id is not null);

comment on column hub.conversas.motivo_perda is
  'Observação livre complementar. A categoria agrupável é motivo_perda_id.';

-- ---------------------------------------------------------------------
-- 5. hub.mensagens — idempotência e mídia
--    `wa_message_id` único é o que faz webhook duplicado não duplicar
--    linha (aceite de A5.7).
-- ---------------------------------------------------------------------
alter table hub.mensagens
  add column wa_message_id  text,
  add column direcao        text not null default 'saida',
  add column status_entrega text not null default 'pendente',
  add column midia_url      text,
  add column midia_tipo     text,
  add column respondendo_a  uuid references hub.mensagens(id) on delete set null,
  add column erro           text;

alter table hub.mensagens
  add constraint mensagens_direcao_check
    check (direcao in ('entrada','saida')),
  add constraint mensagens_status_entrega_check
    check (status_entrega in ('pendente','enviada','entregue','lida','falhou')),
  add constraint mensagens_midia_check
    check (midia_url is null or midia_tipo is not null);

-- Índice PARCIAL: `wa_message_id` é null em mensagem criada pela UI antes
-- de o WhatsApp confirmar. Um índice único simples faria a segunda
-- mensagem sem id colidir com a primeira.
create unique index mensagens_wa_message_id_unico
  on hub.mensagens (wa_message_id)
  where wa_message_id is not null;

create index mensagens_status_pendente_idx
  on hub.mensagens (status_entrega, enviada_em)
  where status_entrega in ('pendente','falhou');

-- ---------------------------------------------------------------------
-- 6. hub.disparos + hub.disparo_alvos — campanhas
--    Status por destinatário (A8.2). Twilio só; disparo em massa por
--    Baileys é bloqueado no backend (A8.6) e reforçado aqui.
-- ---------------------------------------------------------------------
create table hub.disparos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references hub.empresas(id) on delete cascade,
  canal_id      uuid references hub.canais(id),
  nome          text not null,
  template      text,
  template_sid  text,          -- SID do template aprovado na Meta, via Twilio
  criado_por    uuid references hub.atendentes(id),
  status        text not null default 'rascunho',
  criado_em     timestamptz default now(),
  iniciado_em   timestamptz,
  concluido_em  timestamptz,
  constraint disparos_status_check
    check (status in ('rascunho','agendado','enviando','concluido','cancelado','erro'))
);
create index disparos_empresa_idx on hub.disparos (empresa_id, criado_em desc);

create table hub.disparo_alvos (
  id           uuid primary key default gen_random_uuid(),
  disparo_id   uuid not null references hub.disparos(id) on delete cascade,
  cliente_id   uuid references hub.clientes(id),
  telefone     text not null,
  status       text not null default 'pendente',
  wa_message_id text,
  erro         text,
  enviado_em   timestamptz,
  constraint disparo_alvos_status_check
    check (status in ('pendente','enviado','entregue','lido','falhou','cancelado'))
);
create index disparo_alvos_disparo_idx on hub.disparo_alvos (disparo_id, status);
create unique index disparo_alvos_unico on hub.disparo_alvos (disparo_id, telefone);

alter table hub.disparos      enable row level security;
alter table hub.disparo_alvos enable row level security;

create policy disparos_select on hub.disparos for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));
create policy disparos_admin_write on hub.disparos for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy disparo_alvos_select on hub.disparo_alvos for select to authenticated
  using (
    hub.sou_admin() or disparo_id in (
      select d.id from hub.disparos d
      where d.empresa_id in (select hub.minhas_empresas())
    )
  );
-- Escrita de alvo é do backend (service_role): o volume vem de query no ERP.

-- Guarda-corpo de banco para o Risco #1. O plano-base coloca o bloqueio
-- no código (A8.6); aqui ele existe também no schema, porque "nunca
-- disparo em massa por Baileys" é caro demais para depender de um `if`.
--
-- Allowlist, não blocklist: bloqueia tudo que não for `twilio`, em vez de
-- bloquear só `baileys`. Um transporte novo (`canais_transporte_check`
-- ganhando um terceiro valor no futuro) nasce bloqueado para disparo até
-- alguém decidir explicitamente liberá-lo aqui — o oposto do blocklist,
-- que deixaria transporte novo passar por omissão.
create or replace function hub.impede_disparo_baileys()
returns trigger
language plpgsql
security definer
set search_path = hub, public
as $$
declare v_transporte text;
begin
  select c.transporte into v_transporte
  from hub.canais c where c.id = new.canal_id;

  if v_transporte is distinct from 'twilio' then
    raise exception
      'Disparo em massa só é permitido em canal twilio (Risco #1: ban de número em Baileys). '
      'Campanha exige canal com transporte = twilio. Canal informado: % (transporte: %)',
      new.canal_id, v_transporte;
  end if;
  return new;
end $$;

create trigger disparos_bloqueia_baileys
  before insert or update of canal_id on hub.disparos
  for each row
  when (new.canal_id is not null)
  execute function hub.impede_disparo_baileys();

-- ---------------------------------------------------------------------
-- 7. hub.auditoria — exigência de supervisão do Jens
--    Quem assumiu, transferiu, fechou. Append-only.
-- ---------------------------------------------------------------------
create table hub.auditoria (
  id           bigserial primary key,
  empresa_id   uuid references hub.empresas(id) on delete cascade,
  atendente_id uuid references hub.atendentes(id),
  acao         text not null,
  entidade     text not null,
  entidade_id  uuid,
  antes        jsonb,
  depois       jsonb,
  origem       text default 'front',
  criado_em    timestamptz default now()
);
create index auditoria_empresa_idx  on hub.auditoria (empresa_id, criado_em desc);
create index auditoria_entidade_idx on hub.auditoria (entidade, entidade_id);

alter table hub.auditoria enable row level security;
-- Supervisor e admin leem. Ninguém altera pelo front: append-only, e o
-- append é do backend.
create policy auditoria_select on hub.auditoria for select to authenticated
  using (
    hub.sou_admin()
    or (hub.meu_perfil() = 'supervisor'
        and empresa_id in (select hub.minhas_empresas()))
  );

-- ---------------------------------------------------------------------
-- 8. Grants — nada novo para `anon`
-- ---------------------------------------------------------------------
grant select, insert, update, delete on all tables    in schema hub to authenticated;
grant all                            on all tables    in schema hub to service_role;
grant usage, select                  on all sequences in schema hub to authenticated, service_role;

-- Reforço explícito: as duas tabelas que não são do front.
revoke all on hub.canal_sessoes from authenticated;
revoke insert, update, delete on hub.auditoria     from authenticated;
revoke insert, update, delete on hub.eventos_canal from authenticated;

-- ---------------------------------------------------------------------
-- 9. Autovalidação
-- ---------------------------------------------------------------------
do $$
declare
  v_sem_rls text;
  v_anon    int;
begin
  select string_agg(c.relname, ', ') into v_sem_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'hub' and c.relkind = 'r' and not c.relrowsecurity;

  if v_sem_rls is not null then
    raise exception 'Tabelas em `hub` sem RLS: %', v_sem_rls;
  end if;

  select count(*) into v_anon
  from information_schema.role_table_grants
  where table_schema = 'hub' and grantee = 'anon';

  if v_anon > 0 then
    raise exception
      'ERRO GRAVE: % grant(s) para `anon` no schema hub. O anon key vai no '
      'bundle do front — isto é a exposição da Fase 1 se repetindo.', v_anon;
  end if;

  raise notice '=== OK: RLS em todas as tabelas de hub, zero grant para anon. ===';
end $$;

commit;
