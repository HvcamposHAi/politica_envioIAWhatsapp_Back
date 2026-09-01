-- =====================================================================
-- FASE 2.3 — Schema `hub`: baseline consolidada
-- =====================================================================
--
-- Origem: as 7 migrations de `multi-whats-magic/supabase/migrations`.
--
-- POR QUE CONSOLIDADA, e não search-replace das 7
-- ---------------------------------------------------------------------
-- O plano-base §2.2 previa "search-replace `public.` -> `hub.` nas 4
-- migrations". A triagem A2.2 encontrou 7 arquivos, não 4, e mostrou
-- que replayá-los num schema novo traz três problemas:
--
--   1. SEED DE MOCKUP EMBUTIDO EM MIGRATION DE SCHEMA. O seed não está
--      isolado em 2 arquivos — está inline em 3 dos 5 de schema
--      (20260714201651 linhas 130-289, 20260714204737 linhas 40-169,
--      20260715182239 linhas 67-134), além dos 2 puramente de seed
--      (20260715182313, 20260715194827). Replayar = injetar "Sítio Boa
--      Esperança" e 40 conversas fake no schema de produção.
--
--   2. GRANT A `anon` EM 11 TABELAS. As migrations do protótipo fazem
--      `grant select, insert, update, delete ... to authenticated, anon`.
--      Isso reproduziria em `hub` exatamente a classe de exposição que a
--      Fase 1 está corrigindo em `public`. Aqui `anon` NÃO recebe grant
--      nenhum — o front autentica antes de ler qualquer coisa.
--
--   3. HISTÓRICO DE ALTER SEM VALOR NUM SCHEMA NOVO. `canais` nasce e
--      recebe 6 colunas em outra migration; `atendentes` recebe 2 e troca
--      uma constraint. Num schema que não existe ainda, o alter histórico
--      só dificulta a leitura. Aqui as colunas nascem na definição.
--
-- O estado final é equivalente ao do protótipo, menos o mockup e menos o
-- grant a anon. A conferência contra `src/integrations/supabase/types.ts`
-- está em docs/fase2-drift.md (A2.1).
--
-- A partir DESTA migration, o histórico volta a ser incremental: nada de
-- consolidar de novo. Este arquivo é o marco zero do schema `hub`.
--
-- ⚠️  Ordem obrigatória: aplicar 20260730120000_fase1_rls_lockdown.sql
--     ANTES desta. O Hub não sobe num banco aberto (Fase 1 é pré-requisito
--     de qualquer deploy, não etapa paralela).
-- =====================================================================

begin;

create schema if not exists hub;

-- `anon` não tem nada aqui. Nem usage no schema.
grant usage on schema hub to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. Organização
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 2. Canais (linhas de WhatsApp)
--    Colunas de 20260715182239 já embutidas.
-- ---------------------------------------------------------------------
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

-- Uma linha de WhatsApp é um número físico: não pode existir duas vezes.
-- Duas sessões Baileys no mesmo número se derrubam mutuamente e acumulam
-- sinal de ban (Risco #1 e #2 do plano-base). Esta constraint é a última
-- linha de defesa depois da lista de exclusão da Fase 0.3.
create unique index canais_numero_unico on hub.canais (numero);

-- ---------------------------------------------------------------------
-- 3. Atendentes e hierarquia
--    Colunas e constraint de 20260714204737 já embutidas.
-- ---------------------------------------------------------------------
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
  -- Usado por `meu_atendente_id()` para excluir atendente desligado da
  -- resolução de identidade — sem isso, um `user_id` ou e-mail reciclado
  -- reativaria o acesso de um atendente que já saiu.
  ativo        boolean not null default true,
  constraint atendentes_perfil_check
    check (perfil in ('operador','supervisor','admin'))
);

-- `meu_atendente_id()` resolve o atendente pelo e-mail do auth.users.
-- Sem unicidade, dois atendentes com o mesmo e-mail fazem a função
-- devolver um dos dois de forma não determinística (ela tem LIMIT 1) —
-- e a identidade do usuário passa a depender do plano de execução.
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

-- ---------------------------------------------------------------------
-- 4. Clientes
--    Diferença relevante do protótipo: `empresa_id`.
--    · `empresa_id` fecha o furo de escopo — no protótipo a política era
--      `clientes_select USING (true)`, então todo atendente via a base de
--      clientes de todas as empresas. Com Matriz + 3 Casa do Colono isso
--      não serve.
-- ---------------------------------------------------------------------
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
-- O telefone é a chave de correlação da mensagem que chega do WhatsApp.
create unique index clientes_telefone_empresa
  on hub.clientes (empresa_id, telefone);

-- ---------------------------------------------------------------------
-- 5. Conversas, mensagens, transferências
-- ---------------------------------------------------------------------
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
  -- A2.9 do plano-base já vinha resolvida no protótipo: a regra de
  -- negócio do Marcelo ("motivo de perda obrigatório em não vendeu")
  -- está no banco, não só na UI. Preservada na íntegra.
  constraint motivo_obrigatorio
    check (desfecho <> 'nao_vendeu' or motivo_perda is not null)
);
create index conversas_setor_idx     on hub.conversas (setor_id);
create index conversas_canal_idx     on hub.conversas (canal_id);
create index conversas_atendente_idx on hub.conversas (atendente_id);
create index conversas_cliente_idx   on hub.conversas (cliente_id);
-- A Caixa e o Kanban listam por status e por data de abertura.
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

-- ---------------------------------------------------------------------
-- 6. Kanban
-- ---------------------------------------------------------------------
create table hub.kanban_colunas (
  id            uuid primary key default gen_random_uuid(),
  setor_id      uuid references hub.setores(id) on delete cascade,
  nome          text not null,
  ordem         int not null,
  fecha_chamado boolean default false
);
-- Índice único de 20260715194854. Sem ele, duas colunas na mesma posição
-- fazem o kanban embaralhar entre renders.
create unique index kanban_colunas_setor_ordem
  on hub.kanban_colunas (setor_id, ordem);

-- ---------------------------------------------------------------------
-- 7. Grants — `authenticated` e `service_role`. NUNCA `anon`.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema hub to authenticated;
grant all                            on all tables in schema hub to service_role;
grant usage, select                   on all sequences in schema hub to authenticated, service_role;

-- Tabela nova criada aqui no futuro já nasce com o grant certo,
-- e sem nada para anon.
alter default privileges in schema hub
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema hub
  grant all on tables to service_role;

-- ---------------------------------------------------------------------
-- 8. RLS ligada em tudo. As políticas vêm na migration seguinte
--    (20260731000100). Entre as duas, o schema nega por padrão — que é
--    o estado seguro para falhar.
-- ---------------------------------------------------------------------
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

commit;

-- =====================================================================
-- SEM PONTE COM ERP
-- =====================================================================
-- A baseline original deste schema nasceu acoplada à réplica de um ERP
-- (`public.clientes`, `public.vendedores`, `public.filiais`) por três
-- colunas de código externo. Nada disso existe aqui: a Central de
-- Mensagens da campanha não lê nenhum sistema de terceiro, e o cadastro
-- de eleitores entra por importação de arquivo (ver
-- docs/PLANO_CAMPANHA_INDIARA.md, Fase 2).
--
-- As colunas `empresas.cod_filial`, `atendentes.cod_vendedor` e
-- `clientes.cod_cliente`, as views `v_cliente_ficha`, `v_cliente_inativo`
-- e o lateral join de faturamento em `v_conversao` foram removidos na
-- Fase 0. Se algum dia existir integração externa, ela nasce como
-- migration nova — não reabrindo esta.
-- =====================================================================
