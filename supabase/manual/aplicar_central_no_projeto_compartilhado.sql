-- =====================================================================
-- CENTRAL INDIARA — schema completo, para aplicar NO SQL EDITOR
-- =====================================================================
--
-- GERADO AUTOMATICAMENTE a partir de supabase/migrations/. Não edite este
-- arquivo: edite as migrations e gere de novo.
--
-- POR QUE ELE EXISTE
-- ---------------------------------------------------------------------
-- O projeto `Projetos_HAI` é COMPARTILHADO com outra aplicação (um CRM),
-- e a tabela de histórico de migrations do Supabase
-- (`supabase_migrations.schema_migrations`) é ÚNICA por projeto — os dois
-- repositórios não podem os dois usar `supabase db push`.
--
-- Rodando `supabase db push` daqui, o CLI recusa e sugere duas saídas:
--
--   supabase migration repair --status reverted <as 18 do CRM>
--       -> apaga do histórico as migrations DO CRM. O schema dele
--          continua de pé, mas a ferramenta dele passa a achar que nada
--          foi aplicado. NÃO FAÇA.
--
--   supabase db pull
--       -> despeja o schema inteiro do CRM dentro das NOSSAS migrations.
--          NÃO FAÇA.
--
-- Este arquivo é a terceira saída: aplica o nosso schema sem escrever uma
-- linha sequer no histórico. O CRM não percebe que existimos.
--
-- O CUSTO, para ficar registrado: enquanto a Central viver neste projeto,
-- `supabase db push` NÃO funciona aqui. Toda migration nova entra pelo
-- mesmo caminho — gerar este arquivo de novo, ou colar só a migration
-- nova no SQL Editor.
--
-- COMO USAR
-- ---------------------------------------------------------------------
-- 1. Copie este arquivo INTEIRO.
-- 2. Supabase > SQL Editor > New query > colar > Run.
-- 3. Espere. São 31 migrations; leva alguns segundos.
--
-- TUDO OU NADA: os `begin`/`commit` de cada migration foram removidos de
-- propósito, para o SQL Editor rodar o conjunto numa transação só. Se
-- qualquer verificação reprovar, NADA é aplicado e o banco fica
-- exatamente como estava.
--
-- O QUE VOCÊ DEVE VER no fim: uma pilha de mensagens `NOTICE` com
-- `=== OK: ... ===`. Elas são as autovalidações — cada migration confere
-- o próprio trabalho.
--
-- PARA DESFAZER TUDO:  drop schema hub cascade;
-- (leva junto eleitores, conversas e disparos — e não toca no CRM)
-- =====================================================================



-- =====================================================================
-- >>> 20260731000000_hub_schema.sql
-- =====================================================================

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
-- [begin removido: transacao unica]
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
-- [commit removido: transacao unica]
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


-- =====================================================================
-- >>> 20260731000100_hub_funcoes_rls.sql
-- =====================================================================

-- =====================================================================
-- FASE 2.4 — Funções helper e RLS do schema `hub`
-- =====================================================================
--
-- Origem: 20260714211537 (helpers + políticas) e a parte de políticas de
-- 20260715182239 e 20260715194854 do protótipo.
--
-- O modelo de RLS do protótipo é bom e foi preservado: não-permissivo,
-- escopado por empresa, com helpers SECURITY DEFINER para evitar recursão.
-- Quatro furos de escopo foram fechados no port — listados no fim.
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 1. Helpers
--    `set search_path = hub, public` (o protótipo tinha `= public`).
--    Referências a `auth.users` continuam qualificadas — é o único
--    schema externo que estas funções tocam.
-- ---------------------------------------------------------------------

-- Resolve pelo vínculo explícito (`user_id = auth.uid()`) como caminho
-- principal. O e-mail só entra como fallback quando o atendente ainda não
-- foi vinculado (`user_id is null`) — primeiro login, antes de
-- `hub.vincular_usuario()` gravar o vínculo. O `order by` garante que um
-- vínculo explícito sempre vence o fallback por e-mail quando os dois
-- caminhos, por algum motivo, casarem linhas diferentes.
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

-- Novo helper. Os setores das minhas empresas aparecem em 6 políticas do
-- protótipo como subquery repetida; aqui viram uma função, para a regra
-- existir num só lugar.
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

-- Novo helper. Conversa que eu posso ver: por setor ou por canal.
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

-- Execute só para quem autentica. `anon` não executa nada em `hub`.
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

-- Grava o vínculo `user_id` no primeiro login, casando por e-mail. Depois
-- desta chamada, `meu_atendente_id()` resolve o atendente pelo caminho
-- principal (`user_id = auth.uid()`) e para de depender do e-mail.
-- SECURITY DEFINER para poder escrever em `hub.atendentes` sob RLS; por
-- isso o EXECUTE fica só com `service_role` — o front nunca chama isto
-- diretamente, é o backend que vincula depois de autenticar o usuário.
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

-- ---------------------------------------------------------------------
-- 2. Organização — empresas, setores, kanban
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. Canais
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 4. Atendentes e hierarquia
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 5. Clientes  — FURO #1 CORRIGIDO
--    Protótipo: `clientes_select ... using (true)`, ou seja, todo
--    atendente autenticado lia a base de clientes inteira, de todas as
--    empresas. Com Matriz Agro Veterinária + 3 lojas Casa do Colono, um
--    operador de Indaial via a carteira da Matriz.
--    Agora escopa por `empresa_id` (coluna adicionada em 20260731000000).
-- ---------------------------------------------------------------------
create policy clientes_select on hub.clientes for select to authenticated
  using (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));

create policy clientes_insert on hub.clientes for insert to authenticated
  with check (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));

create policy clientes_update on hub.clientes for update to authenticated
  using      (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()))
  with check (hub.sou_admin() or empresa_id in (select hub.minhas_empresas()));

create policy clientes_delete on hub.clientes for delete to authenticated
  using (hub.sou_admin());

-- ---------------------------------------------------------------------
-- 6. Conversas  — FURO #2 CORRIGIDO
--    Protótipo: `conversas_write for insert with check (true)`. Qualquer
--    autenticado podia inserir conversa em qualquer setor de qualquer
--    empresa. O `using` do select estava certo; o `with check` da escrita
--    anulava o escopo.
-- ---------------------------------------------------------------------
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
  -- Protótipo tinha `with check (true)`: dava para atualizar uma conversa
  -- do meu setor movendo-a para o setor de outra empresa. O check agora
  -- valida o estado DEPOIS do update, não só o de antes.
  with check (
    hub.sou_admin()
    or setor_id in (select hub.meus_setores())
  );

create policy conversas_delete on hub.conversas for delete to authenticated
  using (hub.sou_admin());

-- ---------------------------------------------------------------------
-- 7. Mensagens  — FURO #3 CORRIGIDO
--    Protótipo: `mensagens_insert with check (true)`. Dava para injetar
--    mensagem em conversa de outra empresa.
-- ---------------------------------------------------------------------
create policy mensagens_select on hub.mensagens for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy mensagens_insert on hub.mensagens for insert to authenticated
  with check (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy mensagens_update on hub.mensagens for update to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy mensagens_delete on hub.mensagens for delete to authenticated
  using (hub.sou_admin());

-- ---------------------------------------------------------------------
-- 8. Transferências  — FURO #4 CORRIGIDO
--    Mesmo caso: `with check (true)` no insert.
--    A transferência entre setores com nota interna é o modelo XP que o
--    Jens citou na reunião, então a nota fica obrigatória quando o setor
--    de destino é diferente do de origem.
-- ---------------------------------------------------------------------
create policy transferencias_select on hub.transferencias for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy transferencias_insert on hub.transferencias for insert to authenticated
  with check (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

create policy transferencias_update on hub.transferencias for update to authenticated
  using (hub.sou_admin()) with check (hub.sou_admin());

create policy transferencias_delete on hub.transferencias for delete to authenticated
  using (hub.sou_admin());

-- Regra de negócio da reunião, no banco e não só na UI — mesmo critério
-- que a constraint `motivo_obrigatorio` de `hub.conversas`.
alter table hub.transferencias
  add constraint transferencia_nota_obrigatoria
  check (
    de_setor_id is null
    or para_setor_id is null
    or de_setor_id = para_setor_id
    or (nota_interna is not null and length(btrim(nota_interna)) > 0)
  );
-- [commit removido: transacao unica]
-- =====================================================================
-- AUDITORIA DO PORT
-- =====================================================================
-- Preservado do protótipo, sem alteração de semântica:
--   · 4 helpers SECURITY DEFINER (com search_path corrigido para hub)
--   · escopo por empresa em empresas, setores, canais, kanban_colunas,
--     atendentes, atendente_empresas, supervisao, canal_atendentes,
--     canal_atribuicoes
--   · admin-only para escrita de cadastro e para todo delete
--   · leitura de conversa por setor OU por canal
--
-- Corrigido (4 furos de escopo entre empresas):
--   #1  hub.clientes         select  using (true)      -> escopo por empresa_id
--   #2  hub.conversas        insert  with check (true) -> escopo por setor/canal
--   #2b hub.conversas        update  with check (true) -> valida estado pós-update
--   #3  hub.mensagens        insert  with check (true) -> escopo via conversa
--   #4  hub.transferencias   insert  with check (true) -> escopo via conversa
--
-- Adicionado:
--   · hub.meus_setores() e hub.minhas_conversas() — a subquery de escopo
--     que aparecia repetida em 6 políticas passa a existir num só lugar
--   · coalesce em sou_admin() — evita null se propagando em política
--   · comparação de e-mail case-insensitive nos helpers (o protótipo
--     comparava com `=`, então "Jens@..." e "jens@..." eram atendentes
--     diferentes; o índice único de 20260731000000 é lower(email))
--   · constraint transferencia_nota_obrigatoria
--
-- Deliberadamente NÃO portado:
--   · `grant ... to anon` em 11 tabelas
--   · políticas "prototype_all_*" com `using (true) with check (true)`
--   · todo o seed de mockup
--
-- FALTA VALIDAR (bloqueado por ausência de Docker — ver docs/fase2-drift.md):
--   Teste com dois usuários de empresas distintas, provando que o
--   operador da Casa do Colono Indaial não lê conversa da Matriz. É o
--   critério de aceite de A2.4 e não pode ser dispensado.
-- =====================================================================


-- =====================================================================
-- >>> 20260731000200_hub_realtime.sql
-- =====================================================================

-- =====================================================================
-- FASE 2.6 — Realtime do schema `hub`
-- =====================================================================
--
-- Origem: 20260715194854 do protótipo.
--
-- ⚠️  O QUE MUDOU, E POR QUÊ
-- A migration original envolvia o `alter publication` num bloco
-- `exception when undefined_object then null`. Se a publicação
-- `supabase_realtime` não existisse no projeto, a falha era engolida:
-- o Realtime não ligava e ninguém percebia. Como o contrato front/back
-- inteiro depende de Realtime — "o backend devolve 202 e o resultado
-- aparece na tela via Realtime" (plano-base §5) — essa falha silenciosa
-- transformaria o Hub num app que não atualiza, com causa invisível.
--
-- Aqui a ausência da publicação é ERRO, não notice.
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 1. Replica identity
--    Necessária para o Realtime entregar o registro ANTERIOR em update
--    e delete. Sem isso o front recebe o evento sem saber o que mudou.
-- ---------------------------------------------------------------------
alter table hub.conversas replica identity full;
alter table hub.mensagens replica identity full;

-- ---------------------------------------------------------------------
-- 2. Publicação — falha fechada
-- ---------------------------------------------------------------------
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

-- Idempotente por tabela: reaplicar a migration não quebra.
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

-- ---------------------------------------------------------------------
-- 3. Autovalidação — o que o plano-base pedia como passo manual
--    (`select * from pg_publication_tables where pubname = ...`)
--    passa a ser parte da migration.
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- NOTA DE CAPACIDADE (liga com o Risco #4 e com A9.6)
-- =====================================================================
-- `replica identity full` faz o WAL carregar a linha INTEIRA em cada
-- update e delete, não só a chave. O banco já está com 1.024 MB de WAL
-- num compute MICRO (medido em 30/07, ver docs/fase0-fase1-diagnostico.md),
-- sob upsert diário de 2,3 M de linhas em `public.faturamento`.
--
-- `hub.mensagens` é a tabela de maior volume de escrita do Hub. Com
-- `replica identity full`, cada update de status de entrega reescreve a
-- linha completa no WAL.
--
-- Consequência prática: a medição de A9.6 ("avaliar subir o compute do
-- Supabase") deixa de ser opcional. Medir WAL e IO depois do teste de
-- 3 linhas por 48 h (A5.10), antes do go-live.
--
-- Se o WAL virar gargalo, a saída é trocar `replica identity full` por
-- `replica identity default` em `hub.mensagens` e mandar o backend
-- publicar o delta que o front precisa — mas isso muda o contrato do
-- Realtime, então é decisão de arquitetura, não de tuning.
-- =====================================================================


-- =====================================================================
-- >>> 20260731000300_hub_operacao.sql
-- =====================================================================

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
-- [begin removido: transacao unica]
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260804160000_hub_ura.sql
-- =====================================================================

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
-- [begin removido: transacao unica]
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260805120000_hub_conversas_atualizado_em.sql
-- =====================================================================

-- =====================================================================
-- FASE 5 (fechamento) — hub.conversas.atualizado_em + unicidade de
-- conversa aberta
-- =====================================================================
--
-- 1. atualizado_em
-- ---------------------------------------------------------------------
-- services/mensagens.ts precisa marcar "a conversa recebeu atividade
-- agora" (nova mensagem de cliente, eco de atendente pelo celular, ou
-- resposta pelo app) para o front ordenar/reordenar a lista sem depender
-- só de hub.mensagens.enviada_em via join. `hub.conversas` nunca teve
-- essa coluna — nasceu em 20260731000000 sem ela, e nenhuma migration
-- seguinte (operacao, ura) adicionou. Convenção de `atualizado_em` já
-- existe em duas tabelas do schema (hub.canal_sessoes,
-- hub.agentes_config): timestamptz default now(), mantido pela
-- aplicação, não por trigger — mesmo padrão aqui.
--
-- 2. conversas_aberta_por_cliente_canal
-- ---------------------------------------------------------------------
-- resolverConversaAberta (services/mensagens.ts) faz select-então-insert
-- sem lock. Dois eventos do mesmo cliente quase simultâneos (ex.: duas
-- mensagens em sequência rápida antes da primeira ter side-effects
-- completos) podem achar "nenhuma conversa aberta" os dois e criar duas
-- linhas — o cliente passa a ter dois threads abertos no mesmo canal,
-- mensagem futura caindo ora num ora noutro sem previsibilidade. Fecha a
-- mesma classe de corrida que `clientes_telefone_empresa` já fecha para
-- hub.clientes, com o mesmo padrão de tratamento no código (retry de
-- select ao pegar 23505).
--
-- Parcial (`where fechada_em is null`), não simples: um cliente pode ter
-- N conversas HISTÓRICAS fechadas no mesmo canal — só uma ABERTA por vez
-- é a invariante, não "uma conversa para sempre".
-- =====================================================================
-- [begin removido: transacao unica]
alter table hub.conversas
  add column atualizado_em timestamptz not null default now();

-- Índice pela mesma razão de `conversas_status_aberta_idx`: Caixa/Kanban
-- ordenam conversa recente primeiro.
create index conversas_atualizado_em_idx on hub.conversas (atualizado_em desc);

create unique index if not exists conversas_aberta_por_cliente_canal
  on hub.conversas (cliente_id, canal_id) where fechada_em is null;
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260806120000_hub_eventos_canal_realtime.sql
-- =====================================================================

-- =====================================================================
-- FASE 5 (teste de pareamento real) — hub.eventos_canal no Realtime
-- =====================================================================
--
-- A tela de conectar canal do front precisa ler o QR real assim que o
-- Baileys emite (channels/baileys.adapter.ts grava em hub.eventos_canal,
-- tipo='qr_gerado', detalhe->>'qr') via Realtime — é o contrato do
-- plano-base §5 ("backend devolve 202, resultado chega por Realtime").
--
-- 20260731000200_hub_realtime.sql só publicou hub.conversas e
-- hub.mensagens (o que existia na hora em que foi escrita — eventos_canal
-- só nasceu na migration seguinte, 20260731000300). Sem isto, a assinatura
-- `postgres_changes` do front em hub.eventos_canal não recebe nada: a
-- tabela grava normal, só não propaga.
--
-- Não precisa de `replica identity full`: eventos_canal é append-only
-- (só INSERT — não há política de update/delete para ninguém, nem update/
-- delete em código), e INSERT sempre carrega a linha inteira no WAL
-- independente da replica identity. A ressalva de custo de WAL que
-- 20260731000200 registra para `replica identity full` é sobre
-- update/delete, não se aplica aqui.
-- =====================================================================
-- [begin removido: transacao unica]
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260806130000_hub_canais_realtime.sql
-- =====================================================================

-- =====================================================================
-- FASE 5 (teste de pareamento real) — hub.canais no Realtime
-- =====================================================================
--
-- O semáforo da lista de canais (front, TabCanais) precisa refletir
-- `conexao_status` no instante em que o Baileys muda (channels/
-- baileys.adapter.ts -> atualizarStatusCanal()), não só quando o
-- usuário reabre a tela ou clica em algo que dispara um refetch manual.
-- Mesmo contrato de 20260806120000 (eventos_canal): backend grava,
-- Realtime propaga, front nunca faz polling.
--
-- Não precisa de `replica identity full`: o front só consome o valor
-- NOVO de conexao_status/ultima_conexao (INSERT/UPDATE sempre carregam a
-- linha nova inteira, com qualquer replica identity); ninguém depende do
-- valor ANTERIOR em UPDATE nem de DELETE nesta tabela.
-- =====================================================================
-- [begin removido: transacao unica]
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260806140000_hub_canais_criado_em.sql
-- =====================================================================

-- =====================================================================
-- Auditoria — hub.canais.criado_em
-- =====================================================================
--
-- `hub.canais` nasceu em 20260731000000 sem nenhum timestamp de criação.
-- Isso impede diagnosticar linhas "zumbi": um canal criado no Passo 1 de
-- conectar-numero.tsx (grava direto em hub.canais, em `conexao_status =
-- 'lendo_qr'`) e nunca completado no Passo 2 (QR não lido, aba fechada,
-- erro do backend) fica ocupando `numero` na constraint
-- `canais_numero_unico` (20260731000000, linha 107) para sempre, sem
-- nenhum jeito de saber há quanto tempo aquilo está lá.
--
-- Convenção já usada em hub.canal_sessoes/hub.agentes_config e trazida
-- para hub.conversas em 20260805120000: timestamptz default now(),
-- mantido pela aplicação, não por trigger.
-- =====================================================================
-- [begin removido: transacao unica]
alter table hub.canais
  add column if not exists criado_em timestamptz not null default now();
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260806140000_hub_convite_acesso.sql
-- =====================================================================

-- =====================================================================
-- Convite de acesso para integrantes da equipe (hub.atendentes)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Hoje criar um integrante em Configurações -> Equipe só grava uma linha
-- em hub.atendentes; não existe nenhum caminho (tela ou backend) para
-- transformar isso num login de verdade. `hub.vincular_usuario`
-- (20260731000100_hub_funcoes_rls.sql) já existia para linkar
-- `user_id` <-> atendente por e-mail, mas nunca era chamada por nenhum
-- código, e não informava se o vínculo aconteceu ou não (`returns void`,
-- sem contagem de linhas). Esta migration:
--
--   1. Adiciona `convite_enviado_em` em hub.atendentes, para a tela
--      distinguir "sem acesso" de "convite enviado" (hoje só existe o
--      binário `user_id is null`).
--   2. Cria um índice único parcial em `user_id`, hoje sem nenhuma
--      restrição de unicidade — nada impede duas linhas de
--      hub.atendentes apontarem para o mesmo auth.users.
--   3. Recria `hub.vincular_usuario` como `returns boolean`, para o
--      backend (rota nova /atendentes/vincular) saber se o vínculo
--      realmente aconteceu, em vez de falhar em silêncio.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO
-- ---------------------------------------------------------------------
--   · Nenhuma policy de RLS muda — as novas rotas do backend usam o
--     cliente service_role (bypassa RLS), mesmo padrão já usado em
--     mensagens.ts.
--   · `atendentes_email_unico` (índice existente) não muda.
--   · GRANT de `hub.vincular_usuario` continua restrito a `service_role`.
--
-- ⚠️  PRÉ-REQUISITO antes de aplicar: rodar a query abaixo e confirmar
--     que devolve 0 linhas (senão o índice único do bloco 2 falha):
--
--       select user_id, count(*)
--       from hub.atendentes
--       where user_id is not null
--       group by user_id
--       having count(*) > 1;
--
-- ⚠️  AÇÃO FORA DESTE SQL (obrigatória para o link do convite funcionar):
--     no painel do Supabase, em Authentication -> URL Configuration ->
--     Redirect URLs, adicionar a URL do front terminando em
--     `/definir-senha` (produção e, se for testar local, localhost).
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 0. Guarda: abortar se rodar contra o projeto errado
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 1. Rastrear quando um convite foi disparado. Não mexe em user_id.
-- ---------------------------------------------------------------------
alter table hub.atendentes
  add column if not exists convite_enviado_em timestamptz;

-- ---------------------------------------------------------------------
-- 2. Impedir que o mesmo auth.users fique vinculado a duas linhas de
--    atendentes. Parcial (where user_id is not null) para não travar
--    as linhas legadas, todas com user_id nulo hoje.
-- ---------------------------------------------------------------------
create unique index if not exists atendentes_user_id_unico
  on hub.atendentes (user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------
-- 3. Recriar hub.vincular_usuario com `returns boolean`, para o
--    chamador (backend) saber se o vínculo aconteceu. Mesma condição de
--    guarda de antes (`where user_id is null`) — não relinka quem já
--    tem vínculo.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 4. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select id, nome, email, user_id, convite_enviado_em
--    from hub.atendentes order by nome;
--    -> convite_enviado_em deve vir null para todo mundo (coluna nova).
--
-- 2. select hub.vincular_usuario('00000000-0000-0000-0000-000000000000',
--                                 'email-que-nao-existe@x.com');
--    -> deve devolver false.
--
-- 3. Depois do deploy do backend/front (rota /atendentes/vincular),
--    conferir que hub.atendentes.user_id dos admins que já usam o
--    sistema hoje (ex.: Humberto) foi preenchido no primeiro login
--    pós-deploy.
--
-- 4. Se algo falhar: aplicar
--    20260806140000_hub_convite_acesso_rollback.sql
-- =====================================================================


-- =====================================================================
-- >>> 20260806150000_hub_atendentes_acesso_multiempresa.sql
-- =====================================================================

-- =====================================================================
-- Acesso multiempresa por atendente (hub.atendentes.acesso_todas_empresas)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Configurações -> Equipe cadastrava, na prática, um atendente por
-- empresa: dar acesso à mesma pessoa em duas empresas exigia duas linhas
-- em hub.atendentes (dois "cadastros" para uma pessoa só), porque a tela
-- só sabia gravar UMA empresa por integrante ao criar. `hub.atendente_empresas`
-- (N:N) já existia por baixo e já era a fonte que RLS e o backend liam,
-- mas nada na UI expunha "esta pessoa acessa todas as empresas / só a X /
-- X e Y" — e nada garantia que alguém marcado como "acesso total" continuasse
-- com acesso total quando uma empresa nova fosse cadastrada depois.
--
-- Esta migration:
--
--   1. Adiciona `hub.atendentes.acesso_todas_empresas boolean`, para a
--      tela guardar a INTENÇÃO do admin (não só o resultado materializado
--      em atendente_empresas).
--   2. Cria um trigger em hub.empresas: toda vez que uma empresa nova é
--      inserida, todo atendente com acesso_todas_empresas = true ganha
--      automaticamente uma linha em atendente_empresas para ela. Sem
--      isso, "acesso a todas as empresas" descreveria só as empresas que
--      existiam no momento em que foi marcado — ficaria desatualizado a
--      cada empresa nova.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · hub.minhas_empresas() e toda a RLS que depende dela — continuam
--     lendo só hub.atendente_empresas, sem saber que a flag existe.
--     hub.atendente_empresas continua sendo a ÚNICA fonte de verdade que
--     RLS e o backend enxergam; a flag só ajuda a MANTER essa tabela
--     completa e a lembrar a intenção na tela de edição.
--   · agrotimbo_hubwhatsapp_bkend/src/routes/mensagens.ts
--     (empresasDoAtendente) — lê atendente_empresas direto, mesmo motivo
--     acima: continua correto sem mudar uma linha de código.
--   · Atendentes existentes: a coluna nasce `false` para todo mundo,
--     nenhum vínculo em atendente_empresas é alterado por esta migration.
--
-- ⚠️  AÇÃO FORA DESTE SQL, opcional e recomendada — depois do deploy do
--     front (formulário novo em Configurações > Equipe), marcar
--     humberto@hai.expert como acesso_todas_empresas pela própria tela de
--     edição (ela já materializa atendente_empresas ao salvar). Se
--     preferir fazer por SQL direto em vez de pela UI:
--
--       update hub.atendentes set acesso_todas_empresas = true
--       where lower(email) = 'humberto@hai.expert';
--
--       insert into hub.atendente_empresas (atendente_id, empresa_id)
--       select a.id, e.id from hub.atendentes a cross join hub.empresas e
--       where a.acesso_todas_empresas
--       on conflict do nothing;
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 0. Guarda: abortar se rodar contra o projeto errado
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 1. Flag de intenção. Default false preserva o comportamento atual de
--    todo mundo até que a tela seja usada para marcar alguém.
-- ---------------------------------------------------------------------
alter table hub.atendentes
  add column if not exists acesso_todas_empresas boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. Materializa atendente_empresas quando uma empresa nova é criada,
--    para quem já tem acesso_todas_empresas = true. SECURITY DEFINER
--    porque quem insere em hub.empresas (admin, via RLS) não
--    necessariamente tem grant de INSERT em atendente_empresas para
--    OUTROS atendentes — mesmo padrão de hub.vincular_usuario.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select id, nome, acesso_todas_empresas from hub.atendentes order by nome;
--    -> acesso_todas_empresas deve vir false para todo mundo (coluna nova).
--
-- 2. Teste do trigger, dentro de uma transação que você desfaz (rollback)
--    — não precisa sujar o banco para validar:
--
--      begin;
--        update hub.atendentes set acesso_todas_empresas = true
--        where lower(email) = 'humberto@hai.expert';
--        insert into hub.empresas (nome, tipo) values ('Empresa Teste Trigger', 'varejo');
--        select ae.* from hub.atendente_empresas ae
--        join hub.atendentes a on a.id = ae.atendente_id
--        join hub.empresas e on e.id = ae.empresa_id
--        where lower(a.email) = 'humberto@hai.expert' and e.nome = 'Empresa Teste Trigger';
--        -- -> deve devolver 1 linha
--      rollback;
--
-- 3. supabase gen types typescript --project-id zfbjwhaltqewbluqfmtt
--    (ou equivalente) para substituir o patch manual em
--    multi-whats-magic/src/integrations/supabase/types.ts pelo tipo real.
--
-- 4. Se algo falhar: aplicar
--    20260806150000_hub_atendentes_acesso_multiempresa_rollback.sql
-- =====================================================================


-- =====================================================================
-- >>> 20260807120000_hub_empresas_cadastro_completo.sql
-- =====================================================================

-- =====================================================================
-- Cadastro completo de empresas: razão social, nome fantasia, CNPJ e
-- exclusão reversível (soft-delete)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Configurações -> Empresas era só leitura: sem criar, sem editar, e
-- `hub.empresas` só tinha `nome`/`tipo`/`cnpj` (cnpj já existia, sem
-- validação nem uso na UI). Pedido: abrir CRUD completo, capturando
-- razão social e nome fantasia além do CNPJ, e permitir "excluir".
--
-- "Excluir" NÃO é DELETE físico. `hub.canais.empresa_id` e
-- `hub.atendentes.empresa_id` não têm ON DELETE (bloqueiam a exclusão se
-- houver linha vinculada); se essas fossem removidas antes, o DELETE em
-- cascata apagaria para sempre hub.clientes, hub.disparos (+
-- disparo_alvos), hub.motivos_perda e hub.auditoria — que é append-only
-- por design. Em vez disso, esta migration adiciona `ativo`, no mesmo
-- padrão já usado em hub.atendentes.ativo e hub.motivos_perda.ativo.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · Nenhum ON DELETE/FK muda — zero risco às cascatas já existentes.
--   · trg_empresas_sincroniza_acesso_total (AFTER INSERT em hub.empresas,
--     migrations_pendentes/20260806150000) só dispara em criação, não em
--     UPDATE de `ativo` — não precisa de ajuste.
--   · hub.minhas_empresas()/hub.meus_setores() não mudam — desativar uma
--     empresa NÃO revoga acesso já concedido a setores/conversas dela,
--     só tira ela dos cadastros de "novo registro" (empresas_select).
--   · empresas_admin_write (INSERT/UPDATE/DELETE do admin) não muda.
-- =====================================================================
-- [begin removido: transacao unica]
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception
      'Schema `hub` não existe. Esta migration é específica do projeto '
      'zfbjwhaltqewbluqfmtt (Agrotimbo). Abortando.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Colunas novas. Nenhuma é NOT NULL exceto `ativo` (com default true,
--    preserva o comportamento atual de toda empresa existente).
-- ---------------------------------------------------------------------
alter table hub.empresas
  add column if not exists razao_social  text,
  add column if not exists nome_fantasia text,
  add column if not exists ativo         boolean not null default true;

-- ---------------------------------------------------------------------
-- 2. Índice único parcial: impede duas empresas ATIVAS com o mesmo CNPJ.
--    Ignora nulos e empresas desativadas (reaproveitar um CNPJ "liberado"
--    por uma exclusão anterior não fica bloqueado por uma linha morta).
--    Só cria se não houver duplicata hoje — se houver, avisa e segue sem
--    o índice (resolver os duplicados e criar o índice à parte depois).
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. RLS: empresa desativada some da leitura de quem NÃO é admin.
--    hub.sou_admin() continua enxergando tudo (precisa, para reativar).
-- ---------------------------------------------------------------------
drop policy if exists empresas_select on hub.empresas;
create policy empresas_select on hub.empresas for select to authenticated
  using (hub.sou_admin() or (ativo and id in (select hub.minhas_empresas())));

-- ---------------------------------------------------------------------
-- 4. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select column_name from information_schema.columns
--    where table_schema = 'hub' and table_name = 'empresas';
--    -> deve incluir razao_social, nome_fantasia, ativo.
--
-- 2. select id, nome, tipo, cnpj, razao_social, nome_fantasia, ativo
--    from hub.empresas;
--    -> as empresas existentes devem vir com ativo = true, sem perder
--       nenhum dado de nome/tipo/cnpj.
--
-- 3. select policyname, qual from pg_policies
--    where schemaname = 'hub' and tablename = 'empresas'
--      and policyname = 'empresas_select';
--    -> o texto deve conter "ativo".
--
-- 4. Teste do soft-delete, dentro de uma transação que você desfaz
--    (rollback) — não precisa sujar o banco para validar:
--
--      begin;
--        update hub.empresas set ativo = false where nome = 'Casa do Colono';
--        select id, nome, ativo from hub.empresas where nome = 'Casa do Colono';
--        -- -> ativo deve vir "false" aqui
--      rollback;
--      -- -> depois do rollback, ativo volta a "true"
--
-- 5. Se algo falhar: aplicar
--    20260807120000_hub_empresas_cadastro_completo_rollback.sql
-- =====================================================================


-- =====================================================================
-- >>> 20260807160000_hub_clientes_wa_jid.sql
-- =====================================================================

-- =====================================================================
-- hub.clientes.wa_jid — JID técnico do WhatsApp por contato
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Ver PLANO_CORRECAO_IDENTIFICACAO_LID_WHATSAPP.md (raiz do repo) para a
-- análise completa. Resumo: parte dos contatos do WhatsApp é roteada pelo
-- protocolo por um JID técnico "@lid" (opaco, não é telefone) em vez de
-- "@s.whatsapp.net". `agrotimbo_hubwhatsapp_bkend/src/channels/
-- baileys.adapter.ts` grava, hoje, o texto cru desse JID em
-- `hub.clientes.telefone` — daí os identificadores de 15-18 dígitos que
-- aparecem na Ficha/Chamados em vez de um número.
--
-- Pior do que a exibição: `hub.clientes.telefone` também é usado para
-- MONTAR o JID de saída quando o atendente responde pelo Hub
-- (routes/mensagens.ts -> BaileysChannel.enviar()). Para um contato @lid,
-- isso monta um JID que não corresponde à identidade real do contato — a
-- resposta pode não chegar.
--
-- Esta migration adiciona `hub.clientes.wa_jid`: o JID completo original
-- (ex. "5541999998888@s.whatsapp.net" ou "120363...@lid"), capturado pelo
-- código novo do adapter. Vira a fonte de verdade para:
--   1. Roteamento de envio (substitui a reconstrução por dígitos quando
--      presente).
--   2. Correlação de um contato @lid já conhecido, mesmo antes/depois do
--      telefone real aparecer via `senderPn` — evita fragmentar o cliente
--      em dois quando o telefone real for descoberto numa mensagem futura.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · `hub.clientes.telefone` continua NOT NULL e é a chave de correlação
--     primária (`clientes_telefone_empresa`) — esta migration não mexe
--     nela, só adiciona uma coluna nova e nullable ao lado.
--   · Canais Twilio: não têm conceito de "@lid" — `wa_jid` nasce sempre
--     null para clientes que só falam por Twilio, sem efeito colateral.
--   · Nenhum dado existente é alterado por este SQL (a parte de código,
--     dentro da transação, é só DDL). O backfill de `wa_jid` para
--     clientes @lid já existentes é uma ação manual SEPARADA, descrita no
--     bloco de validação pós-aplicação no final deste arquivo — de
--     propósito fora da transação, para você conferir o diagnóstico antes
--     de gravar.
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 0. Guarda: abortar se rodar contra o projeto errado
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 1. Coluna nova, nullable — não muda o comportamento de nenhum cliente
--    existente até o código novo (ou o backfill manual) preenchê-la.
-- ---------------------------------------------------------------------
alter table hub.clientes add column if not exists wa_jid text;

-- ---------------------------------------------------------------------
-- 2. Um JID técnico não pode ser reaproveitado por dois clientes da
--    mesma empresa; null é permitido (contato sem wa_jid capturado
--    ainda, ex.: clientes só de canal Twilio).
-- ---------------------------------------------------------------------
create unique index if not exists clientes_wa_jid_empresa
  on hub.clientes (empresa_id, wa_jid)
  where wa_jid is not null;

-- ---------------------------------------------------------------------
-- 3. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- VALIDAÇÃO E BACKFILL PÓS-APLICAÇÃO — rodar manualmente, fora desta
-- migration (SQL Editor do projeto Supabase Agrotimbo, zfbjwhaltqewbluqfmtt)
-- =====================================================================
--
-- 1. Confirmar a coluna:
--    select column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'hub' and table_name = 'clientes' and column_name = 'wa_jid';
--
-- 2. DIAGNÓSTICO — rodar ANTES de qualquer update, e LER o resultado.
--    Mostra quantos clientes hoje têm, em `telefone`, um valor comprido
--    demais para ser um telefone BR real (mais de 13 dígitos — 55+DDD+
--    número já é o máximo). São os candidatos ao problema relatado:
--
--      select length(telefone) as tamanho, count(*) as quantos
--      from hub.clientes
--      group by length(telefone)
--      order by tamanho desc;
--
--    Se alguma linha tiver `tamanho` entre 14 e 15, revise manualmente
--    antes de seguir — pode ser um número internacional legítimo (E.164
--    permite até 15 dígitos), não necessariamente um lid. Acima de 15,
--    é praticamente certo que é um lid.
--
-- 3. BACKFILL — marca esses clientes com `wa_jid` deduzido do próprio
--    `telefone` cru. Isso é o que evita que eles "fragmentem" em um
--    cliente novo assim que o código novo resolver o telefone real deles
--    numa mensagem futura (ver §5.3/§6.4 do plano) — o resolverCliente()
--    novo passa a achá-los pelo `wa_jid` antes de tentar achar por
--    telefone.
--
--      update hub.clientes
--      set wa_jid = telefone || '@lid'
--      where wa_jid is null
--        and length(telefone) > 13;
--
-- 4. Conferir que o backfill bateu com o diagnóstico do passo 2:
--
--      select count(*) as clientes_marcados
--      from hub.clientes
--      where wa_jid is not null;
--
-- 5. Se algo falhar ou precisar desfazer: aplicar
--    20260807160000_hub_clientes_wa_jid_rollback.sql
--    (o backfill do passo 3 é perdido junto — a coluna some — mas é
--    reaplicável rodando o passo 3 de novo depois de recriar a coluna).
-- =====================================================================


-- =====================================================================
-- >>> 20260807180000_hub_empresas_vinculo_criador.sql
-- =====================================================================

-- =====================================================================
-- Vínculo automático do criador ao criar uma empresa + backfill
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- CRUD de empresas (20260807120000) abriu criação pela UI. `cu.empresas`
-- no front (multi-whats-magic/src/lib/current-user.ts) — que alimenta o
-- switcher do header e os seletores de Configurações — não é "toda
-- empresa que existe", é "toda empresa que o atendente logado tem um
-- vínculo explícito em hub.atendente_empresas". Criar uma empresa pela
-- tela só fazia INSERT em hub.empresas; nada criava esse vínculo para o
-- admin que criou. Resultado observado em produção: empresa "teste"
-- criada, visível na aba Empresas (RLS deixa admin ver tudo), mas ausente
-- do switcher do header e do seletor "em qual empresa" de Configurações.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · Nenhuma policy de RLS muda — só dados (atendente_empresas) e um
--     trigger novo em hub.empresas.
--   · Backfill só concede vínculo a atendentes que já tinham acesso via
--     RLS mesmo (admin bypassa tudo por hub.sou_admin()) — não é
--     permissão nova, só materializa o que já era verdade.
-- =====================================================================
-- [begin removido: transacao unica]
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'hub') then
    raise exception 'Schema `hub` não existe. Abortando.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Trigger: quem cria uma empresa ganha vínculo automático nela.
--    Guarda contra hub.meu_atendente_id() nulo — se uma empresa for
--    criada fora de um contexto autenticado normal, não deve travar o
--    INSERT em hub.empresas.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 2. Backfill: corrige agora quem já ficou sem vínculo. Só afeta
--    atendentes com perfil = 'admin'.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. Mesmo backfill para atendente não-admin com acesso_todas_empresas
--    = true, só se essa coluna já existir (migration
--    20260806150000_hub_atendentes_acesso_multiempresa.sql pode ou não
--    ter sido aplicada ainda) — não falha se a coluna não existir.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 4. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- VALIDAÇÃO PÓS-APLICAÇÃO — rodar manualmente, fora da migration
-- =====================================================================
--
-- 1. select e.nome, a.nome as admin_vinculado
--    from hub.empresas e
--    join hub.atendente_empresas ae on ae.empresa_id = e.id
--    join hub.atendentes a on a.id = ae.atendente_id
--    where a.perfil = 'admin'
--    order by e.nome;
--    -> toda empresa deve aparecer ao menos uma vez.
--
-- 2. select tgname from pg_trigger
--    where tgname = 'trg_empresas_concede_acesso_criador' and not tgisinternal;
--    -> deve retornar 1 linha.
--
-- 3. Se algo falhar: aplicar
--    20260807180000_hub_empresas_vinculo_criador_rollback.sql
-- =====================================================================


-- =====================================================================
-- >>> 20260808150000_hub_canais_atendente_responsavel.sql
-- =====================================================================

-- =====================================================================
-- Linha pessoal: hub.canais.atendente_id (atendente responsável)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Pedido 2026-08-08: "um telefone pode pertencer a uma equipe OU a um
-- atendente/função". O modelo até aqui só conhecia linha de equipe:
-- canal -> setor, conversa nasce "Sem dono" e alguém do setor assume.
--
-- Esta migration adiciona `atendente_id` (nullable) em hub.canais:
--   · NULL  = linha de equipe (comportamento atual, inalterado — toda
--             linha existente continua exatamente como era).
--   · Preenchido = linha PESSOAL: toda conversa nova que entra por esse
--     canal já nasce com conversas.atendente_id = canais.atendente_id
--     (quem grava é resolverConversaAberta em services/mensagens.ts) —
--     aparece direto na aba "Meus" do atendente, sem passar por
--     "Sem dono".
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · Conversas já abertas: nada de backfill — dono de conversa em
--     andamento não muda por migration.
--   · setor_id continua obrigatório no fluxo (o setor segue sendo o
--     agrupador de fila/kanban; a linha pessoal só define o DONO inicial).
--   · RLS: nenhuma policy muda — atendente_id em canais é metadado de
--     roteamento, a visibilidade continua vindo de setor/empresa.
--   · on delete set null: desligar/excluir o atendente devolve a linha
--     ao comportamento de equipe em vez de quebrar o canal.
-- =====================================================================
-- [begin removido: transacao unica]
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
-- [commit removido: transacao unica]
-- =====================================================================
-- PÓS-APLICAÇÃO (opcional) — tornar uma linha existente pessoal:
--
--   update hub.canais
--   set atendente_id = (select id from hub.atendentes where lower(email) = 'humberto@hai.expert')
--   where nome = 'Humberto HAI';
--
-- Rollback: 20260808150000_hub_canais_atendente_responsavel_rollback.sql
-- =====================================================================


-- =====================================================================
-- >>> 20260808180000_hub_mensagens_wa_message_id_por_conversa.sql
-- =====================================================================

-- 20260808180000_hub_mensagens_wa_message_id_por_conversa.sql
-- Idempotência de wa_message_id por CONVERSA, não global.
--
-- CONTEXTO (incidente 2026-08-08, "não vejo as mensagens do 2º número"):
-- quando as duas linhas Baileys da MESMA base conversam entre si, a mesma
-- mensagem chega pelos dois sockets com o mesmo wa_message_id — cada lado
-- é uma testemunha legítima e deveria gravar a sua cópia na SUA conversa
-- (canal Televendas <-> canal Humberto HAI são conversas espelhadas
-- distintas). Com o índice único GLOBAL de 20260731000300, o primeiro
-- insert vencia e o segundo virava no-op "idempotente": cada mensagem caía
-- em só uma das duas conversas, decidido por corrida, deixando buracos nos
-- dois lados.
--
-- O índice único foi desenhado para (a) retry de webhook da Twilio e
-- (b) reemissão de messages.upsert do Baileys pós-reconexão — os dois casos
-- reapresentam a mensagem NA MESMA conversa, então (conversa_id,
-- wa_message_id) preserva a proteção original por inteiro. Também continua
-- cobrindo o eco fromMe do que o Hub enviou (routes/mensagens.ts grava o
-- wa_message_id na mesma conversa que o eco alcança).
--
-- Acompanha mudança de código em services/mensagens.ts
-- (atualizarStatusEntregaPorWaMessageId deixou de usar maybeSingle — com
-- este índice, um wa_message_id pode legitimamente ter 2 linhas).

drop index if exists hub.mensagens_wa_message_id_unico;

-- Parcial como antes: mensagem criada pela UI antes do provedor confirmar
-- não tem wa_message_id (null), e null não pode bloquear inserts.
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


-- =====================================================================
-- >>> 20260808190000_hub_conversas_resumo_ia_regularizacao.sql
-- =====================================================================

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
-- [begin removido: transacao unica]
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260808200000_hub_conversas_titulo_ia.sql
-- =====================================================================

-- 20260808200000_hub_conversas_titulo_ia.sql
-- Título de IA do chamado, exibido em destaque no card do Kanban.
--
-- CONTEXTO (PLANO_TITULO_IA_KANBAN.md, 2026-08-08): o card do Kanban usava o
-- nome do cliente como título — que, para cliente não identificado, é o
-- telefone cru. A IA passa a nomear o ASSUNTO da conversa. O título é
-- produzido na MESMA chamada à Anthropic que já gerava resumo_ia
-- (services/resumoIA.ts): uma chamada só, gravação atômica no mesmo update,
-- título e resumo sempre coerentes entre si.
--
-- ORDEM DE DEPLOY (falha F1 do plano): esta migration TEM que ser aplicada
-- ANTES do deploy do hub-api. O título é gravado no mesmo update do resumo —
-- se a coluna não existir, o update inteiro falha e o resumo para de ser
-- gravado junto. Pelo mesmo motivo, o rollback exige reverter o hub-api antes
-- (ou junto).
--
-- Sem backfill de propósito: conversa aberta ganha título na próxima mensagem
-- recebida (ou na hora, pelo botão "Gerar novamente" do dialog), e o front cai
-- no nome do cliente enquanto titulo_ia for null. Conversa fechada não aparece
-- no board — pagar Anthropic por ela seria desperdício.
-- [begin removido: transacao unica]
alter table hub.conversas
  add column if not exists titulo_ia text,
  add column if not exists titulo_ia_gerado_em timestamptz;

-- Rede de segurança, não a regra: o truncamento real é em 80 chars no código
-- (TITULO_MAX em services/resumoIA.ts). A folga até 120 existe para que um
-- título grande seja cortado silenciosamente lá e este check nunca dispare —
-- um 23514 aqui derrubaria o update inteiro, levando o resumo junto.
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
-- [commit removido: transacao unica]
-- hub.conversas já está na publicação supabase_realtime com replica identity
-- full (20260731000200) — a coluna nova propaga sozinha, sem mexer aqui.
notify pgrst, 'reload schema';


-- =====================================================================
-- >>> 20260808201000_hub_ia_analise_csat.sql
-- =====================================================================

-- =====================================================================
-- hub.conversas — análise de IA (sentimento/risco/motivo) + CSAT
-- =====================================================================
--
-- APLICADA MANUALMENTE EM PRODUÇÃO EM 08/08/2026 (SQL Editor, projeto
-- zfbjwhaltqewbluqfmtt). Este arquivo existe para o repo não acumular mais
-- drift de schema — o mesmo problema já registrado das colunas resumo_ia*,
-- que só existem no banco e em nenhuma migration. Todo o DDL abaixo é
-- idempotente (`if not exists` / guarda de duplicata), então reaplicar em
-- outro ambiente é seguro.
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION HABILITA
-- ---------------------------------------------------------------------
-- Ver PLANO_IA_SENTIMENTO_ALERTAS_ALICE_CSAT.md (raiz do repo) para o
-- plano completo. Resumo das três features que dependem destas colunas:
--
--   1. ANÁLISE DE IA POR CONVERSA (services/analiseIA.ts) — uma chamada à
--      Anthropic, disparada no mesmo gatilho do resumo, classifica
--      sentimento, risco de escalonamento e motivo provável de perda.
--      `hub.conversas.sentimento` já existia desde 20260731000000 e já era
--      lido pelo Painel; até aqui nada no código a preenchia (só o seed).
--
--   2. ALERTAS PROATIVOS — `risco` + `risco_motivo` alimentam a faixa de
--      alertas do Painel e o banner acima do campo de resposta na Caixa.
--      Ambos chegam ao front sem poll: hub.conversas já está na publicação
--      Realtime (20260731000200_hub_realtime.sql), então o UPDATE feito
--      aqui pelo service_role aparece na tela aberta.
--
--   3. CSAT / SLA — `avaliacao_solicitada_em` e `avaliacao_registrada_em`
--      dão o ciclo de vida da pesquisa de satisfação enviada ao cliente ao
--      finalizar o chamado. A nota em si vai para `nota_satisfacao`, que
--      também já existia e já era lida no Painel sem nunca ter produtor.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · Nenhuma coluna, constraint, índice ou policy existente é alterada:
--     todo o DDL é aditivo. Pode rodar com o sistema no ar.
--   · RLS: as policies de hub.conversas são por linha, não por coluna —
--     as colunas novas herdam o mesmo controle de acesso sem mudança. A
--     escrita da IA é service_role (ignora RLS), como o resumo já é.
--   · Realtime: hub.conversas já está publicada com replica identity full;
--     nada a fazer.
--   · Grants: herdados da tabela.
--   · Nenhuma tabela nova. A Alice (fase 3 do plano) é stateless.
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 0. Guarda: abortar se rodar contra o projeto errado
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 1. Colunas novas, todas nullable — nenhuma linha existente muda de
--    comportamento até o código novo preenchê-las.
--
--    motivo_perda_sugerido_id é SUGESTÃO da IA, deliberadamente separada
--    de motivo_perda_id (a escolha confirmada pelo atendente ao finalizar,
--    que o constraint motivo_obrigatorio exige). A IA pré-seleciona; quem
--    grava o motivo real continua sendo o humano. `on delete set null`
--    evita sugestão órfã quando um motivo é removido em Configurações.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 2. Domínios. Entram `not valid` e são validados logo em seguida: em
--    tabela com dado legado (nota_satisfacao vem do seed de demonstração)
--    o `not valid` separa "a regra passa a valer para escrita nova" de "o
--    passado está conforme", e faz o erro — se houver — apontar para o
--    comando de validação, não para o alter que cria a constraint.
--
--    `add constraint` não aceita `if not exists`; a guarda de duplicata
--    fica no do-block para a migration seguir idempotente.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. Índices parciais — os dois recortes que o código consulta a quente.
--
--    O primeiro serve a faixa de alertas do Painel, que só olha conversa
--    ABERTA com risco médio/alto; o índice parcial mantém o custo
--    proporcional a esse recorte, não ao histórico inteiro de conversas.
--
--    O segundo serve o passo mais sensível do CSAT: para CADA mensagem de
--    entrada, antes de abrir conversa nova, o backend pergunta "existe
--    pesquisa pendente para este cliente neste canal?". Sem índice, isso
--    seria um scan no caminho quente do inbound.
-- ---------------------------------------------------------------------
create index if not exists conversas_risco_aberto_idx
  on hub.conversas (risco)
  where fechada_em is null and risco in ('medio','alto');

create index if not exists conversas_avaliacao_pendente_idx
  on hub.conversas (cliente_id, canal_id, avaliacao_solicitada_em)
  where avaliacao_solicitada_em is not null and nota_satisfacao is null;

-- ---------------------------------------------------------------------
-- 4. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- ORDEM DE DEPLOY — importante
-- =====================================================================
--
-- Este SQL vai ANTES do deploy do hub-api. services/analiseIA.ts escreve
-- nestas colunas; com o código no ar e as colunas ausentes, cada UPDATE
-- falha e o erro só aparece no log (o serviço é fire-and-forget e nunca
-- relança, por contrato). Sequência:
--
--   1. Aplicar esta migration e conferir as 13 linhas do bloco abaixo.
--   2. Deploy do hub-api (Cloud Run, 1 instância — o debounce da análise
--      vive em Map de processo, como o do resumo).
--   3. Deploy do hub-front COM os build-args VITE_* (`gcloud run deploy
--      --source .` os ignora — ver incidente de 07/08/2026).
--
-- =====================================================================
-- CONFERÊNCIA PÓS-APLICAÇÃO — deve devolver 13 linhas
-- =====================================================================
--
--   select 'coluna' as tipo, column_name as nome from information_schema.columns
--    where table_schema='hub' and table_name='conversas'
--      and column_name in ('sentimento_atualizado_em','risco','risco_motivo','risco_atualizado_em',
--                          'motivo_perda_sugerido_id','analise_ia_modelo','analise_ia_erro',
--                          'avaliacao_solicitada_em','avaliacao_registrada_em')
--   union all
--   select 'constraint', conname from pg_constraint
--    where conrelid='hub.conversas'::regclass
--      and conname in ('conversas_risco_valido','conversas_nota_satisfacao_valida')
--      and convalidated
--   union all
--   select 'indice', indexname from pg_indexes
--    where schemaname='hub' and tablename='conversas'
--      and indexname in ('conversas_risco_aberto_idx','conversas_avaliacao_pendente_idx')
--   order by tipo, nome;
--
-- Se o `validate constraint` da nota falhar, existe nota_satisfacao fora
-- da faixa 1-5 (provavelmente do seed de demonstração). Diagnosticar ANTES
-- de limpar qualquer coisa:
--
--   select nota_satisfacao, count(*) from hub.conversas
--    where nota_satisfacao is not null and nota_satisfacao not between 1 and 5
--    group by nota_satisfacao;
--
-- Para desfazer: 20260808201000_hub_ia_analise_csat_rollback.sql
--
-- (O prefixo era 20260808200000 e foi movido para ...201000 na auditoria:
-- colidia com 20260808200000_hub_conversas_titulo_ia.sql. Em `supabase db
-- push` a versão é a chave de `schema_migrations` — duas iguais dão conflito
-- ou aplicação parcial silenciosa no próximo ambiente. Ambas já estavam
-- aplicadas em produção, então o risco era só para staging/reset local.)
--
-- =====================================================================
-- RECONCILIAÇÃO — rodar periodicamente (§7 do plano)
-- =====================================================================
--
-- Estas quatro consultas são o único jeito de saber se a IA e o CSAT estão
-- saudáveis em produção: os dois serviços são fire-and-forget por contrato e
-- engolem as próprias falhas, então nada aparece na tela quando param de
-- funcionar. Sem R1/R2, uma chave de API vencida seria invisível.
--
-- R1 — análises falhando. Esperado ~0. Crescendo = chave, modelo ou limite
--      com problema, OU a migration não aplicada no ambiente.
--
--   select count(*) from hub.conversas
--    where analise_ia_erro is not null
--      and atualizado_em > now() - interval '7 days';
--
--   -- Detalhe dos motivos, quando R1 > 0:
--   select analise_ia_erro, count(*) from hub.conversas
--    where analise_ia_erro is not null
--      and atualizado_em > now() - interval '7 days'
--    group by analise_ia_erro order by count(*) desc;
--
-- R2 — conversas abertas com mensagem de cliente e sem sentimento há mais de
--      uma hora. É o resíduo esperado de restart do Cloud Run (o debounce
--      vive em memória de processo); número grande e persistente indica que
--      a análise parou de rodar, não que houve um restart.
--
--   select count(*) from hub.conversas c
--    where c.fechada_em is null and c.sentimento is null
--      and c.atualizado_em < now() - interval '1 hour'
--      and exists (select 1 from hub.mensagens m
--                   where m.conversa_id = c.id and m.autor = 'cliente');
--
-- R3 — taxa de resposta do CSAT nos últimos 30 dias. Não é alarme, é
--      acompanhamento: queda brusca sugere que a pesquisa parou de ser
--      enviada ou que a captura da nota parou de reconhecer as respostas.
--
--   select count(*) filter (where avaliacao_registrada_em is not null)::float
--        / nullif(count(*), 0) as taxa_resposta,
--          count(*) as pesquisas_enviadas
--     from hub.conversas
--    where avaliacao_solicitada_em > now() - interval '30 days';
--
-- R4 — risco preso em conversa fechada. Deve ser 0: desde a auditoria, o
--      serviço zera o risco quando encontra a conversa já finalizada
--      (services/analiseIA.ts). Valor > 0 aponta para linhas anteriores a
--      essa correção ou para escrita por fora do serviço.
--
--   select count(*) from hub.conversas
--    where fechada_em is not null and risco in ('medio','alto');
--
--   -- Limpeza pontual do resíduo antigo, se R4 > 0 (revisar antes de rodar):
--   -- update hub.conversas set risco = null, risco_motivo = null
--   --  where fechada_em is not null and risco is not null;
-- =====================================================================


-- =====================================================================
-- >>> 20260808210000_hub_conversas_nota_atendimento.sql
-- =====================================================================

-- 20260808210000_hub_conversas_nota_atendimento.sql
-- "Informações do atendimento": anotação interna escrita pelo ATENDENTE (humano)
-- na Ficha da Caixa, exibida também no card do Kanban.
--
-- CONTEXTO (PLANO_NOTA_ATENDIMENTO_KANBAN.md, 2026-08-08): o Kanban e a Caixa já
-- carregam a linha inteira da conversa (`select("*")`). Guardar a nota VIGENTE
-- numa coluna de hub.conversas faz a informação chegar às duas telas sem query
-- nova, sem join e sem policy nova — a RLS de conversas é por linha, não por
-- coluna, e quem já pode assumir/transferir/fechar já pode anotar.
--
-- O HISTÓRICO mora em hub.conversa_notas (append-only). Ele NÃO é escrito pelo
-- front: o trigger abaixo o preenche a partir do mesmo UPDATE que grava a nota
-- vigente. Assim histórico e vigente não têm como divergir (uma transação só,
-- uma escrita só do cliente) e a guarda de concorrência do front continua sendo
-- um único UPDATE condicional.
--
-- ORDEM DE DEPLOY: esta migration ANTES do deploy do hub-front. O `select("*")`
-- do front sobrevive à ausência das colunas (PostgREST devolve menos campos),
-- mas toda GRAVAÇÃO de nota falharia com 42703.
--
-- O hub-api NÃO muda nesta feature — nenhum serviço do backend lê ou escreve a
-- nota.
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 1. Nota vigente na própria conversa
-- ---------------------------------------------------------------------
alter table hub.conversas
  add column if not exists nota_atendimento      text,
  add column if not exists nota_atendimento_por  uuid references hub.atendentes(id),
  add column if not exists nota_atendimento_em   timestamptz;

comment on column hub.conversas.nota_atendimento is
  'Anotação interna do atendimento, escrita por humano na Ficha. NUNCA é enviada ao cliente.';
comment on column hub.conversas.nota_atendimento_em is
  'Carimbo da última edição. É também a VERSÃO usada pela guarda de concorrência do front.';

-- Rede de segurança, não a regra: o corte real é no front (NOTA_MAX = 2000 em
-- src/lib/nota-atendimento.ts). A folga até 4000 existe para que texto grande
-- seja cortado silenciosamente lá e este check nunca dispare — um 23514 aqui
-- derrubaria a gravação inteira.
-- `btrim` no check: nota só de espaços tem que ser NULL, não string vazia.
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

-- Invariante de carimbo: nota preenchida SEMPRE tem "quando". É disso que a
-- guarda de concorrência depende — sem o timestamp, duas pessoas salvando ao
-- mesmo tempo se sobrescrevem em silêncio.
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

-- ---------------------------------------------------------------------
-- 2. Histórico append-only
-- ---------------------------------------------------------------------
-- `nota` é nullable de propósito: apagar a nota é um evento do histórico
-- ("fulano limpou às 14:02"), não a ausência de um.
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

-- Mesma regra de visibilidade das mensagens e transferências: quem enxerga a
-- conversa enxerga o histórico dela.
drop policy if exists conversa_notas_select on hub.conversa_notas;
create policy conversa_notas_select on hub.conversa_notas for select to authenticated
  using (hub.sou_admin() or conversa_id in (select hub.minhas_conversas()));

-- Append-only DE VERDADE: o front não escreve aqui. Quem insere é o trigger
-- (security definer), na mesma transação do UPDATE da conversa. Sem este
-- revoke, `alter default privileges` (20260731000000:276) daria insert/update/
-- delete a authenticated e o histórico viraria texto editável.
revoke insert, update, delete on hub.conversa_notas from authenticated;
grant  select                 on hub.conversa_notas to authenticated;
grant  all                    on hub.conversa_notas to service_role;
grant  usage, select          on sequence hub.conversa_notas_id_seq to service_role;

-- ---------------------------------------------------------------------
-- 3. Trigger: histórico + auditoria a partir do UPDATE da nota
-- ---------------------------------------------------------------------
-- hub.auditoria é append-only e tem `insert` revogado para authenticated
-- (20260731000300:297) — ou seja, o front não consegue se auditar. Este
-- trigger resolve os dois registros (histórico e auditoria) do lado do banco,
-- de onde não há como escapar: qualquer caminho que altere a nota fica
-- registrado, inclusive um UPDATE manual pelo SQL Editor.
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

-- `of nota_atendimento`: o trigger só é considerado quando a coluna está no SET
-- do UPDATE. Os updates do backend (resumo, análise, atualizado_em, avaliação)
-- e das outras telas (status, atendente, fechamento) nem chegam a executar a
-- função.
drop trigger if exists conversas_registrar_nota on hub.conversas;
create trigger conversas_registrar_nota
  after update of nota_atendimento on hub.conversas
  for each row execute function hub.registrar_nota_atendimento();

-- ---------------------------------------------------------------------
-- 4. Autovalidação — "Success. No rows returned" não prova nada.
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- hub.conversas já está na publicação supabase_realtime com replica identity
-- full (20260731000200) — as colunas novas propagam sozinhas para quem assina,
-- incluindo o Kanban, que passa a assinar o canal "chamados" nesta entrega.
-- hub.conversa_notas fica FORA da publicação de propósito: o histórico é lido
-- sob demanda (dialog do card), não vale um canal a mais.
notify pgrst, 'reload schema';


-- =====================================================================
-- >>> 20260808220000_hub_conversas_coach.sql
-- =====================================================================

-- =====================================================================
-- hub.conversas — coach de atendimento (respostas sugeridas + conduta)
-- =====================================================================
--
-- PLANO_COACH_RESPOSTA_E_CONDUTA.md (raiz do workspace), §4. Fase 4 das
-- features de IA, em cima do que 20260808201000_hub_ia_analise_csat.sql já
-- criou (risco / risco_motivo).
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION HABILITA
-- ---------------------------------------------------------------------
-- Quando services/analiseIA.ts classifica uma conversa como risco médio ou
-- alto, a MESMA chamada à Anthropic também devolve:
--   · até 3 respostas prontas, que o atendente CLICA na Caixa para preencher
--     o campo de resposta (nunca há envio automático — mensagem enviada ao
--     cliente não se desfaz);
--   · orientações de como conduzir aquela conversa, exibidas no bloco
--     "Como conduzir" da Ficha, junto de 3 linhas fixas que vivem no front.
--
-- A última orientação da lista (para quem escalar) é montada em CÓDIGO, com o
-- nome lido de hub.supervisao por service_role. Não é pedida ao modelo: nome
-- de pessoa é o campo que um LLM preenche com algo plausível e errado. E não
-- pode ser lida pelo front porque a policy `supervisao_select` só deixa o
-- próprio supervisor (ou um admin) enxergar aquelas linhas.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · DDL 100% aditivo, três colunas nullable. Nenhuma coluna, constraint,
--     índice ou policy existente é alterada. Pode rodar com o sistema no ar.
--   · RLS: as policies de hub.conversas são por LINHA, não por coluna — as
--     colunas novas herdam o mesmo controle de acesso. A escrita é
--     service_role (ignora RLS), como o resto da IA já é.
--   · Realtime: hub.conversas já está publicada com replica identity full
--     (20260731000200), então o UPDATE feito pelo serviço chega sozinho na
--     Caixa aberta. Nada a fazer aqui.
--   · SEM ÍNDICE, de propósito: as três colunas só são lidas junto da linha da
--     conversa que a tela já carrega; nunca aparecem em cláusula `where`.
--   · SEM CHECK CONSTRAINT, de propósito: um valor fora do domínio faria o
--     Postgres rejeitar o UPDATE INTEIRO, derrubando junto o `sentimento` e o
--     `risco` que estavam corretos. O saneamento (tamanho do texto, quantidade
--     de itens, item vazio) é feito em interpretarAnalise(), antes do banco —
--     mesma decisão registrada na fase 1.
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 0. Guarda: abortar se rodar contra o projeto ou o estado errado
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 1. Colunas
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 2. AUTOVALIDAÇÃO
--
--    Existe porque no SQL Editor do Supabase TODO DDL devolve exatamente
--    "Success. No rows returned" — indistinguível entre "rodou" e "colei e
--    não rodei". Em 08/08 um script de rollback rodou por engano e isso só
--    apareceu quando a conferência voltou zero linhas. Com o bloco abaixo,
--    "terminou sem erro" passa a ser prova de aplicação completa, e uma falha
--    parcial desfaz sozinha em vez de deixar meio estado.
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]
-- =====================================================================
-- ORDEM DE DEPLOY — importante
-- =====================================================================
--
--   1. Aplicar esta migration e conferir as 3 linhas do bloco abaixo.
--   2. Deploy do hub-api. Com o código no ar e as colunas ausentes, cada
--      UPDATE falha e o erro só aparece no log — analiseIA.ts é
--      fire-and-forget e nunca relança, por contrato.
--   3. Deploy do hub-front COM os build-args VITE_* (`gcloud run deploy
--      --source .` os ignora — incidente de 07/08/2026).
--
-- =====================================================================
-- CONFERÊNCIA PÓS-APLICAÇÃO — deve devolver 3 linhas
-- =====================================================================
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'hub'
--      and table_name   = 'conversas'
--      and column_name in ('coach_sugestoes','coach_orientacoes','coach_atualizado_em')
--    order by column_name;
--
-- Esperado:
--   coach_atualizado_em | timestamp with time zone | YES
--   coach_orientacoes   | ARRAY                    | YES
--   coach_sugestoes     | ARRAY                    | YES
--
-- Para desfazer: 20260808220000_hub_conversas_coach_rollback.sql
--
-- (O prefixo nasceu 20260808210000 e foi movido para ...220000: colidia com
-- 20260808210000_hub_conversas_nota_atendimento.sql, que também está pendente.
-- Em `supabase db push` a versão é a chave de `schema_migrations` — duas iguais
-- dão conflito ou aplicação parcial silenciosa no próximo ambiente. É o mesmo
-- tropeço que a fase 1 já teve com o 20260808200000.)
--
-- =====================================================================
-- RECONCILIAÇÃO — rodar na primeira semana e depois mensalmente
-- =====================================================================
--
-- Mesmo motivo das R1-R4 da fase 1: o serviço engole as próprias falhas por
-- contrato, então nada aparece na tela quando o coach para de ser gerado.
--
-- R5 — risco sem coach. Esperado baixo e estável (resíduo de restart do Cloud
--      Run no meio do debounce + conversas anteriores ao deploy). Crescendo =
--      a geração parou.
--
--   select count(*) from hub.conversas
--    where fechada_em is null
--      and risco in ('medio','alto')
--      and (coach_sugestoes is null or cardinality(coach_sugestoes) = 0);
--
-- R6 — coach órfão. DEVE SER 0: sugestão viva em conversa sem risco ou já
--      fechada significa caminho de zeragem incompleto.
--
--   select count(*) from hub.conversas
--    where coach_sugestoes is not null
--      and (fechada_em is not null or risco is null or risco = 'baixo');
--
--   -- Limpeza pontual do resíduo, se R6 > 0 (revisar antes de rodar):
--   -- update hub.conversas
--   --    set coach_sugestoes = null, coach_orientacoes = null, coach_atualizado_em = null
--   --  where coach_sugestoes is not null
--   --    and (fechada_em is not null or risco is null or risco = 'baixo');
--
-- R7 — invariante das três colunas. DEVE SER 0: elas se movem juntas.
--
--   select count(*) from hub.conversas
--    where (coach_atualizado_em is null) <> (coach_sugestoes is null);
--
-- R8 — saneamento respeitado. DEVE SER 0: item acima do teto ou lista acima da
--      cardinalidade máxima significa que o validador foi contornado.
--
--   select count(*) from hub.conversas
--    where cardinality(coach_sugestoes)   > 3
--       or cardinality(coach_orientacoes) > 5
--       or exists (select 1 from unnest(coach_sugestoes)   s where length(s) > 300)
--       or exists (select 1 from unnest(coach_orientacoes) o where length(o) > 220);
--
-- R9 — truncamento silencioso. A saída do modelo cresceu ~400 tokens com o
--      coach; se isto passar a aparecer, subir MAX_TOKENS em analiseIA.ts.
--
--   select count(*) from hub.conversas
--    where analise_ia_erro like '%truncada%'
--      and atualizado_em > now() - interval '7 days';
-- =====================================================================


-- =====================================================================
-- >>> 20260808230000_hub_conversas_aberta_em_idx.sql
-- =====================================================================

-- 20260808230000_hub_conversas_aberta_em_idx.sql
-- Painel clicável + Alice contextual (PLANO_PAINEL_CLICAVEL_ALICE_CONTEXTUAL.md, §4.2).
--
-- POR QUE. O contexto da Alice (services/alice.ts) filtra `aberta_em >= …` SEM
-- filtro de status. O único índice existente com essa coluna é
-- conversas_status_aberta_idx (status, aberta_em desc) — com `status` como
-- coluna líder, ele não atende essa consulta, que hoje faz seq scan.
--
-- Com o indicador em foco a consulta piora em dois eixos ao mesmo tempo: a
-- janela DOBRA (atual + anterior, para o delta) e ela passa a rodar a cada
-- clique de card, não a cada pergunta digitada.
--
-- NÃO É OBRIGATÓRIO. A feature funciona sem este índice; a base de hoje tem
-- dezenas de conversas. Isto é o que evita que o Painel vire o gargalo quando
-- ela crescer.
--
-- `create index` comum, NÃO concurrently: concurrently não roda dentro de
-- transação, e é a transação que dá a autovalidação do fim do bloco. A tabela
-- é pequena; o lock de escrita dura milissegundos.
--
-- Seguro a qualquer momento, antes ou depois do deploy do código: não muda
-- comportamento nenhum, só o plano de execução.
-- [begin removido: transacao unica]
create index if not exists conversas_aberta_em_idx
  on hub.conversas (aberta_em desc);

comment on index hub.conversas_aberta_em_idx is
  'Janela temporal do contexto da Alice (services/alice.ts) e do Painel. '
  'Complementa conversas_status_aberta_idx, que só serve a consultas com status.';

-- Autovalidação. Sem isto, "Success. No rows returned" no editor do Supabase
-- seria indistinguível entre "aplicou" e "colei no editor e não rodei" — foi
-- exatamente assim que um rollback rodado por engano passou despercebido uma
-- vez neste projeto. Com o raise, "sem erro" vira prova de aplicação, e uma
-- falha parcial desfaz sozinha em vez de deixar meio estado.
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
-- [commit removido: transacao unica]
-- ---------------------------------------------------------------------------
-- CONFERÊNCIA — rode SEPARADO, em uma segunda execução.
-- Ela RETORNA LINHA: é isso que prova que o índice existe, e não a ausência de
-- erro do bloco acima. Esperado: exatamente 2 linhas.
-- ---------------------------------------------------------------------------
-- select
--   i.relname                                as indice,
--   pg_get_indexdef(i.oid)                   as definicao,
--   pg_size_pretty(pg_relation_size(i.oid))  as tamanho
-- from pg_class i
-- join pg_namespace n on n.oid = i.relnamespace
-- where n.nspname = 'hub'
--   and i.relname in ('conversas_aberta_em_idx', 'conversas_status_aberta_idx')
-- order by i.relname;


-- =====================================================================
-- >>> 20260809120000_hub_meu_perfil_ativo.sql
-- =====================================================================

-- =====================================================================
-- 20260809120000_hub_meu_perfil_ativo.sql
-- Auditoria 2026-08-09, item 2.
-- =====================================================================
--
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- `hub.meu_perfil()` nasceu em 20260731000100 resolvendo o atendente por
-- e-mail, sem filtrar `ativo` — enquanto `hub.meu_atendente_id()`, escrita no
-- mesmo arquivo, filtra `ativo` e prefere o vínculo explícito por `user_id`.
-- As duas funções de identidade divergiram, com duas consequências:
--
--   1. ATENDENTE DESLIGADO CONTINUA ADMIN. `ativo = false` mata
--      meu_atendente_id() e minhas_empresas(), mas não meu_perfil() — então
--      hub.sou_admin() segue devolvendo true e a RLS libera leitura e escrita
--      em TODAS as tabelas de TODAS as empresas. O comentário do schema diz
--      que `ativo` existe justamente para "excluir atendente desligado da
--      resolução de identidade"; a função de perfil ficou de fora.
--      O backend não é afetado (usa service_role e checa `ativo` em
--      buscarAtendenteAutenticado); o front, que fala direto com o PostgREST
--      sob RLS, é.
--
--   2. ADMIN COM E-MAIL TROCADO NO AUTH PERDE O PERFIL. meu_atendente_id()
--      casa por user_id; meu_perfil() só por e-mail. Trocar o e-mail no
--      auth.users mantinha a identidade e zerava o perfil, em silêncio.
--
-- A correção é derivar o perfil de meu_atendente_id(), herdando as duas regras
-- de uma vez. O fallback por e-mail (primeiro login, antes de
-- hub.vincular_usuario gravar o vínculo) NÃO é perdido — ele mora dentro de
-- meu_atendente_id().
--
-- IMPACTO: hub.sou_admin() lê daqui, e sou_admin() aparece em ~20 policies.
-- Rode o DIAGNÓSTICO abaixo ANTES de aplicar — cada linha devolvida é uma
-- pessoa que perde acesso administrativo:
--
--   select a.id, a.nome, a.email, a.perfil, a.ativo
--   from hub.atendentes a
--   where a.perfil in ('admin','supervisor')
--     and (a.ativo = false or a.ativo is null);
--
-- Rollback: 20260809120000_hub_meu_perfil_ativo_rollback.sql
-- =====================================================================
-- [begin removido: transacao unica]
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

-- create or replace preserva grants; reafirmados por segurança.
revoke all on function hub.meu_perfil() from public;
grant execute on function hub.meu_perfil() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Autovalidação. Qualquer asserção falhando aborta a transação inteira.
-- "Success. No rows returned" não prova nada — a prova é a NOTICE final.
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260810120000_hub_midia_grupos_transcricao.sql
-- =====================================================================

-- 20260810120000_hub_midia_grupos_transcricao.sql
-- Conversas na íntegra: mídia, transcrição de áudio, grupos e tipos extras.
-- Ver PLANO_MENSAGENS_INTEGRA_WHATSAPP.md (raiz do repo).
--
-- ORDEM DE DEPLOY: este SQL ANTES do hub-api, e o hub-api ANTES do hub-front.
-- O `select("*")` do front sobrevive à ausência de coluna (PostgREST devolve
-- menos campos), mas toda GRAVAÇÃO em coluna inexistente falha com 42703 —
-- mesmo raciocínio de 20260808210000_hub_conversas_nota_atendimento.sql.
--
-- Tudo aqui é ADITIVO e com default. Nenhuma linha existente muda de
-- comportamento e nenhum backfill é necessário — a seção 6.5 abaixo PROVA
-- isso antes de deixar o commit passar.
--
-- Cole o bloco INTEIRO de uma vez. O rollback está em
-- supabase/rollback/20260810120000_..._rollback.sql — NUNCA cole os dois
-- juntos ("Success. No rows returned" não distingue um do outro).
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 1. hub.mensagens — conteúdo rico
--    A tabela já tinha midia_url/midia_tipo desde 20260731000300 e nunca
--    foram escritas por ninguém (nem backend nem front). midia_url fica
--    reservada para URL externa/pública; o fluxo do WhatsApp usa
--    midia_objeto (CAMINHO no bucket), porque URL assinada gravada em
--    coluna apodrece em minutos.
-- ---------------------------------------------------------------------
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

-- Filas de trabalho do backend. Parciais: só o que está pendente interessa.
-- É por estes índices que o job de varredura acha mídia perdida num restart
-- do Cloud Run (a fila do processo é em memória, por design).
create index if not exists mensagens_midia_pendente_idx
  on hub.mensagens (midia_status, enviada_em)
  where midia_status in ('pendente','baixando','falhou');

create index if not exists mensagens_transcricao_pendente_idx
  on hub.mensagens (transcricao_status, enviada_em)
  where transcricao_status in ('pendente','processando');

-- ---------------------------------------------------------------------
-- 2. hub.clientes — grupo é um "cliente" com tipo_chat='grupo'
--    Decisão D4 do plano. A alternativa (tabela hub.grupos +
--    conversas.grupo_id) obrigaria a tornar conversas.cliente_id NULÁVEL —
--    e essa FK é lida por Painel, Alice, resumo, análise e CSAT. O custo
--    desta escolha é uma palavra mal aplicada no schema; o custo da outra
--    era mexer no eixo central do modelo.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3. hub.conversas — origem desnormalizada (filtro barato no Painel)
--    O Painel faz `conversas.select("*")` e calcula tudo no cliente. Sem
--    esta coluna, conversa de grupo entraria em "chamados abertos", "tempo
--    até 1ª resposta" e "SLA" sem ninguém pedir.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 4. hub.canais — grupos entram por OPT-IN do admin, por linha
--    Default FALSE não é timidez: uma linha pareada a um celular com 40
--    grupos despejaria 40 conversas na Caixa no primeiro minuto. O admin
--    liga linha a linha, pela tela de Configurações → Canais.
-- ---------------------------------------------------------------------
alter table hub.canais
  add column if not exists receber_grupos boolean not null default false;

comment on column hub.canais.receber_grupos is
  'false (default) = mensagens de grupo continuam descartadas nesta linha, exatamente como antes desta feature. Desligar é o rollback da fase de grupos: um UPDATE, sem deploy.';

-- ---------------------------------------------------------------------
-- 5. hub.grupo_participantes — quem está no grupo (Ficha)
-- ---------------------------------------------------------------------
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

-- RLS espelhando clientes_select: quem enxerga o "cliente-grupo" enxerga o
-- roster dele. Escrita só pelo backend (service_role) — nenhum atendente
-- edita participante de grupo pela tela.
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

-- O `alter default privileges` de 20260731000000 já cobre tabela nova, mas
-- repetir torna este bloco independente da ordem histórica das migrations.
grant select, insert, update, delete on hub.grupo_participantes to authenticated;
grant all                            on hub.grupo_participantes to service_role;

-- ---------------------------------------------------------------------
-- 6. AUTOVALIDAÇÃO — falha e desfaz TUDO se algo não estiver de pé.
--    "Success. No rows returned" não prova nada no Supabase; estas
--    asserções provam.
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260810140000_hub_mensagens_criada_em.sql
-- =====================================================================

-- 20260810140000_hub_mensagens_criada_em.sql
-- Ordenação cronológica por atividade real (PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md §5.1).
--
-- POR QUE. `hub.mensagens.enviada_em` passa a carregar o relógio do WhatsApp
-- (messageTimestamp), não o instante em que o Hub processou o evento. O adapter
-- já resolvia esse valor (channels/baileys.adapter.ts) e o insert o descartava:
-- `enviada_em` caía no `default now()`. Em tempo real a diferença é de
-- milissegundos; o problema é o BACKLOG — o Baileys entrega de uma vez tudo que
-- chegou enquanto a sessão esteve fora, e este processo reinicia a cada deploy
-- do Cloud Run. A tarde inteira do cliente entrava com o carimbo da reconexão.
--
-- O EFEITO COLATERAL QUE ESTA COLUNA EXISTE PARA IMPEDIR. A varredura de mídia
-- presa (services/filaMidia.ts) procura `midia_status in ('pendente','baixando')`
-- com `enviada_em < now() - 15min`. Com `enviada_em` no passado, toda foto de
-- backlog nasceria JÁ VENCIDA pelo corte e seria varrida antes de o primeiro
-- download terminar — download duplicado, ou 'falhou' numa mídia que estava
-- chegando bem. O que aquele corte quer medir é há quanto tempo a LINHA está
-- presa aqui dentro. Isso é `criada_em`.
--
-- BACKFILL EXATO, não aproximado: hoje `enviada_em` É o instante de criação da
-- linha (default now(), nenhum caminho escreve nela). Copiar reconstrói o valor
-- verdadeiro; não é chute.
--
-- SEGURA ANTES DO DEPLOY: aditiva. O código atual ignora a coluna nova.
-- Aplicar ANTES de subir o backend novo — ele depende dela.
-- [begin removido: transacao unica]
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

-- Parcial: a varredura só olha mídia não resolvida. O índice acompanha o
-- predicado dela em vez de indexar a tabela inteira.
create index if not exists mensagens_midia_presa_idx
  on hub.mensagens (criada_em)
  where midia_status in ('pendente','baixando');

-- Autovalidação. "Success. No rows returned" no editor do Supabase é
-- indistinguível entre "aplicou" e "colei e não rodei" — foi assim que um
-- rollback rodado por engano passou despercebido uma vez neste projeto.
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260810141000_hub_tocar_conversa.sql
-- =====================================================================

-- 20260810141000_hub_tocar_conversa.sql
-- Ordenação cronológica por atividade real (PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md §5.2).
--
-- O QUE FAZ. Carimba `hub.conversas.atualizado_em` com o instante da MENSAGEM
-- (não o do processamento) e, opcionalmente, incrementa `nao_lidas`. É o que
-- faz a Caixa e o Kanban reordenarem.
--
-- POR QUE PRECISA SER UMA FUNÇÃO, e não um update do cliente:
--
-- 1. greatest(). O backend passa o instante da mensagem, e num backlog de
--    reconexão esse instante é PASSADO. Com atribuição simples a conversa
--    DESCERIA na lista justamente ao receber mensagem — o oposto do que se
--    pede dela. Com now(), um backlog de ontem subiria como se fosse de agora.
--    `greatest` é a única forma que atende os dois, e ela tem que acontecer
--    dentro do UPDATE: ler-comparar-gravar da aplicação perde a corrida.
--
-- 2. least(p_em, now()). O timestamp vem do relógio do APARELHO do cliente.
--    Passado antigo é legítimo (é o backlog); futuro nunca é, e um celular
--    adiantado pregaria a conversa no topo da Caixa até o mundo alcançar o
--    relógio dele. O backend já faz o mesmo clamp — repetido aqui porque esta
--    função é a última porta antes do dado e não pode confiar em quem a chama.
--
-- 3. Incremento atômico de nao_lidas. Substitui o select-então-update de
--    services/mensagens.ts, em que duas mensagens simultâneas liam 3 e ambas
--    gravavam 4 — uma delas sumia da contagem.
--
-- GRANTS no padrão de hub.vincular_usuario (20260731000100): só service_role.
-- O navegador nunca chama isto; o front não escreve ordem.
--
-- APLICAR ANTES do deploy do backend novo (que a chama). Segura com o código
-- antigo rodando: nada a invoca até o deploy.
-- [begin removido: transacao unica]
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

-- ---------------------------------------------------------------------
-- Autovalidação COMPORTAMENTAL, não só de existência.
--
-- Conferir que a função "existe" não provaria nada do que importa aqui: as
-- três regras (monotonicidade, clamp, incremento único) são o motivo de ela
-- existir. O teste roda contra uma linha temporária e a apaga no fim; se
-- qualquer regra falhar, o `raise` desfaz a transação inteira e a função nem
-- chega a ser criada.
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260814120000_hub_clientes_realtime.sql
-- =====================================================================

-- =====================================================================
-- hub.clientes no Realtime — o nome do contato na Caixa, sem F5
-- =====================================================================
--
-- Relato do Jens (11/08): no primeiro contato de um cliente novo a lista
-- da Caixa mostrava um traço no lugar do nome, e "sair e voltar" da tela
-- resolvia. Não era dado faltando no banco: era evento que nunca chegava.
--
-- O backend cria o cliente com `nome = telefone` (sentinela de "nunca
-- identificado", resolverCliente em src/services/mensagens.ts) e grava o
-- pushName depois, num UPDATE separado. A Caixa assina hub.conversas e
-- hub.mensagens, mas NÃO assinava hub.clientes — então esse segundo
-- evento não tinha por onde chegar à tela. Mesma lacuna fazia a edição
-- manual de identificação feita por um colega não aparecer para os outros.
--
-- Não leva `replica identity full`, de propósito: o front só consome o
-- valor NOVO da linha (INSERT/UPDATE já carregam a linha nova inteira com
-- qualquer replica identity) e ninguém depende do valor ANTERIOR nem de
-- DELETE nesta tabela. Ver a NOTA DE CAPACIDADE de
-- 20260731000200_hub_realtime.sql: `full` reescreve a linha completa no
-- WAL a cada update, e este banco já é apertado de WAL.
--
-- A RLS continua valendo: o Realtime aplica as policies por linha, então
-- o atendente só recebe evento de cliente que ele já podia ler.
-- =====================================================================
-- [begin removido: transacao unica]
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

-- Autovalidação: "Success. No rows returned" não prova nada no editor do
-- Supabase. Se a publicação não pegou, isto derruba a transação.
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260814130000_hub_canais_colunas_obsoletas.sql
-- =====================================================================

-- =====================================================================
-- BLOCO 2 — Fase 4 do plano das quedas periódicas (2026-08-14)
-- Higiene de dados: marcar as colunas de hub.canais que NINGUÉM escreve
-- =====================================================================
-- ---------------------------------------------------------------------
-- RENUMERADA em 2026-08-18: era 20260814120000, e colidia com
-- 20260814120000_hub_clientes_realtime.sql — dois assuntos diferentes,
-- vindos de commits diferentes (a5c0cfc e 7058f91), com o mesmo numero.
--
-- Por que importa: em `supabase db push` a versao (o timestamp) e chave em
-- supabase_migrations.schema_migrations. Dois arquivos com o mesmo numero
-- fazem UM SER PULADO EM SILENCIO. Este projeto aplica no SQL Editor, a
-- mao, entao a colisao nao pulou nada — mas deixava a armadilha armada
-- para o primeiro `db push` e tornava impossivel saber qual foi aplicado.
--
-- Renumerar este arquivo (e nao o outro) e seguro: ele so faz
-- `comment on column`, e portanto reaplicar e inofensivo.
-- ---------------------------------------------------------------------
--
-- Independente dos blocos 1 e 3: pode rodar a qualquer momento, antes ou
-- depois do deploy. Não altera nenhum dado e não faz drop de nada.
--
-- Por que isto existe: a pergunta "esta linha está conectada?" tinha seis
-- respostas possíveis no sistema, e três colunas participavam da confusão
-- sem nunca serem atualizadas. Isso não é só sujeira — é o que faz o
-- próximo diagnóstico começar errado. `hub.canais.status` chegou a ser
-- apresentado pela Alice como "Status registrado" e usado pelo Painel para
-- decidir o semáforo de saúde da linha, sendo uma constante desde o insert.
--
-- DELIBERADAMENTE NÃO FAZ `drop column`. Duas razões: não há urgência
-- nenhuma (o custo de manter é zero) e o custo de errar um drop em
-- produção é alto. O objetivo aqui é que a próxima pessoa que abrir o
-- schema saiba, pelo próprio banco, que esses campos não medem nada.
--
-- Idempotente: `comment on` sobrescreve o comentário anterior, então
-- rodar duas vezes é inofensivo. Não altera dado nenhum.
-- [begin removido: transacao unica]
-- Guarda: falhar alto se o alvo não existir, em vez de dar "Success" sobre
-- um schema diferente do esperado.
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

-- Autovalidação: "Success. No rows returned" não prova nada no Supabase.
-- Este select tem que devolver 4 linhas, todas com comentário preenchido.
select
  a.attname                                        as coluna,
  left(col_description(a.attrelid, a.attnum), 60)  as comentario,
  case when col_description(a.attrelid, a.attnum) is null
       then 'FALHOU' else 'ok' end                 as resultado
from pg_attribute a
where a.attrelid = 'hub.canais'::regclass
  and a.attname in ('status', 'conectado', 'qr_expira_em', 'conexao_status')
order by a.attname;
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260818120000_hub_rls_escopo_atendente.sql
-- =====================================================================

-- =====================================================================
-- Escopo de conversa por ATENDENTE (era por empresa)
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Relato de 2026-08-17 (Jens Hasse / Cristiano): um operador enxergava
-- conversa de outras pessoas na Caixa; a Joyce, do Compras, leu uma
-- conversa do RH. O cliente parou de cadastrar usuários.
--
-- A causa de fundo não era a tela. `conversas_select` (20260731000100)
-- é `sou_admin() or setor_id in meus_setores() or canal_id in (canais
-- das minhas_empresas)` — e `hub.meus_setores()` devolve TODOS os
-- setores das minhas empresas. Os três termos dizem a mesma coisa: "é
-- da minha empresa". Nunca houve cláusula por `atendente_id`.
--
-- Resultado: todo atendente autenticado lia todas as conversas,
-- mensagens, transferências e notas das empresas vinculadas a ele. A
-- restrição "operador só vê as dele" existia apenas em JavaScript, e
-- qualquer pessoa com o DevTools aberto falava direto com o PostgREST.
--
-- REGRA NOVA (decidida com o cliente em 2026-08-17):
--   operador   -> SÓ as conversas atribuídas a ele.
--   supervisor -> os setores de hub.supervisao + as próprias.
--   admin      -> tudo (hub.sou_admin(), como antes).
--   + quem transferiu mantém LEITURA por 48h.
--   + conversa sem dono é do gestor da área e do admin.
--
-- ---------------------------------------------------------------------
-- PRÉ-REQUISITOS — nesta ordem, e o bloco 0 aborta se faltarem
-- ---------------------------------------------------------------------
--   1. 20260809120000_hub_meu_perfil_ativo.sql aplicada. Sem ela,
--      `hub.meu_perfil()` resolve por e-mail e ignora `ativo`: um admin
--      desligado continua admin em ~20 policies, e o gate de supervisor
--      abaixo herda o mesmo defeito.
--   2. Front já em produção com o modal de transferência corrigido (a
--      nota de sistema gravada ANTES do update). Se a RLS estreitar
--      primeiro, TODA transferência passa a falhar em silêncio.
--   3. hub.supervisao populada. Rodar as medições M3/M4 do
--      PLANO_GOVERNANCA_ACESSOS.md antes — supervisor sem linha na
--      tabela fica cego.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO MUDA (de propósito)
-- ---------------------------------------------------------------------
--   · `with check` de conversas_update / mensagens_insert /
--     transferencias_insert continua no escopo de EMPRESA. Endurecê-lo
--     quebraria a transferência: o estado pós-update é, por definição,
--     de outra pessoa.
--   · conversas_insert: quem cria conversa é o backend com service_role.
--   · clientes, setores, canais, atendentes, motivos_perda: escopo por
--     empresa, intocado.
--
-- Rollback: 20260818120000_hub_rls_escopo_atendente_rollback.sql
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 0. Guardas
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------

-- Setores que EU supervisiono. hub.supervisao existe desde o início e
-- NENHUMA policy a consultava — o "supervisor" tinha, no banco, exatamente
-- o mesmo alcance de um operador.
--
-- O gate de perfil mora AQUI, num lugar só: supervisor rebaixado a
-- operador perde a visão na hora, sem depender de alguém lembrar de
-- limpar a tabela.
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

-- Todos os canais SE eu for admin; conjunto vazio caso contrário.
--
-- Existe para o ramo de admin virar um predicado sobre COLUNA
-- (`canal_id = any(...)`) em vez de um `sou_admin() or ...` solto. Um
-- `sou_admin()` como primeiro termo do OR é avaliado POR LINHA: numa
-- Caixa com dezenas de milhares de conversas são dezenas de milhares de
-- joins de hub.atendentes com auth.users só para montar a lista.
create or replace function hub.canais_do_admin()
returns setof uuid
language sql
stable
security definer
set search_path = hub, public
as $$
  select c.id from hub.canais c where (select hub.sou_admin())
$$;

-- Conversas que EU transferi nas últimas 48h: leitura, nunca escrita.
-- Implementa "quem transfere mantém acesso por 48h" — o destinatário
-- volta perguntando "o que era mesmo?" e quem entregou precisa poder
-- responder.
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

-- Predicado POR LINHA para as tabelas filhas (mensagens, transferências,
-- notas). Lookup por chave primária.
--
-- Substitui o `conversa_id in (select hub.minhas_conversas())`, que
-- materializava o conjunto INTEIRO de ids visíveis a cada avaliação —
-- inclusive uma vez por mensagem, por assinante de Realtime. Com 20
-- atendentes online e 2 mil mensagens/dia isso eram 40 mil varreduras de
-- hub.conversas por dia.
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

-- Mantida por compatibilidade: código externo pode chamar, e há policies
-- em migrations pendentes que a referenciam. NÃO é mais usada por policy
-- nenhuma deste arquivo.
--
-- `sou_admin()` fica deliberadamente FORA: dentro dela, um admin
-- materializaria o id de todas as conversas do banco num hash.
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

-- ---------------------------------------------------------------------
-- 2. Índices
--    Compostos, casando o predicado novo com o `order by atualizado_em
--    desc` que Caixa e Kanban usam. Os simples (conversas_atendente_idx,
--    conversas_setor_idx) viram prefixos redundantes — NÃO derrubar no
--    mesmo commit: ainda servem a lookups de FK e o churn não paga.
-- ---------------------------------------------------------------------
create index if not exists conversas_atendente_atualizado_idx
  on hub.conversas (atendente_id, atualizado_em desc);
create index if not exists conversas_setor_atualizado_idx
  on hub.conversas (setor_id, atualizado_em desc);
-- Para hub.conversas_que_transferi(): sem ele, a janela de 48h faz um
-- scan de hub.transferencias a cada avaliação da policy.
create index if not exists transferencias_de_atendente_idx
  on hub.transferencias (de_atendente_id, transferida_em desc);

-- ---------------------------------------------------------------------
-- 3. Policies
-- ---------------------------------------------------------------------

-- hub.conversas SELECT — INLINE de propósito.
--
-- A policy de uma tabela NÃO pode chamar função que lê a própria tabela:
-- só não recursiona hoje porque o dono é isento de RLS (ver a guarda de
-- FORCE no bloco 0). Inline também deixa o planner usar os índices.
drop policy if exists conversas_select on hub.conversas;
create policy conversas_select on hub.conversas for select to authenticated
  using (
       atendente_id = (select hub.meu_atendente_id())
    or setor_id     = any (array(select hub.meus_setores_supervisionados()))
    or canal_id     = any (array(select hub.canais_do_admin()))
    or id           = any (array(select hub.conversas_que_transferi()))
  );

-- hub.conversas UPDATE.
--
-- O `using` passa a espelhar o select. Sem isso o operador deixaria de
-- VER a conversa alheia mas continuaria podendo ESCREVER nela por id —
-- inclusive `set atendente_id = eu`, auto-atribuindo-se qualquer conversa
-- da empresa. Escalada de privilégio silenciosa.
--
-- O `with check` PERMANECE no escopo de EMPRESA, e isso é obrigatório:
-- ele valida o estado DEPOIS do update, e numa transferência o estado
-- depois é "a conversa é de outra pessoa". Espelhar o select aqui faria
-- toda transferência responder 42501.
--
-- O ramo por canal no `with check` conserta um bug pré-existente:
-- `setor_id in (...)` com setor_id NULL devolve NULL, o check falha, e um
-- não-admin não conseguia nem marcar como lida (`nao_lidas = 0`) uma
-- conversa cujo canal não tem setor.
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

-- Tabelas filhas: predicado por linha, lookup por PK.
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

-- hub.conversa_notas só existe se 20260808210000 já foi aplicada.
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

-- ---------------------------------------------------------------------
-- 4. hub.v_conversao — REMOVIDA na Fase 0
--
--    A migration original recriava aqui a view de conversão, que casava
--    conversa com nota fiscal via `public.faturamento` — a réplica do ERP
--    de outro cliente. Não existe faturamento nesta plataforma: o
--    equivalente de "converteu" numa campanha é o resultado da triagem
--    (apoiador / indeciso / contrário), que a Fase 4 grava em
--    `conversas.etiquetas`. Ver docs/PLANO_CAMPANHA_INDIARA.md.
--
--    O escopo por atendente que esta migration veio aplicar continua
--    valendo para as três portas reais (conversas, mensagens,
--    transferencias) nas seções 1 a 3 acima.
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- 5. Autovalidação
--    "Success. No rows returned" não prova nada. Estes blocos provam.
-- ---------------------------------------------------------------------
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

-- AVISO, não erro: setor com linha de EQUIPE e sem supervisor cadastrado
-- é um buraco operacional — conversa sem dono nesses setores só o admin
-- vê. Não impede a migration; precisa de correção de DADO.
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
-- [commit removido: transacao unica]
-- =====================================================================
-- RECONCILIAÇÃO — rodar DEPOIS, como cada perfil (não como postgres,
-- que tem BYPASSRLS e não prova nada):
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<auth.users.id>","role":"authenticated"}';
--
--     -- R1. Operador: total tem que ser igual a "minhas"
--     select count(*) as total,
--            count(*) filter (where atendente_id = hub.meu_atendente_id()) as minhas
--     from hub.conversas;
--
--     -- R2. Nenhuma mensagem de conversa fora do escopo
--     select count(*) from hub.mensagens m
--     where not hub.posso_ver_conversa(m.conversa_id);
--     -- ESPERADO: 0
--
--     -- R4. Plano de execução: o Filter não deve mais mostrar sou_admin()
--     --     avaliado por linha, e os loops das subconsultas devem ser 1.
--     explain (analyze, buffers)
--       select * from hub.conversas where status <> 'fechado'
--       order by atualizado_em desc;
--   rollback;
-- =====================================================================


-- =====================================================================
-- >>> 20260831120000_campanha_eleitores.sql
-- =====================================================================

-- =====================================================================
-- FASE 1 — Modelo de dados eleitoral
-- =====================================================================
--
-- Ver docs/PLANO_CAMPANHA_INDIARA.md, Fase 1.
--
-- Decisão estruturante: ESTENDER as tabelas que já existem em vez de
-- criar um modelo paralelo de "eleitor". `hub.conversas`, `hub.mensagens`,
-- `hub.canais` e toda a RLS por atendente (20260818120000) apontam para
-- `hub.clientes`; uma tabela nova ao lado obrigaria a duplicar cada uma
-- dessas ligações, e a conversa que nasce de um disparo é a mesma
-- conversa que a Caixa mostra. O remapeamento é de VOCABULÁRIO (empresa =
-- campanha, setor = frente, cliente = eleitor), e vocabulário se resolve
-- na UI (Fase 6), não com um schema duplicado.
--
-- Esta migration faz cinco coisas:
--   1. hub.normalizar_telefone() — resolve a dívida de docs/divida-tecnica.md
--   2. colunas de campanha e de BASE LEGAL em hub.clientes
--   3. hub.importacoes, hub.listas, hub.lista_eleitores
--   4. colunas de ritmo em hub.disparos / hub.disparo_alvos
--   5. troca do guarda-corpo de transporte pelos três guarda-corpos novos
-- =====================================================================
-- [begin removido: transacao unica]
-- ---------------------------------------------------------------------
-- 1. hub.normalizar_telefone — a regra, agora em SQL
--
-- ESPELHO EXATO de `normalizarTelefone()` em src/services/mensagens.ts:
-- tira tudo que não é dígito; se sobrar 10 ou 11 dígitos (fixo ou celular
-- brasileiro sem DDI), prefixa `55`; qualquer outro tamanho volta como
-- está. Não "conserta" número — número estranho continua estranho, e é o
-- importador que decide rejeitá-lo.
--
-- POR QUE PRECISA EXISTIR EM SQL (e não só em TypeScript, como estava):
-- o importador da Fase 2 deduplica dezenas de milhares de linhas contra
-- hub.clientes.telefone. Dedupe em massa é trabalho de banco. Sem esta
-- função, o importador reimplementaria a regra numa terceira linguagem —
-- e duas normalizações que discordam num caso de borda produzem eleitor
-- duplicado, que vira DUAS MENSAGENS PARA A MESMA PESSOA.
--
-- `immutable` é o que permite usá-la em índice.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 2. hub.clientes vira o cadastro de eleitores
--
-- `origem` e `base_legal` são NOT NULL sem default de propósito: linha
-- nova tem que declarar de onde veio. As linhas que já existem (conversas
-- que nasceram de alguém escrevendo para a linha) recebem o backfill
-- abaixo, que é a verdade sobre elas — a pessoa iniciou o contato.
-- ---------------------------------------------------------------------
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

-- Backfill: quem já está na base chegou escrevendo para a linha.
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
  -- Base legal fechada, não texto livre. Cada valor é uma justificativa
  -- diferente para ter o número de alguém, e a diferença entre elas é o
  -- que decide se a pessoa pode receber disparo.
  add constraint clientes_base_legal_check
    check (base_legal in (
      'consentimento',                  -- opt-in explícito e registrável
      'contato_iniciado_pelo_titular',  -- a pessoa escreveu primeiro
      'legitimo_interesse',             -- exige justificativa em `origem`
      'nao_declarada'                   -- entra bloqueado, nunca dispara
    )),
  -- Coerência interna: opt-out e situação não podem discordar. Sem isto,
  -- um update parcial deixa a linha com data de descadastro e situação
  -- 'ativo', e o filtro do disparador (que olha situação) a inclui.
  add constraint clientes_opt_out_coerente
    check ((opt_out_em is null) = (situacao <> 'opt_out')),
  -- Base legal não declarada nunca fica 'ativo'.
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

-- ---------------------------------------------------------------------
-- 3. hub.importacoes — de onde veio cada telefone
--
-- Auditoria, não conveniência: quando alguém perguntar "por que vocês
-- têm o meu número", a resposta tem que sair de uma consulta, não da
-- memória de quem subiu a planilha.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 4. hub.listas — segmentos de disparo
--
-- A lista é MATERIALIZADA (hub.lista_eleitores), não um filtro salvo.
-- Um filtro reavaliado na hora do envio muda de tamanho entre a
-- aprovação do texto e o disparo — alguém importa uma planilha no meio e
-- a campanha aprovada para 800 pessoas sai para 4 mil. A lista congela
-- quem foi aprovado; o opt-out ainda tira gente dela (nunca acrescenta).
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 5. Ritmo do disparo
-- ---------------------------------------------------------------------
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

-- Índice do worker: ele pergunta "próximo pendente deste disparo" a cada
-- ciclo, e sem isto a pergunta vira seq scan numa tabela que cresce com
-- o tamanho da campanha.
create index disparo_alvos_proximo_idx
  on hub.disparo_alvos (disparo_id, agendado_para nulls first)
  where status = 'pendente';

-- ---------------------------------------------------------------------
-- 6. A troca dos guarda-corpos
--
-- O que sai: `disparos_bloqueia_baileys` / `hub.impede_disparo_baileys`,
-- que exigiam transporte='twilio' para qualquer disparo. Foi escrito como
-- allowlist e com razão — disparo em massa por Baileys é o caminho curto
-- para o ban do número. A campanha decidiu correr esse risco por escrito
-- (PLANO_CAMPANHA_INDIARA.md §1.1), com chip dedicado e reserva.
--
-- O que ENTRA no lugar, porque o schema não pode ficar sem guarda: três
-- travas de outra natureza, que protegem a PESSOA do outro lado em vez do
-- número da campanha.
-- ---------------------------------------------------------------------
drop trigger if exists disparos_bloqueia_baileys on hub.disparos;
drop function if exists hub.impede_disparo_baileys();

-- 6.1 — Nunca enfileirar quem pediu para sair.
--
-- Vale também para UPDATE: sem isso, um alvo enfileirado antes do
-- opt-out continua pendente na fila e é enviado depois do pedido.
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

-- 6.2 — Nenhum disparo começa com destinatário sem base legal.
--
-- Roda na transição para 'enviando', que é o único momento em que a
-- pergunta importa e em que a lista já está montada.
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

-- 6.3 — Teto diário conferido no BANCO, não só no worker.
--
-- O worker é um processo só e respeita o teto sozinho. Esta trava existe
-- para o dia em que houver dois (deploy sobrepondo instância, alguém
-- rodando um script de reenvio à mão): duas fontes de escrita, um teto.
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

-- ---------------------------------------------------------------------
-- 7. RLS das tabelas novas
--    Mesmo padrão do resto do schema: leitura escopada por empresa,
--    escrita só admin. `anon` não recebe nada, em lugar nenhum.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 8. Autovalidação
--    "Success. No rows returned" não prova nada. Estes blocos provam.
-- ---------------------------------------------------------------------

-- 8.1 — A normalização de telefone, contra a MESMA lista de casos que
--       src/services/normalizarTelefone.casos.ts. Se você mudar a regra
--       de um lado sem mudar do outro, um dos dois quebra na hora.
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

-- 8.2 — O guarda-corpo antigo saiu e os três novos entraram.
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

-- 8.3 — RLS ligada e `anon` sem nada nas tabelas novas.
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

-- 8.4 — Nenhum cadastro ficou sem base legal depois do backfill.
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
-- [commit removido: transacao unica]

-- =====================================================================
-- >>> 20260901120000_gateway_lease.sql
-- =====================================================================

-- =====================================================================
-- Posse do gateway — uma instância por vez
-- =====================================================================
--
-- Ver docs/DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md §0.3.
--
-- O PROBLEMA. O Render publica sem derrubar o serviço: a instância nova
-- sobe e passa no health check ANTES de a velha receber SIGTERM. Nessa
-- janela existem dois processos, e cada um:
--
--   1. marca `conexao_status = 'instavel'` em todo canal Baileys que o
--      banco diz estar conectado (a reconciliação de boot em
--      channels/registry.ts) — a instância nova corrompe o estado de
--      canais que a velha ainda tem VIVOS;
--   2. chama `reconectarCanaisAoSubir()` nos mesmos canais — duas sessões
--      Baileys na mesma identidade, que o WhatsApp derruba com
--      `440 connectionReplaced`, e as duas entram em duelo de reconexão;
--   3. roda o worker de disparo — dois processos tirando alvos da mesma
--      fila.
--
-- No Cloud Run isso se resolvia com `--max-instances=1`. No Render "uma
-- instância" NÃO resolve, porque a sobreposição acontece DENTRO do deploy.
--
-- POR QUE NÃO ADVISORY LOCK. `pg_try_advisory_lock` seria o instrumento
-- natural, mas é preso à sessão de conexão — e este backend não abre
-- conexão direta com o Postgres. Tudo passa por PostgREST, onde cada
-- chamada é uma conexão diferente do pool, então o lock morreria no
-- instante seguinte. Daí a posse em tabela, com prazo de validade.
--
-- POR QUE A FUNÇÃO, E NÃO UM UPDATE DO LADO DO NODE. A tomada precisa ser
-- atômica e usar o relógio do BANCO. Dois processos comparando
-- `expira_em` contra o próprio `Date.now()` decidem com relógios
-- diferentes — e o desacordo aparece justamente na troca de instância,
-- que é o único momento em que isto importa.
-- =====================================================================
-- [begin removido: transacao unica]
create table hub.gateway_lease (
  -- Uma linha só, para sempre. O `check (id)` impede que alguém insira
  -- `false` e crie uma segunda posse silenciosamente.
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

-- ---------------------------------------------------------------------
-- hub.tomar_lease — tomar OU renovar, atomicamente
--
-- Devolve `true` se esta instância é a dona depois da chamada. Um único
-- INSERT ... ON CONFLICT resolve os três casos:
--   · não existe posse       -> insere, é nossa
--   · a posse já é nossa     -> renova o prazo (tomado_em não muda)
--   · a posse é de outro     -> só toma se estiver VENCIDA
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- hub.liberar_lease — entregar a posse na saída
--
-- Chamada no SIGTERM. Sem ela a instância nova esperaria os 45s do prazo;
-- com ela a troca é imediata. Não apaga a linha: vencer o prazo preserva
-- quem foi o último dono, que é a informação útil no log.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Acesso
--
-- As funções são `security definer`: sem revogar do público, qualquer
-- autenticado poderia tomar a posse do gateway pelo PostgREST e derrubar
-- as linhas de WhatsApp de fora. Só o backend (service_role) executa.
-- ---------------------------------------------------------------------
revoke all on function hub.tomar_lease(text, int)  from public, anon, authenticated;
revoke all on function hub.liberar_lease(text)     from public, anon, authenticated;
grant execute on function hub.tomar_lease(text, int) to service_role;
grant execute on function hub.liberar_lease(text)    to service_role;

alter table hub.gateway_lease enable row level security;

-- Leitura para autenticado: o painel mostra quem é o dono e desde quando,
-- que é o primeiro dado a olhar quando "as linhas caíram". Escrita, só
-- pelas funções acima.
create policy gateway_lease_select on hub.gateway_lease for select to authenticated
  using (true);

-- ---------------------------------------------------------------------
-- Autovalidação
-- ---------------------------------------------------------------------
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
-- [commit removido: transacao unica]

-- =====================================================================
-- FIM. Confira acima se apareceram os NOTICE de '=== OK: ... ==='
-- =====================================================================
