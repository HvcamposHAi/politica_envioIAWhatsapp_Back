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

begin;

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

commit;

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
