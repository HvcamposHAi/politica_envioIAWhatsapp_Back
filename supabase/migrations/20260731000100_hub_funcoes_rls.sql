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

begin;

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

commit;

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
