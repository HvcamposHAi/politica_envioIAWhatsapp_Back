-- CENTRAL INDIARA - schema completo, versao ENXUTA (sem comentarios).
-- Gerado de supabase/manual/aplicar_central_no_projeto_compartilhado.sql,
-- que e gerado de supabase/migrations/. A fonte da verdade sao as
-- migrations; este arquivo existe so para caber melhor no SQL Editor.
--
-- COMO USAR: copiar INTEIRO > SQL Editor > New query > colar > Run.
-- TUDO OU NADA: roda numa transacao so. Se algo reprovar, nada e aplicado.
-- DESFAZER: drop schema hub cascade;  (nao toca no CRM do projeto)



create schema if not exists hub;

grant usage on schema hub to authenticated, service_role;

create table hub.empresas (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  tipo       text not null,
  cnpj       text,
  created_at timestamptz default now()
);

create table hub.setores (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid references hub.empresas(id) on delete cascade,
  nome       text not null,
  cor        text default '#64748b'
);
create index setores_empresa_idx on hub.setores (empresa_id);

create table hub.canais (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid references hub.empresas(id),
  setor_id       uuid references hub.setores(id),
  nome           text not null,
  numero         text not null,
  transporte     text not null default 'baileys',
  status         text not null default 'verde',
  conectado      boolean default true,
  eh_principal   boolean default false,
  operadora      text,
  bot_ativo      boolean default false,
  conexao_status text default 'desconectado',
  ultima_conexao timestamptz,
  qr_expira_em   timestamptz,
  constraint canais_transporte_check
    check (transporte in ('baileys', 'twilio')),
  constraint canais_conexao_status_check
    check (conexao_status in ('desconectado','lendo_qr','conectando',
                              'conectado','instavel','caido'))
);
create index canais_empresa_idx on hub.canais (empresa_id);

create unique index canais_numero_unico on hub.canais (numero);

create table hub.atendentes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid,
  empresa_id   uuid references hub.empresas(id),
  setor_id     uuid references hub.setores(id),
  nome         text not null,
  email        text,
  perfil       text not null default 'operador',
  capacidade   int default 5,
  online       boolean default true,
  tem_whatsapp boolean default false,
  canal_id     uuid references hub.canais(id),
  ativo        boolean not null default true,
  constraint atendentes_perfil_check
    check (perfil in ('operador','supervisor','admin'))
);

create unique index atendentes_email_unico
  on hub.atendentes (lower(email)) where email is not null;

create table hub.atendente_empresas (
  atendente_id uuid references hub.atendentes(id) on delete cascade,
  empresa_id   uuid references hub.empresas(id)   on delete cascade,
  primary key (atendente_id, empresa_id)
);

create table hub.supervisao (
  supervisor_id uuid references hub.atendentes(id) on delete cascade,
  setor_id      uuid references hub.setores(id)    on delete cascade,
  primary key (supervisor_id, setor_id)
);

create table hub.canal_atendentes (
  canal_id     uuid references hub.canais(id)     on delete cascade,
  atendente_id uuid references hub.atendentes(id) on delete cascade,
  primary key (canal_id, atendente_id)
);

create table hub.canal_atribuicoes (
  id            uuid primary key default gen_random_uuid(),
  canal_id      uuid references hub.canais(id)  on delete cascade,
  palavra_chave text not null,
  setor_id      uuid references hub.setores(id) on delete set null
);
create unique index canal_atribuicoes_unicas
  on hub.canal_atribuicoes (canal_id, lower(palavra_chave));

create table hub.clientes (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid references hub.empresas(id) on delete cascade,
  nome          text not null,
  telefone      text not null,
  cidade        text,
  cliente_desde date,
  ultima_compra date
);
create index clientes_empresa_idx     on hub.clientes (empresa_id);
create unique index clientes_telefone_empresa
  on hub.clientes (empresa_id, telefone);

create table hub.conversas (
  id                   uuid primary key default gen_random_uuid(),
  cliente_id           uuid references hub.clientes(id),
  canal_id             uuid references hub.canais(id),
  setor_id             uuid references hub.setores(id),
  atendente_id         uuid references hub.atendentes(id),
  status               text not null default 'novo',
  desfecho             text,
  motivo_perda         text,
  valor_venda          numeric,
  etiquetas            text[] default '{}',
  nota_satisfacao      int,
  sentimento           text,
  nao_lidas            int default 0,
  aberta_em            timestamptz default now(),
  primeira_resposta_em timestamptz,
  fechada_em           timestamptz,
  constraint motivo_obrigatorio
    check (desfecho <> 'nao_vendeu' or motivo_perda is not null)
);
create index conversas_setor_idx     on hub.conversas (setor_id);
create index conversas_canal_idx     on hub.conversas (canal_id);
create index conversas_atendente_idx on hub.conversas (atendente_id);
create index conversas_cliente_idx   on hub.conversas (cliente_id);
create index conversas_status_aberta_idx on hub.conversas (status, aberta_em desc);

create table hub.mensagens (
  id           uuid primary key default gen_random_uuid(),
  conversa_id  uuid references hub.conversas(id) on delete cascade,
  autor        text not null,
  atendente_id uuid references hub.atendentes(id),
  texto        text not null,
  enviada_em   timestamptz default now(),
  entregue     boolean default true
);
create index mensagens_conversa_idx on hub.mensagens (conversa_id, enviada_em);

create table hub.transferencias (
  id                uuid primary key default gen_random_uuid(),
  conversa_id       uuid references hub.conversas(id) on delete cascade,
  de_setor_id       uuid references hub.setores(id),
  para_setor_id     uuid references hub.setores(id),
  de_atendente_id   uuid references hub.atendentes(id),
  para_atendente_id uuid references hub.atendentes(id),
  nota_interna      text,
  transferida_em    timestamptz default now()
);
create index transferencias_conversa_idx on hub.transferencias (conversa_id);

create table hub.kanban_colunas (
  id            uuid primary key default gen_random_uuid(),
  setor_id      uuid references hub.setores(id) on delete cascade,
  nome          text not null,
  ordem         int not null,
  fecha_chamado boolean default false
);
create unique index kanban_colunas_setor_ordem
  on hub.kanban_colunas (setor_id, ordem);

grant select, insert, update, delete on all tables in schema hub to authenticated;
grant all                            on all tables in schema hub to service_role;
grant usage, select                   on all sequences in schema hub to authenticated, service_role;

alter default privileges in schema hub
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema hub
  grant all on tables to service_role;

do $$
declare r record;
begin
  for r in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'hub' and c.relkind = 'r'
    order by c.relname
  loop
    execute format('alter table hub.%I enable row level security', r.relname);
  end loop;
end $$;

create or replace function hub.meu_atendente_id()
returns uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select a.id
  from hub.atendentes a
  where a.ativo
    and (
      a.user_id = auth.uid()
      or (
        a.user_id is null
        and lower(a.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
      )
    )
  order by (a.user_id is not null) desc
  limit 1
$$;

create or replace function hub.meu_perfil()
returns text
language sql
stable
security definer
set search_path = hub, public
as $$
  select a.perfil from hub.atendentes a
  where lower(a.email) = lower((select u.email from auth.users u where u.id = auth.uid()))
  limit 1
$$;

create or replace function hub.sou_admin()
returns boolean
language sql
stable
security definer
set search_path = hub, public
as $$
  -- coalesce: sem atendente correspondente, `meu_perfil()` é null e
  -- `null = 'admin'` é null, não false. Numa política RLS, null e false
  -- negam igual — mas `sou_admin() or <outra coisa>` com null à esquerda
  -- depende do lado direito, e isso é sutil demais para deixar implícito.
  select coalesce(hub.meu_perfil() = 'admin', false)
$$;

create or replace function hub.minhas_empresas()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select ae.empresa_id from hub.atendente_empresas ae
  where ae.atendente_id = hub.meu_atendente_id()
$$;

create or replace function hub.meus_setores()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select s.id from hub.setores s
  where s.empresa_id in (select hub.minhas_empresas())
$$;

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

revoke all on function hub.meu_atendente_id()  from public;
revoke all on function hub.meu_perfil()        from public;
revoke all on function hub.sou_admin()         from public;
revoke all on function hub.minhas_empresas()   from public;
revoke all on function hub.meus_setores()      from public;
revoke all on function hub.minhas_conversas()  from public;

grant execute on function hub.meu_atendente_id() to authenticated, service_role;
grant execute on function hub.meu_perfil()       to authenticated, service_role;
grant execute on function hub.sou_admin()        to authenticated, service_role;
grant execute on function hub.minhas_empresas()  to authenticated, service_role;
grant execute on function hub.meus_setores()     to authenticated, service_role;
grant execute on function hub.minhas_conversas() to authenticated, service_role;

create or replace function hub.vincular_usuario(p_user_id uuid, p_email text)
returns void
language sql
security definer
set search_path = hub, public
as $$
  update hub.atendentes
  set user_id = p_user_id
  where user_id is null
    and lower(email) = lower(p_email)
$$;

revoke all on function hub.vincular_usuario(uuid, text) from public, anon, authenticated;
grant execute on function hub.vincular_usuario(uuid, text) to service_role;

create policy empresas_select on hub.empresas for select to authenticated
  using (hub.sou_admin() or id in (select hub.minhas_empresas()));
create policy empresas_admin_write on hub.empresas for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy setores_select on hub.setores for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));
create policy setores_admin_write on hub.setores for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy kanban_colunas_select on hub.kanban_colunas for select to authenticated
  using (hub.sou_admin() or setor_id in (select hub.meus_setores()));
create policy kanban_colunas_admin_write on hub.kanban_colunas for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy canais_select on hub.canais for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));
create policy canais_admin_write on hub.canais for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy canal_atendentes_select on hub.canal_atendentes for select to authenticated
  using (
    hub.sou_admin() or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );
create policy canal_atendentes_admin_write on hub.canal_atendentes for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy canal_atribuicoes_select on hub.canal_atribuicoes for select to authenticated
  using (
    hub.sou_admin() or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );
create policy canal_atribuicoes_admin_write on hub.canal_atribuicoes for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy atendentes_select on hub.atendentes for select to authenticated
  using (
    hub.sou_admin()
    or id = hub.meu_atendente_id()
    or id in (
      select ae.atendente_id from hub.atendente_empresas ae
      where ae.empresa_id in (select hub.minhas_empresas())
    )
  );
create policy atendentes_admin_write on hub.atendentes for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy atendente_empresas_select on hub.atendente_empresas for select to authenticated
  using (
    hub.sou_admin()
    or atendente_id = hub.meu_atendente_id()
    or empresa_id in (select hub.minhas_empresas())
  );
create policy atendente_empresas_admin_write on hub.atendente_empresas for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy supervisao_select on hub.supervisao for select to authenticated
  using (hub.sou_admin() or supervisor_id = hub.meu_atendente_id());
create policy supervisao_admin_write on hub.supervisao for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy clientes_select on hub.clientes for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));

create policy clientes_insert on hub.clientes for insert to authenticated
  with check (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));

create policy clientes_update on hub.clientes for update to authenticated
  using      (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()))
  with check (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));

create policy clientes_delete on hub.clientes for delete to authenticated
  using (hub.sou_admin());

create policy conversas_select on hub.conversas for select to authenticated
  using (
    hub.sou_admin()
    or setor_id in (select hub.meus_setores())
    or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );

create policy conversas_insert on hub.conversas for insert to authenticated
  with check (
    hub.sou_admin()
    or setor_id in (select hub.meus_setores())
    or canal_id in (
      select c.id from hub.canais c
      where c.empresa_id in (select hub.minhas_empresas())
    )
  );

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

create policy conversas_delete on hub.conversas for delete to authenticated
  using (hub.sou_admin());

create policy mensagens_select on hub.mensagens for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy mensagens_insert on hub.mensagens for insert to authenticated
  with check (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy mensagens_update on hub.mensagens for update to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy mensagens_delete on hub.mensagens for delete to authenticated
  using (hub.sou_admin());

create policy transferencias_select on hub.transferencias for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy transferencias_insert on hub.transferencias for insert to authenticated
  with check (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy transferencias_update on hub.transferencias for update to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy transferencias_delete on hub.transferencias for delete to authenticated
  using (hub.sou_admin());

alter table hub.transferencias
  add constraint transferencia_nota_obrigatoria
  check (
    de_setor_id is null
    or para_setor_id is null
    or de_setor_id = para_setor_id
    or (nota_interna is not null and length(btrim(nota_interna)) > 0)
  );

alter table hub.conversas replica identity full;
alter table hub.mensagens replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'Publicação `supabase_realtime` não existe neste projeto. O Realtime '
      'do Hub não funcionaria, e o contrato front/back depende dele. '
      'Criar a publicação (Dashboard -> Database -> Replication) e reaplicar. '
      'NÃO transformar isto em warning: o plano-base §2.2 registra que a '
      'migration do Lovable engolia exatamente esta falha.';
  end if;
end $$;

do $$
declare
  t text;
  v_add int := 0;
begin
  foreach t in array array['conversas', 'mensagens']
  loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = t
    ) then
      raise notice 'já publicada: hub.%', t;
    else
      execute format('alter publication supabase_realtime add table hub.%I', t);
      v_add := v_add + 1;
      raise notice 'publicada: hub.%', t;
    end if;
  end loop;
  raise notice '-> % tabela(s) adicionada(s) à publicação.', v_add;
end $$;

do $$
declare v_faltando text;
begin
  select string_agg(t, ', ') into v_faltando
  from unnest(array['conversas','mensagens']) as t
  where not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = t
  );

  if v_faltando is not null then
    raise exception 'Realtime incompleto: hub.{%} não está na publicação.', v_faltando;
  end if;

  raise notice '=== OK: hub.conversas e hub.mensagens publicadas no Realtime. ===';
end $$;

create table hub.canal_sessoes (
  canal_id      uuid primary key references hub.canais(id) on delete cascade,
  creds         jsonb,
  keys          jsonb,
  atualizado_em timestamptz default now()
);

revoke all on hub.canal_sessoes from authenticated;
grant all  on hub.canal_sessoes to service_role;
alter table hub.canal_sessoes enable row level security;

comment on table hub.canal_sessoes is
  'Auth state do Baileys. SEGREDO: nunca expor ao front. Sem política de '
  'RLS de propósito — só service_role acessa.';

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

create table hub.agentes_config (
  canal_id       uuid primary key references hub.canais(id) on delete cascade,
  ativo          boolean not null default false,
  prompt         text,
  tom            text default 'cordial',
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

alter table hub.conversas
  add column motivo_perda_id uuid references hub.motivos_perda(id);
create index conversas_motivo_perda_idx on hub.conversas (motivo_perda_id);

alter table hub.conversas drop constraint motivo_obrigatorio;
alter table hub.conversas
  add constraint motivo_obrigatorio
  check (desfecho <> 'nao_vendeu' or motivo_perda_id is not null);

comment on column hub.conversas.motivo_perda is
  'Observação livre complementar. A categoria agrupável é motivo_perda_id.';

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

create unique index mensagens_wa_message_id_unico
  on hub.mensagens (wa_message_id)
  where wa_message_id is not null;

create index mensagens_status_pendente_idx
  on hub.mensagens (status_entrega, enviada_em)
  where status_entrega in ('pendente','falhou');

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
create policy auditoria_select on hub.auditoria for select to authenticated
  using (
    hub.sou_admin()
    or (hub.meu_perfil() = 'supervisor'
        and empresa_id in (select hub.minhas_empresas()))
  );

grant select, insert, update, delete on all tables    in schema hub to authenticated;
grant all                            on all tables    in schema hub to service_role;
grant usage, select                  on all sequences in schema hub to authenticated, service_role;

revoke all on hub.canal_sessoes from authenticated;
revoke insert, update, delete on hub.auditoria     from authenticated;
revoke insert, update, delete on hub.eventos_canal from authenticated;

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

alter table hub.canais
  add column ura_ativa          boolean not null default false,
  add column ura_saudacao       text,
  add column ura_horario_inicio time,
  add column ura_horario_fim    time,
  add constraint canais_ura_horario_check
    check (ura_horario_inicio is null or ura_horario_fim is null
           or ura_horario_inicio < ura_horario_fim);

alter table hub.conversas
  add column ura_estado     text,
  add column ura_tentativas int not null default 0,
  add constraint conversas_ura_tentativas_check check (ura_tentativas >= 0);

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

alter table hub.conversas
  add column atualizado_em timestamptz not null default now();

create index conversas_atualizado_em_idx on hub.conversas (atualizado_em desc);

create unique index if not exists conversas_aberta_por_cliente_canal
  on hub.conversas (cliente_id, canal_id) where fechada_em is null;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'Publicação `supabase_realtime` não existe neste projeto — mesma falha fechada '
      'de 20260731000200_hub_realtime.sql.';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'eventos_canal'
  ) then
    raise notice 'já publicada: hub.eventos_canal';
  else
    alter publication supabase_realtime add table hub.eventos_canal;
    raise notice 'publicada: hub.eventos_canal';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'eventos_canal'
  ) then
    raise exception 'Realtime incompleto: hub.eventos_canal não está na publicação.';
  end if;
  raise notice '=== OK: hub.eventos_canal publicada no Realtime. ===';
end $$;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'Publicação `supabase_realtime` não existe neste projeto — mesma falha fechada '
      'de 20260731000200_hub_realtime.sql.';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'canais'
  ) then
    raise notice 'já publicada: hub.canais';
  else
    alter publication supabase_realtime add table hub.canais;
    raise notice 'publicada: hub.canais';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'canais'
  ) then
    raise exception 'Realtime incompleto: hub.canais não está na publicação.';
  end if;
  raise notice '=== OK: hub.canais publicada no Realtime. ===';
end $$;

alter table hub.canais
  add column if not exists criado_em timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes' and column_name = 'user_id'
  ) then
    raise exception
      'hub.atendentes.user_id não existe — rodar antes as migrations '
      'base do Hub (20260731000000_hub_schema.sql e seguintes).';
  end if;
end $$;

alter table hub.atendentes
  add column if not exists convite_enviado_em timestamptz;

create unique index if not exists atendentes_user_id_unico
  on hub.atendentes (user_id)
  where user_id is not null;

drop function if exists hub.vincular_usuario(uuid, text);

create function hub.vincular_usuario(p_user_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = hub, public
as $$
declare
  v_linhas int;
begin
  update hub.atendentes
  set user_id = p_user_id
  where user_id is null
    and lower(email) = lower(p_email);
  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end;
$$;

revoke all on function hub.vincular_usuario(uuid, text) from public, anon, authenticated;
grant execute on function hub.vincular_usuario(uuid, text) to service_role;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes'
      and column_name = 'convite_enviado_em'
  ) then
    raise exception 'convite_enviado_em não foi criada — migration incompleta.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'hub' and tablename = 'atendentes'
      and indexname = 'atendentes_user_id_unico'
  ) then
    raise exception 'atendentes_user_id_unico não foi criado — migration incompleta.';
  end if;

  if (select pg_get_function_result(oid) from pg_proc
      where proname = 'vincular_usuario'
        and pronamespace = 'hub'::regnamespace) <> 'boolean' then
    raise exception 'hub.vincular_usuario não está retornando boolean — migration incompleta.';
  end if;

  raise notice '=== OK: convite_enviado_em, índice único e vincular_usuario(boolean) aplicados. ===';
end $$;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'hub' and table_name = 'atendente_empresas'
  ) then
    raise exception
      'hub.atendente_empresas não existe — rodar antes as migrations '
      'base do Hub (20260731000000_hub_schema.sql e seguintes).';
  end if;
end $$;

alter table hub.atendentes
  add column if not exists acesso_todas_empresas boolean not null default false;

create or replace function hub.sincroniza_acesso_total_nova_empresa()
returns trigger
language plpgsql
security definer
set search_path = hub, public
as $$
begin
  insert into hub.atendente_empresas (atendente_id, empresa_id)
  select a.id, new.id
  from hub.atendentes a
  where a.acesso_todas_empresas
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function hub.sincroniza_acesso_total_nova_empresa() from public, anon, authenticated;

drop trigger if exists trg_empresas_sincroniza_acesso_total on hub.empresas;
create trigger trg_empresas_sincroniza_acesso_total
  after insert on hub.empresas
  for each row
  execute function hub.sincroniza_acesso_total_nova_empresa();

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes'
      and column_name = 'acesso_todas_empresas'
  ) then
    raise exception 'acesso_todas_empresas não foi criada — migration incompleta.';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_empresas_sincroniza_acesso_total'
      and not tgisinternal
  ) then
    raise exception 'trigger de sincronização não foi criado — migration incompleta.';
  end if;

  raise notice '=== OK: acesso_todas_empresas e trigger de sincronização aplicados. ===';
end $$;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
end $$;

alter table hub.empresas
  add column if not exists razao_social  text,
  add column if not exists nome_fantasia text,
  add column if not exists ativo         boolean not null default true;

do $$
begin
  if exists (
    select cnpj from hub.empresas
    where cnpj is not null and ativo
    group by cnpj having count(*) > 1
  ) then
    raise notice 'AVISO: já existem CNPJs duplicados entre empresas ativas — índice único NÃO criado.';
  else
    create unique index if not exists empresas_cnpj_ativo_unique_idx
      on hub.empresas (cnpj) where cnpj is not null and ativo;
  end if;
end $$;

drop policy if exists empresas_select on hub.empresas;
create policy empresas_select on hub.empresas for select to authenticated
  using (hub.sou_admin() or (ativo and id in (select hub.minhas_empresas())));

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'empresas' and column_name = 'ativo'
  ) then
    raise exception 'ativo não foi criada — migration incompleta.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'empresas' and column_name = 'razao_social'
  ) then
    raise exception 'razao_social não foi criada — migration incompleta.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'empresas' and column_name = 'nome_fantasia'
  ) then
    raise exception 'nome_fantasia não foi criada — migration incompleta.';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'hub' and tablename = 'empresas' and policyname = 'empresas_select'
  ) then
    raise exception 'policy empresas_select não foi recriada — migration incompleta.';
  end if;

  raise notice '=== OK: razao_social, nome_fantasia, ativo e RLS aplicados em hub.empresas. ===';
end $$;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'hub' and table_name = 'clientes'
  ) then
    raise exception
      'hub.clientes não existe — rodar antes as migrations base do Hub '
      '(20260731000000_hub_schema.sql e seguintes).';
  end if;
end $$;

alter table hub.clientes add column if not exists wa_jid text;

create unique index if not exists clientes_wa_jid_empresa
  on hub.clientes (empresa_id, wa_jid)
  where wa_jid is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'clientes' and column_name = 'wa_jid'
  ) then
    raise exception 'hub.clientes.wa_jid não foi criada — migration incompleta.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'hub' and tablename = 'clientes' and indexname = 'clientes_wa_jid_empresa'
  ) then
    raise exception 'índice clientes_wa_jid_empresa não foi criado — migration incompleta.';
  end if;

  raise notice '=== OK: hub.clientes.wa_jid criada e indexada. ===';
end $$;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception 'Schema `hub` não existe. Abortando.';
  end if;
end $$;

create or replace function hub.concede_acesso_criador_empresa()
returns trigger
language plpgsql
security definer
set search_path = hub, public
as $$
declare
  v_atendente uuid := hub.meu_atendente_id();
begin
  if v_atendente is not null then
    insert into hub.atendente_empresas (atendente_id, empresa_id)
    values (v_atendente, new.id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function hub.concede_acesso_criador_empresa() from public, anon, authenticated;

drop trigger if exists trg_empresas_concede_acesso_criador on hub.empresas;
create trigger trg_empresas_concede_acesso_criador
  after insert on hub.empresas
  for each row
  execute function hub.concede_acesso_criador_empresa();

insert into hub.atendente_empresas (atendente_id, empresa_id)
select a.id, e.id
from hub.atendentes a
cross join hub.empresas e
where a.perfil = 'admin' and a.ativo
  and not exists (
    select 1 from hub.atendente_empresas ae
    where ae.atendente_id = a.id and ae.empresa_id = e.id
  )
on conflict do nothing;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'atendentes'
      and column_name = 'acesso_todas_empresas'
  ) then
    insert into hub.atendente_empresas (atendente_id, empresa_id)
    select a.id, e.id
    from hub.atendentes a
    cross join hub.empresas e
    where a.acesso_todas_empresas
      and not exists (
        select 1 from hub.atendente_empresas ae
        where ae.atendente_id = a.id and ae.empresa_id = e.id
      )
    on conflict do nothing;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_empresas_concede_acesso_criador' and not tgisinternal
  ) then
    raise exception 'trigger de vínculo automático não foi criado — migration incompleta.';
  end if;
  if exists (
    select 1 from hub.empresas e
    where e.ativo
      and not exists (
        select 1 from hub.atendentes a
        join hub.atendente_empresas ae on ae.atendente_id = a.id and ae.empresa_id = e.id
        where a.perfil = 'admin'
      )
  ) then
    raise exception 'ainda existe empresa ativa sem nenhum admin vinculado — backfill incompleto.';
  end if;
  raise notice '=== OK: trigger criado e backfill aplicado — toda empresa ativa agora tem pelo menos 1 admin vinculado. ===';
end $$;

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

drop index if exists hub.mensagens_wa_message_id_unico;

create unique index if not exists mensagens_wa_message_id_unico
  on hub.mensagens (conversa_id, wa_message_id)
  where wa_message_id is not null;

do $$
declare
  def text;
begin
  select indexdef into def
  from pg_indexes
  where schemaname = 'hub' and tablename = 'mensagens'
    and indexname = 'mensagens_wa_message_id_unico';
  if def is null or position('conversa_id' in def) = 0 then
    raise exception 'mensagens_wa_message_id_unico não ficou por (conversa_id, wa_message_id) — migration incompleta.';
  end if;
  raise notice '=== OK: idempotência de wa_message_id agora é por conversa. ===';
end $$;

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

alter table hub.conversas
  add column if not exists titulo_ia text,
  add column if not exists titulo_ia_gerado_em timestamptz;

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
notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'hub' and table_name = 'conversas'
  ) then
    raise exception
      'hub.conversas não existe — rodar antes as migrations base do Hub '
      '(20260731000000_hub_schema.sql e seguintes).';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'hub' and table_name = 'motivos_perda'
  ) then
    raise exception
      'hub.motivos_perda não existe — rodar antes 20260731000300_hub_operacao.sql '
      '(motivo_perda_sugerido_id tem FK para ela).';
  end if;
end $$;

alter table hub.conversas
  add column if not exists sentimento_atualizado_em timestamptz,
  add column if not exists risco text,
  add column if not exists risco_motivo text,
  add column if not exists risco_atualizado_em timestamptz,
  add column if not exists motivo_perda_sugerido_id uuid references hub.motivos_perda(id) on delete set null,
  add column if not exists analise_ia_modelo text,
  add column if not exists analise_ia_erro text,
  add column if not exists avaliacao_solicitada_em timestamptz,
  add column if not exists avaliacao_registrada_em timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'hub.conversas'::regclass and conname = 'conversas_risco_valido'
  ) then
    alter table hub.conversas
      add constraint conversas_risco_valido
      check (risco is null or risco in ('baixo','medio','alto')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'hub.conversas'::regclass and conname = 'conversas_nota_satisfacao_valida'
  ) then
    alter table hub.conversas
      add constraint conversas_nota_satisfacao_valida
      check (nota_satisfacao is null or nota_satisfacao between 1 and 5) not valid;
  end if;
end $$;

alter table hub.conversas validate constraint conversas_risco_valido;
alter table hub.conversas validate constraint conversas_nota_satisfacao_valida;

create index if not exists conversas_risco_aberto_idx
  on hub.conversas (risco)
  where fechada_em is null and risco in ('medio','alto');

create index if not exists conversas_avaliacao_pendente_idx
  on hub.conversas (cliente_id, canal_id, avaliacao_solicitada_em)
  where avaliacao_solicitada_em is not null and nota_satisfacao is null;

do $$
declare
  faltando text;
begin
  select string_agg(c.esperada, ', ')
    into faltando
  from (values
      ('sentimento_atualizado_em'), ('risco'), ('risco_motivo'), ('risco_atualizado_em'),
      ('motivo_perda_sugerido_id'), ('analise_ia_modelo'), ('analise_ia_erro'),
      ('avaliacao_solicitada_em'), ('avaliacao_registrada_em')
    ) as c(esperada)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'conversas' and column_name = c.esperada
  );
  if faltando is not null then
    raise exception 'colunas não criadas em hub.conversas: % — migration incompleta.', faltando;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'hub.conversas'::regclass
      and conname = 'conversas_risco_valido' and convalidated
  ) then
    raise exception 'constraint conversas_risco_valido ausente ou não validada.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'hub.conversas'::regclass
      and conname = 'conversas_nota_satisfacao_valida' and convalidated
  ) then
    raise exception 'constraint conversas_nota_satisfacao_valida ausente ou não validada.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'hub' and tablename = 'conversas' and indexname = 'conversas_risco_aberto_idx'
  ) then
    raise exception 'índice conversas_risco_aberto_idx não foi criado.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'hub' and tablename = 'conversas' and indexname = 'conversas_avaliacao_pendente_idx'
  ) then
    raise exception 'índice conversas_avaliacao_pendente_idx não foi criado.';
  end if;

  raise notice '=== OK: colunas de análise de IA e CSAT criadas em hub.conversas. ===';
end $$;

alter table hub.conversas
  add column if not exists nota_atendimento      text,
  add column if not exists nota_atendimento_por  uuid references hub.atendentes(id),
  add column if not exists nota_atendimento_em   timestamptz;

comment on column hub.conversas.nota_atendimento is
  'Anotação interna do atendimento, escrita por humano na Ficha. NUNCA é enviada ao cliente.';
comment on column hub.conversas.nota_atendimento_em is
  'Carimbo da última edição. É também a VERSÃO usada pela guarda de concorrência do front.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversas_nota_atendimento_tamanho'
      and conrelid = 'hub.conversas'::regclass
  ) then
    alter table hub.conversas
      add constraint conversas_nota_atendimento_tamanho
      check (
        nota_atendimento is null
        or char_length(btrim(nota_atendimento)) between 1 and 4000
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversas_nota_atendimento_carimbo'
      and conrelid = 'hub.conversas'::regclass
  ) then
    alter table hub.conversas
      add constraint conversas_nota_atendimento_carimbo
      check (nota_atendimento is null or nota_atendimento_em is not null);
  end if;
end $$;

create table if not exists hub.conversa_notas (
  id           bigserial primary key,
  conversa_id  uuid not null references hub.conversas(id) on delete cascade,
  nota         text,
  atendente_id uuid references hub.atendentes(id),
  criado_em    timestamptz not null default now()
);

create index if not exists conversa_notas_conversa_idx
  on hub.conversa_notas (conversa_id, criado_em desc);

alter table hub.conversa_notas enable row level security;

drop policy if exists conversa_notas_select on hub.conversa_notas;
create policy conversa_notas_select on hub.conversa_notas for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

revoke insert, update, delete on hub.conversa_notas from authenticated;
grant  select                 on hub.conversa_notas to authenticated;
grant  all                    on hub.conversa_notas to service_role;
grant  usage, select          on sequence hub.conversa_notas_id_seq to service_role;

create or replace function hub.registrar_nota_atendimento()
returns trigger
language plpgsql
security definer
set search_path = hub, public
as $$
declare
  v_empresa uuid;
begin
  -- coalesce nos dois lados: null -> '' -> null não gera registro falso.
  if coalesce(new.nota_atendimento, '') is distinct from coalesce(old.nota_atendimento, '') then
    -- A empresa vem do CANAL, não do setor: canal_id nunca é nulo em conversas
    -- reais e setor_id pode ser (mesma razão documentada no filtro da Caixa).
    select c.empresa_id into v_empresa from hub.canais c where c.id = new.canal_id;

    insert into hub.conversa_notas (conversa_id, nota, atendente_id)
    values (new.id, new.nota_atendimento, new.nota_atendimento_por);

    insert into hub.auditoria
      (empresa_id, atendente_id, acao, entidade, entidade_id, antes, depois, origem)
    values (
      v_empresa,
      new.nota_atendimento_por,
      case when new.nota_atendimento is null
           then 'nota_atendimento_apagada'
           else 'nota_atendimento' end,
      'conversas',
      new.id,
      jsonb_build_object('nota', old.nota_atendimento),
      jsonb_build_object('nota', new.nota_atendimento),
      'trigger'
    );
  end if;
  return new;
end $$;

drop trigger if exists conversas_registrar_nota on hub.conversas;
create trigger conversas_registrar_nota
  after update of nota_atendimento on hub.conversas
  for each row execute function hub.registrar_nota_atendimento();

do $$
declare
  n_cols int;
  n_invalidas bigint;
begin
  select count(*) into n_cols from information_schema.columns
   where table_schema = 'hub' and table_name = 'conversas'
     and column_name in ('nota_atendimento', 'nota_atendimento_por', 'nota_atendimento_em');
  if n_cols <> 3 then
    raise exception 'nota_atendimento: esperava 3 colunas em hub.conversas, encontrei % — migration incompleta.', n_cols;
  end if;

  if not exists (select 1 from pg_constraint
                 where conname = 'conversas_nota_atendimento_tamanho'
                   and conrelid = 'hub.conversas'::regclass) then
    raise exception 'nota_atendimento: constraint de tamanho ausente.';
  end if;

  if not exists (select 1 from pg_constraint
                 where conname = 'conversas_nota_atendimento_carimbo'
                   and conrelid = 'hub.conversas'::regclass) then
    raise exception 'nota_atendimento: constraint de carimbo ausente.';
  end if;

  -- Se alguma linha já violasse o carimbo, TODO update futuro dessa linha
  -- passaria a falhar (inclusive fechar chamado). Barra antes do commit.
  select count(*) into n_invalidas from hub.conversas
   where nota_atendimento is not null and nota_atendimento_em is null;
  if n_invalidas > 0 then
    raise exception 'nota_atendimento: % linha(s) já violam o carimbo.', n_invalidas;
  end if;

  if to_regclass('hub.conversa_notas') is null then
    raise exception 'nota_atendimento: tabela hub.conversa_notas não criada.';
  end if;

  if not exists (select 1 from pg_class
                 where oid = 'hub.conversa_notas'::regclass and relrowsecurity) then
    raise exception 'nota_atendimento: RLS desligada em hub.conversa_notas.';
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname = 'hub' and tablename = 'conversa_notas'
                   and policyname = 'conversa_notas_select') then
    raise exception 'nota_atendimento: policy de leitura ausente em hub.conversa_notas.';
  end if;

  -- Append-only: authenticated lê e nada mais.
  if has_table_privilege('authenticated', 'hub.conversa_notas', 'insert')
     or has_table_privilege('authenticated', 'hub.conversa_notas', 'update')
     or has_table_privilege('authenticated', 'hub.conversa_notas', 'delete') then
    raise exception 'nota_atendimento: hub.conversa_notas NÃO está append-only para authenticated.';
  end if;
  if not has_table_privilege('authenticated', 'hub.conversa_notas', 'select') then
    raise exception 'nota_atendimento: authenticated não consegue ler hub.conversa_notas.';
  end if;

  if not exists (select 1 from pg_trigger
                 where tgname = 'conversas_registrar_nota'
                   and tgrelid = 'hub.conversas'::regclass) then
    raise exception 'nota_atendimento: trigger conversas_registrar_nota ausente.';
  end if;

  raise notice '=== OK: nota do atendimento pronta (3 colunas + 2 constraints + histórico + trigger). ===';
end $$;
notify pgrst, 'reload schema';

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'hub' and table_name = 'conversas'
  ) then
    raise exception 'hub.conversas não existe — rodar antes as migrations base do Hub.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'conversas' and column_name = 'risco'
  ) then
    raise exception
      'hub.conversas.risco não existe — aplicar antes 20260808201000_hub_ia_analise_csat.sql. '
      'O coach só é gerado quando há risco; sem aquela coluna esta feature não tem gatilho.';
  end if;
end $$;

alter table hub.conversas
  add column if not exists coach_sugestoes     text[],
  add column if not exists coach_orientacoes   text[],
  add column if not exists coach_atualizado_em timestamptz;

comment on column hub.conversas.coach_sugestoes is
  'Ate 3 respostas prontas geradas pela IA quando risco e medio/alto '
  '(services/analiseIA.ts). O atendente CLICA para preencher o campo de '
  'resposta na Caixa; nunca ha envio automatico.';
comment on column hub.conversas.coach_orientacoes is
  'Orientacoes de conduta especificas desta conversa + a linha de escalonamento '
  'montada em codigo (o nome do supervisor nunca vem do modelo). As orientacoes '
  'fixas ("respire", "aja com profissionalismo") vivem no front, nao aqui.';
comment on column hub.conversas.coach_atualizado_em is
  'Quando o coach foi gerado. O front compara com a ultima mensagem do fio para '
  'marcar as sugestoes como obsoletas. As tres colunas se movem JUNTAS: ou ha '
  'coach completo, ou as tres sao nulas (ver reconciliacao R7 no rodape).';

do $$
declare
  faltando text;
begin
  select string_agg(c.esperada, ', ')
    into faltando
  from (values
      ('coach_sugestoes'), ('coach_orientacoes'), ('coach_atualizado_em')
    ) as c(esperada)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'conversas' and column_name = c.esperada
  );
  if faltando is not null then
    raise exception 'colunas não criadas em hub.conversas: % — migration incompleta.', faltando;
  end if;

  if (select count(*) from information_schema.columns
       where table_schema = 'hub' and table_name = 'conversas'
         and column_name in ('coach_sugestoes', 'coach_orientacoes')
         and data_type = 'ARRAY') <> 2 then
    raise exception
      'coach_sugestoes/coach_orientacoes não são arrays — tipo errado. '
      'O front espera string[] direto do supabase-js, sem parse.';
  end if;

  raise notice '=== OK: colunas do coach criadas em hub.conversas. ===';
end $$;

create index if not exists conversas_aberta_em_idx
  on hub.conversas (aberta_em desc);

comment on index hub.conversas_aberta_em_idx is
  'Janela temporal do contexto da Alice (services/alice.ts) e do Painel. '
  'Complementa conversas_status_aberta_idx, que só serve a consultas com status.';

do $$
begin
  if not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'hub'
       and c.relname = 'conversas_aberta_em_idx'
       and c.relkind = 'i'
  ) then
    raise exception 'FALHOU: hub.conversas_aberta_em_idx não existe ao fim do bloco';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'hub' and p.proname = 'meu_atendente_id'
  ) then
    raise exception 'hub.meu_atendente_id() não existe — pré-requisito ausente.';
  end if;
end $$;

create or replace function hub.meu_perfil()
returns text
language sql
stable
security definer
set search_path = hub, public
as $$
  -- Deriva de meu_atendente_id() de propósito: era a ÚNICA função de
  -- identidade que não filtrava `ativo` nem preferia user_id sobre e-mail.
  select a.perfil from hub.atendentes a where a.id = hub.meu_atendente_id()
$$;

revoke all on function hub.meu_perfil() from public;
grant execute on function hub.meu_perfil() to authenticated, service_role;

do $$
declare
  v_src  text;
  v_sec  boolean;
  v_vol  char;
  v_cfg  text[];
  v_auth boolean;
begin
  select p.prosrc, p.prosecdef, p.provolatile, p.proconfig
    into v_src, v_sec, v_vol, v_cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'hub' and p.proname = 'meu_perfil';

  if v_src is null then
    raise exception 'hub.meu_perfil() sumiu depois do replace.';
  end if;
  if position('meu_atendente_id' in v_src) = 0 then
    raise exception 'hub.meu_perfil() NÃO passou a usar meu_atendente_id() — corpo: %', v_src;
  end if;
  if position('auth.users' in v_src) > 0 then
    raise exception 'hub.meu_perfil() ainda resolve por auth.users — replace não pegou.';
  end if;
  if not v_sec then
    raise exception 'hub.meu_perfil() perdeu SECURITY DEFINER.';
  end if;
  if v_vol <> 's' then
    raise exception 'hub.meu_perfil() deixou de ser STABLE (volatile=%).', v_vol;
  end if;
  if v_cfg is null or not (v_cfg @> array['search_path=hub, public']) then
    raise exception 'hub.meu_perfil() sem search_path fixo — proconfig: %', v_cfg;
  end if;

  select has_function_privilege('authenticated', 'hub.meu_perfil()', 'EXECUTE')
    into v_auth;
  if not v_auth then
    raise exception 'authenticated perdeu EXECUTE em hub.meu_perfil().';
  end if;

  raise notice '=== OK: hub.meu_perfil() agora deriva de meu_atendente_id(), SECURITY DEFINER + STABLE + search_path fixo, EXECUTE preservado. ===';
end $$;

alter table hub.mensagens
  add column if not exists tipo_mensagem          text not null default 'texto',
  add column if not exists midia_objeto           text,
  add column if not exists midia_thumb_objeto     text,
  add column if not exists midia_nome             text,
  add column if not exists midia_tamanho          bigint,
  add column if not exists midia_duracao_seg      integer,
  add column if not exists midia_largura          integer,
  add column if not exists midia_altura           integer,
  add column if not exists midia_status           text not null default 'nao_aplicavel',
  add column if not exists midia_erro             text,
  add column if not exists transcricao            text,
  add column if not exists transcricao_status     text not null default 'nao_aplicavel',
  add column if not exists transcricao_erro       text,
  add column if not exists transcricao_gerada_em  timestamptz,
  add column if not exists autor_wa_jid           text,
  add column if not exists autor_nome             text,
  add column if not exists respondendo_a_wa_id    text,
  add column if not exists editada_em             timestamptz,
  add column if not exists apagada_em             timestamptz,
  add column if not exists reacoes                jsonb not null default '[]'::jsonb,
  add column if not exists conteudo_extra         jsonb,
  add column if not exists midia_ref              jsonb;

comment on column hub.mensagens.tipo_mensagem is
  'Tipo do conteúdo no WhatsApp. "desconhecido" é PROPOSITAL: mensagem de tipo novo entra com o payload em conteudo_extra em vez de ser descartada em silêncio — nenhuma mensagem recebida pode sumir da thread.';
comment on column hub.mensagens.midia_objeto is
  'CAMINHO do objeto no bucket GCS, nunca uma URL assinada (expiram em minutos). A URL é gerada sob demanda por GET /mensagens/:id/midia, que revalida o escopo do atendente.';
comment on column hub.mensagens.midia_url is
  'LEGADO/externo. O fluxo do WhatsApp usa midia_objeto. Não misturar as duas semânticas na mesma coluna.';
comment on column hub.mensagens.midia_status is
  'Ciclo de vida do download: pendente -> pronta | falhou | expirada. "expirada" = o WhatsApp já apagou a mídia do servidor dele (acontece com mensagem recebida depois de dias offline) — é estado final honesto, não erro nosso.';
comment on column hub.mensagens.autor_nome is
  'Quem falou DENTRO de um grupo (pushName do participante). Null em conversa individual — lá o autor já é o cliente da conversa.';
comment on column hub.mensagens.reacoes is
  'Reações da própria mensagem: [{"jid":"...","nome":"...","emoji":"👍","em":"..."}]. Reação NÃO cria linha nova, igual ao WhatsApp.';
comment on column hub.mensagens.conteudo_extra is
  'Payload que não virou coluna: coordenadas, vCard, opções de enquete, motivo de tipo desconhecido. É CONTEÚDO — vai para a tela.';
comment on column hub.mensagens.midia_ref is
  'Referência TÉCNICA de download (url/directPath/mediaKey/sha do WhatsApp). Não é conteúdo e não vai para a tela. Existe porque a fila de download é em memória: sem isto, um restart do Cloud Run no meio de um download perderia a mídia para sempre, já que downloadMediaMessage precisa desses campos e o proto original morre com o processo.';

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'mensagens_tipo_mensagem_check'
                   and conrelid = 'hub.mensagens'::regclass) then
    alter table hub.mensagens add constraint mensagens_tipo_mensagem_check
      check (tipo_mensagem in ('texto','imagem','video','audio','voz','documento',
                               'figurinha','localizacao','contato','enquete',
                               'sistema','desconhecido'));
  end if;

  if not exists (select 1 from pg_constraint
                 where conname = 'mensagens_midia_status_check'
                   and conrelid = 'hub.mensagens'::regclass) then
    alter table hub.mensagens add constraint mensagens_midia_status_check
      check (midia_status in ('nao_aplicavel','pendente','baixando','pronta',
                              'falhou','expirada','ignorada'));
  end if;

  if not exists (select 1 from pg_constraint
                 where conname = 'mensagens_transcricao_status_check'
                   and conrelid = 'hub.mensagens'::regclass) then
    alter table hub.mensagens add constraint mensagens_transcricao_status_check
      check (transcricao_status in ('nao_aplicavel','pendente','processando',
                                    'pronta','erro','ignorada'));
  end if;

  -- Espelha mensagens_midia_check (que vale para midia_url): objeto gravado
  -- sem tipo MIME é mídia que o front não sabe renderizar.
  if not exists (select 1 from pg_constraint
                 where conname = 'mensagens_midia_objeto_check'
                   and conrelid = 'hub.mensagens'::regclass) then
    alter table hub.mensagens add constraint mensagens_midia_objeto_check
      check (midia_objeto is null or midia_tipo is not null);
  end if;

  -- Invariante de carimbo, mesmo padrão de conversas.nota_atendimento_em:
  -- transcrição "pronta" SEMPRE tem texto e "quando". Sem isto, um bug do
  -- serviço gravaria status pronto com transcrição nula e a tela mostraria
  -- um bloco de transcrição vazio como se o cliente não tivesse dito nada.
  if not exists (select 1 from pg_constraint
                 where conname = 'mensagens_transcricao_carimbo'
                   and conrelid = 'hub.mensagens'::regclass) then
    alter table hub.mensagens add constraint mensagens_transcricao_carimbo
      check (transcricao_status <> 'pronta'
             or (transcricao is not null and transcricao_gerada_em is not null));
  end if;

  if not exists (select 1 from pg_constraint
                 where conname = 'mensagens_reacoes_array'
                   and conrelid = 'hub.mensagens'::regclass) then
    alter table hub.mensagens add constraint mensagens_reacoes_array
      check (jsonb_typeof(reacoes) = 'array');
  end if;
end $$;

create index if not exists mensagens_midia_pendente_idx
  on hub.mensagens (midia_status, enviada_em)
  where midia_status in ('pendente','baixando','falhou');

create index if not exists mensagens_transcricao_pendente_idx
  on hub.mensagens (transcricao_status, enviada_em)
  where transcricao_status in ('pendente','processando');

alter table hub.clientes
  add column if not exists tipo_chat        text not null default 'individual',
  add column if not exists grupo_assunto_em timestamptz;

comment on column hub.clientes.tipo_chat is
  'individual = contato 1:1. grupo = chat @g.us — nesse caso `telefone` guarda o ID do JID (NÃO é telefone, e ehTelefoneValido() do front já o esconde) e `nome` guarda o assunto do grupo.';
comment on column hub.clientes.grupo_assunto_em is
  'Última sincronização do assunto do grupo via sock.groupMetadata(). Cache de 6h — sem isto, cada mensagem de grupo faria uma chamada ao WhatsApp.';

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'clientes_tipo_chat_check'
                   and conrelid = 'hub.clientes'::regclass) then
    alter table hub.clientes add constraint clientes_tipo_chat_check
      check (tipo_chat in ('individual','grupo'));
  end if;
end $$;

alter table hub.conversas
  add column if not exists origem_chat text not null default 'individual';

comment on column hub.conversas.origem_chat is
  'Cópia de clientes.tipo_chat no momento da abertura. Desnormalizado DE PROPÓSITO: Painel, Fila e Kanban filtram grupos sem join. Mantido coerente pelo trigger conversas_origem_chat_trg — o banco corrige o app, não o contrário.';

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'conversas_origem_chat_check'
                   and conrelid = 'hub.conversas'::regclass) then
    alter table hub.conversas add constraint conversas_origem_chat_check
      check (origem_chat in ('individual','grupo'));
  end if;
end $$;

create index if not exists conversas_origem_chat_idx
  on hub.conversas (origem_chat, aberta_em desc);

create or replace function hub.conversas_origem_chat()
returns trigger
language plpgsql
security definer
set search_path = hub, public
as $$
begin
  select c.tipo_chat into new.origem_chat
  from hub.clientes c where c.id = new.cliente_id;
  if new.origem_chat is null then new.origem_chat := 'individual'; end if;
  return new;
end $$;

drop trigger if exists conversas_origem_chat_trg on hub.conversas;
create trigger conversas_origem_chat_trg
  before insert or update of cliente_id on hub.conversas
  for each row execute function hub.conversas_origem_chat();

alter table hub.canais
  add column if not exists receber_grupos boolean not null default false;

comment on column hub.canais.receber_grupos is
  'false (default) = mensagens de grupo continuam descartadas nesta linha, exatamente como antes desta feature. Desligar é o rollback da fase de grupos: um UPDATE, sem deploy.';

create table if not exists hub.grupo_participantes (
  cliente_id    uuid not null references hub.clientes(id) on delete cascade,
  wa_jid        text not null,
  nome          text,
  admin         boolean not null default false,
  atualizado_em timestamptz not null default now(),
  primary key (cliente_id, wa_jid)
);

comment on table hub.grupo_participantes is
  'Roster do grupo, sincronizado de sock.groupMetadata() com cache de 6h. cliente_id aponta para o hub.clientes com tipo_chat=grupo.';

alter table hub.grupo_participantes enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='hub' and tablename='grupo_participantes'
                   and policyname='grupo_participantes_select') then
    create policy grupo_participantes_select on hub.grupo_participantes
      for select to authenticated
      using (
        hub.sou_admin()
        or cliente_id in (
          select c.id from hub.clientes c
          where c.empresa_id in (select hub.minhas_empresas())
        )
      );
  end if;

  if not exists (select 1 from pg_policies
                 where schemaname='hub' and tablename='grupo_participantes'
                   and policyname='grupo_participantes_admin_write') then
    create policy grupo_participantes_admin_write on hub.grupo_participantes
      for all to authenticated
      using (hub.sou_admin()) with check (hub.sou_admin());
  end if;
end $$;

grant select, insert, update, delete on hub.grupo_participantes to authenticated;
grant all                            on hub.grupo_participantes to service_role;

do $$
declare
  v_cols_msg  int;
  v_cols_cli  int;
  v_cols_conv int;
  v_cols_can  int;
  v_constr    int;
  v_idx       int;
  v_pol       int;
  v_trg       int;
  v_n         int;
begin
  -- 6.1 colunas
  select count(*) into v_cols_msg from information_schema.columns
   where table_schema='hub' and table_name='mensagens'
     and column_name in ('tipo_mensagem','midia_objeto','midia_thumb_objeto','midia_nome',
                         'midia_tamanho','midia_duracao_seg','midia_largura','midia_altura',
                         'midia_status','midia_erro','transcricao','transcricao_status',
                         'transcricao_erro','transcricao_gerada_em','autor_wa_jid','autor_nome',
                         'respondendo_a_wa_id','editada_em','apagada_em','reacoes','conteudo_extra',
                         'midia_ref');
  if v_cols_msg <> 22 then
    raise exception 'hub.mensagens: esperava 22 colunas novas, encontrei %', v_cols_msg;
  end if;

  select count(*) into v_cols_cli from information_schema.columns
   where table_schema='hub' and table_name='clientes'
     and column_name in ('tipo_chat','grupo_assunto_em');
  if v_cols_cli <> 2 then
    raise exception 'hub.clientes: esperava 2 colunas novas, encontrei %', v_cols_cli;
  end if;

  select count(*) into v_cols_conv from information_schema.columns
   where table_schema='hub' and table_name='conversas' and column_name='origem_chat';
  if v_cols_conv <> 1 then raise exception 'hub.conversas.origem_chat não foi criada'; end if;

  select count(*) into v_cols_can from information_schema.columns
   where table_schema='hub' and table_name='canais' and column_name='receber_grupos';
  if v_cols_can <> 1 then raise exception 'hub.canais.receber_grupos não foi criada'; end if;

  -- 6.2 constraints
  select count(*) into v_constr from pg_constraint
   where conname in ('mensagens_tipo_mensagem_check','mensagens_midia_status_check',
                     'mensagens_transcricao_status_check','mensagens_midia_objeto_check',
                     'mensagens_transcricao_carimbo','mensagens_reacoes_array',
                     'clientes_tipo_chat_check','conversas_origem_chat_check');
  if v_constr <> 8 then raise exception 'esperava 8 constraints novas, encontrei %', v_constr; end if;

  -- 6.3 índices
  select count(*) into v_idx from pg_indexes
   where schemaname='hub'
     and indexname in ('mensagens_midia_pendente_idx','mensagens_transcricao_pendente_idx',
                       'conversas_origem_chat_idx');
  if v_idx <> 3 then raise exception 'esperava 3 índices novos, encontrei %', v_idx; end if;

  -- 6.4 tabela nova com RLS LIGADA (estado seguro para falhar), políticas e trigger
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                 where n.nspname='hub' and c.relname='grupo_participantes' and c.relrowsecurity) then
    raise exception 'hub.grupo_participantes ausente ou com RLS DESLIGADA — estado inseguro';
  end if;

  select count(*) into v_pol from pg_policies
   where schemaname='hub' and tablename='grupo_participantes';
  if v_pol < 2 then raise exception 'hub.grupo_participantes com % política(s); esperava 2', v_pol; end if;

  select count(*) into v_trg from pg_trigger
   where tgrelid='hub.conversas'::regclass and tgname='conversas_origem_chat_trg';
  if v_trg <> 1 then raise exception 'trigger conversas_origem_chat_trg não está instalado'; end if;

  -- 6.5 NÃO-REGRESSÃO: nada que já existia pode ter mudado de estado.
  select count(*) into v_n from hub.mensagens
   where tipo_mensagem <> 'texto' or midia_status <> 'nao_aplicavel'
      or transcricao_status <> 'nao_aplicavel';
  if v_n <> 0 then
    raise exception 'defaults não aplicaram: % mensagem(ns) pré-existente(s) fora do estado neutro', v_n;
  end if;

  select count(*) into v_n from hub.conversas where origem_chat <> 'individual';
  if v_n <> 0 then
    raise exception '% conversa(s) pré-existente(s) marcada(s) como grupo — impossível, investigar', v_n;
  end if;

  select count(*) into v_n from hub.canais where receber_grupos;
  if v_n <> 0 then
    raise exception '% canal(is) já com receber_grupos=true — o default TEM que ser false', v_n;
  end if;

  raise notice '=====================================================';
  raise notice 'OK — mídia / grupos / transcrição aplicados.';
  raise notice '  hub.mensagens ........ 22 colunas novas';
  raise notice '  hub.clientes ......... tipo_chat, grupo_assunto_em';
  raise notice '  hub.conversas ........ origem_chat + trigger de coerência';
  raise notice '  hub.canais ........... receber_grupos (TODAS as linhas em FALSE)';
  raise notice '  hub.grupo_participantes  criada, RLS ligada, 2 políticas';
  raise notice '  8 constraints, 3 índices';
  raise notice '  Nenhuma linha pré-existente foi alterada.';
  raise notice 'PRÓXIMO PASSO: deploy do hub-api, DEPOIS o hub-front.';
  raise notice '=====================================================';
end $$;

alter table hub.mensagens add column if not exists criada_em timestamptz;
update hub.mensagens set criada_em = enviada_em where criada_em is null;
alter table hub.mensagens alter column criada_em set default now();
alter table hub.mensagens alter column criada_em set not null;

comment on column hub.mensagens.criada_em is
  'Quando a linha nasceu no Hub (relogio do servidor). Use em varreduras '
  'operacionais (filaMidia). Para "quando a mensagem foi enviada de verdade", '
  'use enviada_em.';

comment on column hub.mensagens.enviada_em is
  'Quando a mensagem foi enviada de verdade: messageTimestamp do WhatsApp na '
  'entrada, instante do envio na saida. Pode ser ANTERIOR a criada_em em backlog '
  'de reconexao. E a coluna de ordem cronologica do fio da conversa.';

create index if not exists mensagens_midia_presa_idx
  on hub.mensagens (criada_em)
  where midia_status in ('pendente','baixando');

do $$
declare n_col int; n_nulos bigint;
begin
  select count(*) into n_col from information_schema.columns
   where table_schema='hub' and table_name='mensagens' and column_name='criada_em';
  if n_col <> 1 then
    raise exception 'criada_em nao foi criada em hub.mensagens.';
  end if;

  select count(*) into n_nulos from hub.mensagens where criada_em is null;
  if n_nulos <> 0 then
    raise exception 'criada_em: % linhas nulas apos o backfill.', n_nulos;
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname='hub' and indexname='mensagens_midia_presa_idx') then
    raise exception 'indice mensagens_midia_presa_idx ausente.';
  end if;

  raise notice 'criada_em OK.';
end $$;

create or replace function hub.tocar_conversa(
  p_conversa_id uuid,
  p_em          timestamptz,
  p_incrementar boolean default false
) returns timestamptz
language sql
volatile
as $$
  update hub.conversas
     set atualizado_em = greatest(atualizado_em, least(coalesce(p_em, now()), now())),
         nao_lidas     = coalesce(nao_lidas, 0) + case when p_incrementar then 1 else 0 end
   where id = p_conversa_id
  returning atualizado_em;
$$;

comment on function hub.tocar_conversa(uuid, timestamptz, boolean) is
  'Marca atividade na conversa com o instante da mensagem (monotonico, com clamp '
  'no futuro) e opcionalmente incrementa nao_lidas. Chamada por '
  'services/mensagens.ts. Ver PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md.';

revoke all on function hub.tocar_conversa(uuid, timestamptz, boolean) from public, anon, authenticated;
grant execute on function hub.tocar_conversa(uuid, timestamptz, boolean) to service_role;

do $$
declare
  v_conv uuid;
  v_cli  uuid;
  v_can  uuid;
  v_ini  timestamptz := now() - interval '1 hour';
  v_r    timestamptz;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='hub' and p.proname='tocar_conversa') then
    raise exception 'hub.tocar_conversa nao foi criada.';
  end if;

  select id into v_cli from hub.clientes limit 1;
  select id into v_can from hub.canais   limit 1;
  if v_cli is null or v_can is null then
    raise notice 'sem cliente/canal para o teste comportamental — validada so a assinatura.';
    return;
  end if;

  -- `fechada_em` preenchido de propósito: a linha de teste não pode aparecer
  -- na Caixa de ninguém nem por um instante.
  insert into hub.conversas (cliente_id, canal_id, status, aberta_em, atualizado_em, nao_lidas, fechada_em)
  values (v_cli, v_can, 'fechado', v_ini, v_ini, 0, now())
  returning id into v_conv;

  -- 1) mensagem ANTIGA (backlog) não pode puxar a conversa para trás
  v_r := hub.tocar_conversa(v_conv, v_ini - interval '2 hours', false);
  if v_r <> v_ini then
    raise exception 'monotonicidade quebrada: backlog moveu atualizado_em para %.', v_r;
  end if;

  -- 2) mensagem NOVA avança o carimbo
  v_r := hub.tocar_conversa(v_conv, v_ini + interval '10 minutes', true);
  if v_r <> v_ini + interval '10 minutes' then
    raise exception 'carimbo nao avancou como esperado: %.', v_r;
  end if;

  -- 3) timestamp no FUTURO é limitado a agora
  v_r := hub.tocar_conversa(v_conv, now() + interval '10 years', false);
  if v_r > now() then
    raise exception 'clamp de futuro falhou: %.', v_r;
  end if;

  -- 4) o incremento aconteceu exatamente uma vez (chamadas 1 e 3 eram false)
  if (select nao_lidas from hub.conversas where id = v_conv) <> 1 then
    raise exception 'nao_lidas incorreto apos exatamente 1 incremento.';
  end if;

  delete from hub.conversas where id = v_conv;
  raise notice 'tocar_conversa OK (monotonicidade, clamp e nao_lidas verificados).';
end $$;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'Publicação `supabase_realtime` não existe neste projeto — mesma falha fechada '
      'de 20260731000200_hub_realtime.sql.';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'clientes'
  ) then
    raise notice 'já publicada: hub.clientes';
  else
    alter publication supabase_realtime add table hub.clientes;
    raise notice 'publicada: hub.clientes';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'clientes'
  ) then
    raise exception 'Realtime incompleto: hub.clientes não está na publicação.';
  end if;
  raise notice '=== OK: hub.clientes publicada no Realtime. ===';
end $$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'hub' and table_name = 'canais'
       and column_name in ('status', 'conectado', 'qr_expira_em')
  ) then
    raise exception 'hub.canais não tem as colunas esperadas — schema diferente do previsto, abortando.';
  end if;
end $$;

comment on column hub.canais.status is
  'OBSOLETA (2026-08-14) — nenhum código escreve esta coluna. Vale ''verde'' '
  'desde o insert, para sempre. NÃO usar para decidir saúde de linha: quem '
  'reflete a realidade é conexao_status, escrita por channels/baileys.adapter.ts. '
  'Mantida só para não quebrar leituras antigas; candidata a drop.';

comment on column hub.canais.conectado is
  'OBSOLETA (2026-08-14) — nenhum código escreve esta coluna depois do insert. '
  'O front grava false ao criar a linha e nunca mais toca, então ela vale false '
  'até em linhas saudáveis. Usar conexao_status. Candidata a drop.';

comment on column hub.canais.qr_expira_em is
  'OBSOLETA (2026-08-14) — preenchida pelo front com uma estimativa de 60s no '
  'insert e nunca atualizada pelo backend. Quem manda na validade do QR é o '
  'Baileys, que publica em hub.eventos_canal (tipo qr_gerado). Candidata a drop.';

comment on column hub.canais.conexao_status is
  'FONTE DA VERDADE do estado de conexão da linha. Escrita por '
  'channels/baileys.adapter.ts (atualizarStatusCanal) e lida por '
  'registry.ts:reconectarCanaisAoSubir + jobs/vigiaCanais.ts para decidir o que '
  'reconectar. ATENÇÃO: ''instavel'' significa sessão VÁLIDA com socket fora do '
  'ar (recuperável sem QR) — é o valor gravado no shutdown do processo. '
  '''desconectado'' é logout de protocolo: exige QR novo.';

select
  a.attname                                        as coluna,
  left(col_description(a.attrelid, a.attnum), 60)  as comentario,
  case when col_description(a.attrelid, a.attnum) is null
       then 'FALHOU' else 'ok' end                 as resultado
from pg_attribute a
where a.attrelid = 'hub.canais'::regclass
  and a.attname in ('status', 'conectado', 'qr_expira_em', 'conexao_status')
order by a.attname;

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;

  -- Pré-requisito 1: meu_perfil() precisa derivar de meu_atendente_id()
  -- (que filtra `ativo`), não de auth.users por e-mail.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'hub' and p.proname = 'meu_perfil'
      and position('auth.users' in p.prosrc) > 0
  ) then
    raise exception
      'Aplique 20260809120000_hub_meu_perfil_ativo.sql ANTES desta migration: '
      'o gate de supervisor depende de meu_perfil() filtrar `ativo`.';
  end if;

  -- Os helpers abaixo são SECURITY DEFINER e dependem de o DONO da
  -- tabela ser isento de RLS. Com FORCE ROW LEVEL SECURITY isso vira
  -- recursão infinita na policy e o app inteiro cai.
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'hub' and c.relname = 'conversas'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception
      'hub.conversas está com FORCE ROW LEVEL SECURITY. Os helpers '
      'SECURITY DEFINER dependem da isenção do dono; com FORCE isto '
      'vira recursão infinita.';
  end if;
end $$;

create or replace function hub.meus_setores_supervisionados()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select s.setor_id
  from hub.supervisao s
  where s.supervisor_id = (select hub.meu_atendente_id())
    and (select hub.meu_perfil()) = 'supervisor'
$$;

create or replace function hub.canais_do_admin()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select c.id from hub.canais c where (select hub.sou_admin())
$$;

create or replace function hub.conversas_que_transferi()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select t.conversa_id
  from hub.transferencias t
  where t.de_atendente_id = (select hub.meu_atendente_id())
    and t.transferida_em > now() - interval '48 hours'
$$;

create or replace function hub.posso_ver_conversa(p_conversa_id uuid)
returns boolean
language sql
stable
security definer
set search_path = hub, public
as $$
  select exists (
    select 1 from hub.conversas co
    where co.id = p_conversa_id
      and (
           co.atendente_id = (select hub.meu_atendente_id())
        or co.setor_id     = any (array(select hub.meus_setores_supervisionados()))
        or co.canal_id     = any (array(select hub.canais_do_admin()))
        or co.id           = any (array(select hub.conversas_que_transferi()))
      )
  )
$$;

create or replace function hub.minhas_conversas()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select co.id from hub.conversas co
  where co.atendente_id = (select hub.meu_atendente_id())
     or co.setor_id     = any (array(select hub.meus_setores_supervisionados()))
     or co.canal_id     = any (array(select hub.canais_do_admin()))
     or co.id           = any (array(select hub.conversas_que_transferi()))
$$;

revoke all on function hub.meus_setores_supervisionados() from public;
revoke all on function hub.canais_do_admin()              from public;
revoke all on function hub.conversas_que_transferi()       from public;
revoke all on function hub.posso_ver_conversa(uuid)        from public;
grant execute on function hub.meus_setores_supervisionados() to authenticated, service_role;
grant execute on function hub.canais_do_admin()              to authenticated, service_role;
grant execute on function hub.conversas_que_transferi()      to authenticated, service_role;
grant execute on function hub.posso_ver_conversa(uuid)       to authenticated, service_role;

create index if not exists conversas_atendente_atualizado_idx
  on hub.conversas (atendente_id, atualizado_em desc);
create index if not exists conversas_setor_atualizado_idx
  on hub.conversas (setor_id, atualizado_em desc);
create index if not exists transferencias_de_atendente_idx
  on hub.transferencias (de_atendente_id, transferida_em desc);

drop policy if exists conversas_select on hub.conversas;
create policy conversas_select on hub.conversas for select to authenticated
  using (
       atendente_id = (select hub.meu_atendente_id())
    or setor_id     = any (array(select hub.meus_setores_supervisionados()))
    or canal_id     = any (array(select hub.canais_do_admin()))
    or id           = any (array(select hub.conversas_que_transferi()))
  );

drop policy if exists conversas_update on hub.conversas;
create policy conversas_update on hub.conversas for update to authenticated
  using (
       atendente_id = (select hub.meu_atendente_id())
    or setor_id     = any (array(select hub.meus_setores_supervisionados()))
    or canal_id     = any (array(select hub.canais_do_admin()))
  )
  with check (
       (select hub.sou_admin())
    or setor_id in (select hub.meus_setores())
    or canal_id in (
         select c.id from hub.canais c
         where c.empresa_id in (select hub.minhas_empresas())
       )
  );

drop policy if exists mensagens_select on hub.mensagens;
create policy mensagens_select on hub.mensagens for select to authenticated
  using ((select hub.sou_admin()) or hub.posso_ver_conversa(conversa_id));

drop policy if exists mensagens_insert on hub.mensagens;
create policy mensagens_insert on hub.mensagens for insert to authenticated
  with check ((select hub.sou_admin()) or hub.posso_ver_conversa(conversa_id));

drop policy if exists transferencias_select on hub.transferencias;
create policy transferencias_select on hub.transferencias for select to authenticated
  using ((select hub.sou_admin()) or hub.posso_ver_conversa(conversa_id));

drop policy if exists transferencias_insert on hub.transferencias;
create policy transferencias_insert on hub.transferencias for insert to authenticated
  with check ((select hub.sou_admin()) or hub.posso_ver_conversa(conversa_id));

do $$
begin
  if to_regclass('hub.conversa_notas') is not null then
    execute 'drop policy if exists conversa_notas_select on hub.conversa_notas';
    execute 'create policy conversa_notas_select on hub.conversa_notas '
            'for select to authenticated '
            'using ((select hub.sou_admin()) or hub.posso_ver_conversa(conversa_id))';
    raise notice 'conversa_notas_select atualizada.';
  else
    raise notice
      'hub.conversa_notas ainda não existe (20260808210000 não aplicada). '
      'Quando aplicar, use hub.posso_ver_conversa(), NÃO minhas_conversas().';
  end if;
end $$;

do $$
declare
  v_qual text;
  v_n    int;
begin
  select pg_get_expr(pol.polqual, pol.polrelid) into v_qual
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'hub' and c.relname = 'conversas'
    and pol.polname = 'conversas_select';

  if v_qual is null then
    raise exception 'conversas_select não existe depois da migration.';
  end if;
  if position('meus_setores(' in v_qual) > 0 then
    raise exception
      'conversas_select ainda usa hub.meus_setores() (escopo de EMPRESA): %', v_qual;
  end if;
  if position('meu_atendente_id' in v_qual) = 0 then
    raise exception 'conversas_select não referencia meu_atendente_id(): %', v_qual;
  end if;

  -- mensagens e transferencias precisam ter migrado para o predicado por linha
  select count(*) into v_n
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'hub'
    and c.relname in ('mensagens', 'transferencias')
    and pol.polname like '%\_select'
    and pg_get_expr(pol.polqual, pol.polrelid) like '%posso_ver_conversa%';
  if v_n <> 2 then
    raise exception
      'mensagens_select/transferencias_select não migraram para '
      'posso_ver_conversa (encontrei %).', v_n;
  end if;

  -- índices
  if not exists (select 1 from pg_class where relname = 'conversas_atendente_atualizado_idx') then
    raise exception 'índice conversas_atendente_atualizado_idx não foi criado.';
  end if;
  if not exists (select 1 from pg_class where relname = 'transferencias_de_atendente_idx') then
    raise exception 'índice transferencias_de_atendente_idx não foi criado.';
  end if;

  raise notice '=== OK: escopo de conversa por atendente aplicado. ===';
end $$;

do $$
declare v_n int; v_nomes text;
begin
  select count(*), string_agg(s.nome, ', ')
    into v_n, v_nomes
  from hub.setores s
  where exists (
          select 1 from hub.canais c
          where c.setor_id = s.id and c.atendente_id is null
        )
    and not exists (
          select 1 from hub.supervisao sv where sv.setor_id = s.id
        );
  if v_n > 0 then
    raise warning
      '% setor(es) com linha de equipe e SEM supervisor em hub.supervisao (%). '
      'Conversa sem dono nesses setores fica visível apenas para o admin. '
      'Cadastre a supervisão em Configurações -> Equipe.', v_n, v_nomes;
  end if;
end $$;

create or replace function hub.normalizar_telefone(bruto text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select case
    when bruto is null then null
    when length(regexp_replace(bruto, '\D', '', 'g')) in (10, 11)
      then '55' || regexp_replace(bruto, '\D', '', 'g')
    else regexp_replace(bruto, '\D', '', 'g')
  end;
$$;

comment on function hub.normalizar_telefone(text) is
  'Normalização canônica de telefone. Espelho de normalizarTelefone() em '
  'src/services/mensagens.ts — as duas implementações são verificadas '
  'contra a MESMA lista de casos: aqui no bloco do-de-autovalidação desta '
  'migration, e lá em src/services/normalizarTelefone.casos.ts. Mudou uma, '
  'muda a outra e os dois conjuntos de casos.';

alter table hub.clientes
  add column bairro           text,
  add column zona_eleitoral   text,
  add column tags             text[] not null default '{}',
  add column origem           text,
  add column base_legal       text,
  add column consentimento_em timestamptz,
  add column opt_out_em       timestamptz,
  add column opt_out_motivo   text,
  add column importacao_id    uuid,
  add column situacao         text not null default 'ativo';

update hub.clientes
   set origem     = coalesce(origem, 'conversa_recebida'),
       base_legal = coalesce(base_legal, 'contato_iniciado_pelo_titular')
 where origem is null or base_legal is null;

alter table hub.clientes
  alter column origem     set not null,
  alter column base_legal set not null;

alter table hub.clientes
  add constraint clientes_situacao_check
    check (situacao in ('ativo', 'bloqueado', 'opt_out')),
  add constraint clientes_base_legal_check
    check (base_legal in (
      'consentimento',                  -- opt-in explícito e registrável
      'contato_iniciado_pelo_titular',  -- a pessoa escreveu primeiro
      'legitimo_interesse',             -- exige justificativa em `origem`
      'nao_declarada'                   -- entra bloqueado, nunca dispara
    )),
  add constraint clientes_opt_out_coerente
    check ((opt_out_em is null) = (situacao <> 'opt_out')),
  add constraint clientes_sem_base_legal_bloqueado
    check (base_legal <> 'nao_declarada' or situacao <> 'ativo');

comment on column hub.clientes.origem is
  'Procedência declarada da linha: de qual importação, formulário ou '
  'evento veio este contato. Texto livre porque a origem real varia; o '
  'que é fechado é base_legal.';
comment on column hub.clientes.situacao is
  'ativo = pode receber disparo. bloqueado = existe no cadastro mas está '
  'fora de qualquer lista (base legal não declarada, telefone suspeito). '
  'opt_out = pediu descadastro; irreversível pela UI.';

create index clientes_situacao_idx   on hub.clientes (empresa_id, situacao);
create index clientes_bairro_idx     on hub.clientes (empresa_id, bairro) where bairro is not null;
create index clientes_tags_idx       on hub.clientes using gin (tags);
create index clientes_importacao_idx on hub.clientes (importacao_id) where importacao_id is not null;

create table hub.importacoes (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references hub.empresas(id) on delete cascade,
  criado_por        uuid references hub.atendentes(id),
  arquivo_nome      text not null,
  arquivo_hash      text,               -- sha256 do conteúdo: reimportação vira consulta
  arquivo_bytes     bigint,
  origem            text not null,      -- procedência declarada, herdada pelas linhas
  base_legal        text not null,
  mapeamento        jsonb,              -- coluna do arquivo -> campo do cadastro
  linhas_lidas      int not null default 0,
  linhas_aceitas    int not null default 0,
  linhas_duplicadas int not null default 0,
  linhas_invalidas  int not null default 0,
  linhas_opt_out    int not null default 0,
  relatorio         jsonb,              -- motivo por linha rejeitada
  status            text not null default 'previa',
  criado_em         timestamptz not null default now(),
  confirmado_em     timestamptz,
  constraint importacoes_status_check
    check (status in ('previa', 'confirmada', 'descartada', 'erro')),
  constraint importacoes_base_legal_check
    check (base_legal in ('consentimento', 'contato_iniciado_pelo_titular',
                          'legitimo_interesse', 'nao_declarada'))
);
create index importacoes_empresa_idx on hub.importacoes (empresa_id, criado_em desc);

alter table hub.clientes
  add constraint clientes_importacao_fk
  foreign key (importacao_id) references hub.importacoes(id) on delete set null;

create table hub.listas (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references hub.empresas(id) on delete cascade,
  nome        text not null,
  descricao   text,
  criado_por  uuid references hub.atendentes(id),
  filtro      jsonb,          -- como foi montada; documental, não reavaliado
  criado_em   timestamptz not null default now()
);
create index listas_empresa_idx on hub.listas (empresa_id, criado_em desc);

create table hub.lista_eleitores (
  lista_id   uuid not null references hub.listas(id)   on delete cascade,
  cliente_id uuid not null references hub.clientes(id) on delete cascade,
  primary key (lista_id, cliente_id)
);
create index lista_eleitores_cliente_idx on hub.lista_eleitores (cliente_id);

alter table hub.disparos
  add column lista_id           uuid references hub.listas(id),
  add column texto_base         text,
  add column janela_inicio      time not null default '09:00',
  add column janela_fim         time not null default '20:00',
  add column intervalo_min_seg  int  not null default 25,
  add column intervalo_max_seg  int  not null default 90,
  add column teto_diario        int,
  add column enviados_hoje      int  not null default 0,
  add column contador_dia       date,
  add column pausado_em         timestamptz,
  add column pausa_motivo       text,
  add column amostra_aprovada_em timestamptz,
  add constraint disparos_janela_check
    check (janela_inicio < janela_fim),
  add constraint disparos_intervalo_check
    check (intervalo_min_seg > 0 and intervalo_min_seg <= intervalo_max_seg),
  add constraint disparos_teto_check
    check (teto_diario is null or teto_diario > 0);

comment on column hub.disparos.amostra_aprovada_em is
  'Fase 4: quando a IA personaliza, uma amostra das variações precisa ser '
  'revisada por gente antes de o disparo sair de rascunho. Nulo com '
  'texto personalizado = o worker recusa iniciar.';

alter table hub.disparo_alvos
  add column texto_gerado   text,
  add column tentativas     int not null default 0,
  add column agendado_para  timestamptz,
  add constraint disparo_alvos_tentativas_check check (tentativas >= 0);

comment on column hub.disparo_alvos.texto_gerado is
  'O texto EXATO enviado a esta pessoa. Não é cache: é o registro de o '
  'que foi dito a cada eleitor, e a única forma de responder a uma '
  'reclamação sobre o conteúdo de uma mensagem específica.';

create index disparo_alvos_proximo_idx
  on hub.disparo_alvos (disparo_id, agendado_para nulls first)
  where status = 'pendente';

drop trigger if exists disparos_bloqueia_baileys on hub.disparos;
drop function if exists hub.impede_disparo_baileys();

create or replace function hub.impede_alvo_opt_out()
returns trigger
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare
  v_situacao   text;
  v_opt_out_em timestamptz;
begin
  if new.cliente_id is null then
    -- Alvo sem cliente_id é telefone solto. Ele não tem cadastro, então
    -- não tem consentimento: recusa. O importador cria o cadastro ANTES
    -- de montar a lista, exatamente para não cair aqui.
    raise exception
      'Alvo de disparo sem cliente_id (telefone %). Todo destinatário '
      'precisa de cadastro em hub.clientes com base legal declarada.',
      new.telefone;
  end if;

  select c.situacao, c.opt_out_em into v_situacao, v_opt_out_em
  from hub.clientes c where c.id = new.cliente_id;

  if v_opt_out_em is not null or v_situacao <> 'ativo' then
    raise exception
      'Destinatário % está em situação "%" e não pode receber disparo '
      '(opt-out em %).', new.cliente_id, v_situacao, v_opt_out_em;
  end if;
  return new;
end $$;

create trigger disparo_alvos_respeita_opt_out
  before insert or update of cliente_id, status on hub.disparo_alvos
  for each row
  when (new.status = 'pendente')
  execute function hub.impede_alvo_opt_out();

create or replace function hub.impede_disparo_sem_base_legal()
returns trigger
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare v_sem int;
begin
  select count(*) into v_sem
  from hub.disparo_alvos a
  join hub.clientes c on c.id = a.cliente_id
  where a.disparo_id = new.id
    and (c.base_legal = 'nao_declarada' or c.situacao <> 'ativo');

  if v_sem > 0 then
    raise exception
      'Disparo % tem % destinatário(s) sem base legal declarada ou fora de '
      'situação ativa. Corrija a lista antes de iniciar.', new.id, v_sem;
  end if;
  return new;
end $$;

create trigger disparos_exige_base_legal
  before update of status on hub.disparos
  for each row
  when (new.status = 'enviando' and old.status is distinct from 'enviando')
  execute function hub.impede_disparo_sem_base_legal();

create or replace function hub.confere_teto_diario()
returns trigger
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare
  v_teto     int;
  v_enviados int;
  v_dia      date;
begin
  if new.status <> 'enviado' or old.status = 'enviado' then
    return new;
  end if;

  select d.teto_diario, d.enviados_hoje, d.contador_dia
    into v_teto, v_enviados, v_dia
  from hub.disparos d where d.id = new.disparo_id
  for update;

  if v_teto is null then
    return new;
  end if;

  -- Vira o contador quando o dia muda. `current_date` roda no timezone do
  -- banco; o worker usa o mesmo, então os dois concordam sobre "hoje".
  if v_dia is distinct from current_date then
    update hub.disparos
       set contador_dia = current_date, enviados_hoje = 0
     where id = new.disparo_id;
    v_enviados := 0;
  end if;

  if v_enviados >= v_teto then
    raise exception
      'Teto diário do disparo % atingido (% de %). O envio recomeça amanhã.',
      new.disparo_id, v_enviados, v_teto;
  end if;

  update hub.disparos
     set enviados_hoje = enviados_hoje + 1,
         contador_dia  = current_date
   where id = new.disparo_id;

  return new;
end $$;

create trigger disparo_alvos_confere_teto
  before update of status on hub.disparo_alvos
  for each row
  execute function hub.confere_teto_diario();

alter table hub.importacoes     enable row level security;
alter table hub.listas          enable row level security;
alter table hub.lista_eleitores enable row level security;

create policy importacoes_select on hub.importacoes for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));
create policy importacoes_admin_write on hub.importacoes for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy listas_select on hub.listas for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));
create policy listas_admin_write on hub.listas for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy lista_eleitores_select on hub.lista_eleitores for select to authenticated
  using (
    hub.sou_admin() or lista_id in (
      select l.id from hub.listas l
      where l.empresa_id in (select hub.minhas_empresas())
    )
  );
create policy lista_eleitores_admin_write on hub.lista_eleitores for all to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

do $$
declare
  casos text[][] := array[
    -- [entrada, esperado]
    array['47999887766',      '5547999887766'],  -- celular com DDD
    array['4733445566',       '554733445566'],   -- fixo com DDD
    array['(47) 99988-7766',  '5547999887766'],  -- máscara
    array['+55 47 99988-7766','5547999887766'],  -- já com DDI, 13 dígitos
    array['5547999887766',    '5547999887766'],  -- já normalizado
    array['999887766',        '999887766'],      -- 9 dígitos: sem DDD, passa cru
    array['',                 ''],               -- vazio
    array['abc',              '']                -- sem dígito nenhum
  ];
  i int;
  v_obtido text;
begin
  for i in 1 .. array_length(casos, 1) loop
    v_obtido := hub.normalizar_telefone(casos[i][1]);
    if v_obtido is distinct from casos[i][2] then
      raise exception
        'hub.normalizar_telefone(%) devolveu "%", esperado "%"',
        casos[i][1], v_obtido, casos[i][2];
    end if;
  end loop;

  if hub.normalizar_telefone(null) is not null then
    raise exception 'hub.normalizar_telefone(null) deveria ser null';
  end if;

  raise notice 'OK: normalizar_telefone bate nos % casos.', array_length(casos, 1);
end $$;

do $$
declare v_n int;
begin
  if exists (select 1 from pg_trigger where tgname = 'disparos_bloqueia_baileys') then
    raise exception 'o trigger de transporte ainda existe — a troca não completou.';
  end if;

  select count(*) into v_n from pg_trigger
  where tgname in ('disparo_alvos_respeita_opt_out',
                   'disparos_exige_base_legal',
                   'disparo_alvos_confere_teto');
  if v_n <> 3 then
    raise exception
      'esperava 3 guarda-corpos novos, encontrei %. O schema não pode ficar '
      'com menos travas do que tinha antes.', v_n;
  end if;

  raise notice 'OK: 1 trava de transporte trocada por 3 travas de consentimento.';
end $$;

do $$
declare v_sem_rls text; v_anon int;
begin
  select string_agg(c.relname, ', ') into v_sem_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'hub' and c.relkind = 'r' and not c.relrowsecurity
    and c.relname in ('importacoes', 'listas', 'lista_eleitores');
  if v_sem_rls is not null then
    raise exception 'Tabelas novas sem RLS: %', v_sem_rls;
  end if;

  select count(*) into v_anon
  from information_schema.role_table_grants
  where table_schema = 'hub' and grantee = 'anon'
    and table_name in ('importacoes', 'listas', 'lista_eleitores');
  if v_anon > 0 then
    raise exception 'ERRO GRAVE: grant para `anon` em tabela nova de hub.';
  end if;

  raise notice 'OK: importacoes, listas e lista_eleitores com RLS e sem anon.';
end $$;

do $$
declare v_n int;
begin
  select count(*) into v_n from hub.clientes
  where origem is null or base_legal is null;
  if v_n > 0 then
    raise exception '% cliente(s) sem origem/base_legal após o backfill.', v_n;
  end if;
  raise notice '=== Fase 1 aplicada: cadastro eleitoral, listas e ritmo de disparo. ===';
end $$;

create table hub.gateway_lease (
  id         boolean primary key default true,
  instancia  text not null,
  tomado_em  timestamptz not null default now(),
  expira_em  timestamptz not null,
  constraint gateway_lease_linha_unica check (id)
);

comment on table hub.gateway_lease is
  'Qual instância do backend pode segurar os sockets do WhatsApp e rodar o '
  'worker de disparo. Renovada a cada 15s pelo dono; expira em 45s. '
  'Ver src/jobs/lease.ts e docs/DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md §0.3.';

create or replace function hub.tomar_lease(p_instancia text, p_ttl_seg int default 45)
returns boolean
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare v_linhas int;
begin
  if p_instancia is null or length(trim(p_instancia)) = 0 then
    raise exception 'tomar_lease exige um identificador de instância';
  end if;

  insert into hub.gateway_lease (id, instancia, expira_em)
  values (true, p_instancia, now() + make_interval(secs => greatest(p_ttl_seg, 5)))
  on conflict (id) do update
     set instancia = excluded.instancia,
         expira_em = excluded.expira_em,
         -- `tomado_em` marca desde quando ESTA instância é dona. Renovação
         -- não mexe nele; troca de dono reinicia. É o que permite ver, no
         -- log, se a posse está trocando de mão sem parar.
         tomado_em = case
           when gateway_lease.instancia = excluded.instancia then gateway_lease.tomado_em
           else now()
         end
   where gateway_lease.instancia = p_instancia
      or gateway_lease.expira_em < now();

  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end $$;

create or replace function hub.liberar_lease(p_instancia text)
returns boolean
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare v_linhas int;
begin
  update hub.gateway_lease
     set expira_em = now() - interval '1 second'
   where id = true and instancia = p_instancia;
  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end $$;

revoke all on function hub.tomar_lease(text, int)  from public, anon, authenticated;
revoke all on function hub.liberar_lease(text)     from public, anon, authenticated;
grant execute on function hub.tomar_lease(text, int) to service_role;
grant execute on function hub.liberar_lease(text)    to service_role;

alter table hub.gateway_lease enable row level security;

create policy gateway_lease_select on hub.gateway_lease for select to authenticated
  using (true);

do $$
declare
  v_a boolean;
  v_b boolean;
begin
  -- 1. instância A toma
  select hub.tomar_lease('teste-A', 60) into v_a;
  if not v_a then raise exception 'A deveria ter tomado a posse livre'; end if;

  -- 2. instância B NÃO toma enquanto A está válida
  select hub.tomar_lease('teste-B', 60) into v_b;
  if v_b then raise exception 'B tomou a posse de A ainda válida — a trava não funciona'; end if;

  -- 3. A renova sem problema
  select hub.tomar_lease('teste-A', 60) into v_a;
  if not v_a then raise exception 'A não conseguiu renovar a própria posse'; end if;

  -- 4. A libera, B assume
  perform hub.liberar_lease('teste-A');
  select hub.tomar_lease('teste-B', 60) into v_b;
  if not v_b then raise exception 'B não assumiu depois de A liberar'; end if;

  -- 5. posse vencida é tomável
  update hub.gateway_lease set expira_em = now() - interval '1 minute';
  select hub.tomar_lease('teste-C', 60) into v_a;
  if not v_a then raise exception 'C não tomou uma posse vencida'; end if;

  delete from hub.gateway_lease;
  raise notice '=== OK: posse do gateway exclusiva, renovável e liberável. ===';
end $$;

