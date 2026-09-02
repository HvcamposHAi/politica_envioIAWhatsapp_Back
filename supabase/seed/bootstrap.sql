-- =====================================================================
-- BOOTSTRAP — a primeira campanha e o primeiro admin
-- =====================================================================
--
-- POR QUE ISTO PRECISA EXISTIR. Depois de `supabase db push`, o schema
-- está completo e o banco está VAZIO. A tela de login só faz
-- `signInWithPassword` — não há cadastro — e `hub.meu_atendente_id()`
-- resolve o usuário casando `auth.users.email` com uma linha de
-- `hub.atendentes`. Sem essa linha, o login "funciona" no Supabase Auth e
-- a aplicação não reconhece ninguém: você entra e vê uma tela vazia, sem
-- mensagem de erro que explique o motivo.
--
-- Rode este arquivo UMA VEZ, no SQL Editor do Supabase, logo depois das
-- migrations. Ele é idempotente: rodar duas vezes não duplica nada.
--
-- COMO USAR
-- ---------------------------------------------------------------------
-- 1. Troque os três valores no bloco `dados` abaixo.
-- 2. Cole o arquivo inteiro no SQL Editor e execute.
-- 3. Crie o usuário no painel: Authentication > Users > Add user, com o
--    MESMO e-mail. Marque "Auto Confirm User".
-- 4. Entre na aplicação com esse e-mail e senha.
--
-- A ORDEM IMPORTA: a linha de `atendentes` nasce com `user_id` nulo, e é
-- o e-mail que faz a ligação. Criar o usuário do Auth antes ou depois dá
-- no mesmo; o que não pode é faltar um dos dois.
-- =====================================================================

begin;

do $$
declare
  -- ------------------------------------------------------------------
  -- TROQUE ESTES TRÊS VALORES
  -- ------------------------------------------------------------------
  v_email_admin  text := 'humberto@hai.expert';
  v_nome_admin   text := 'Humberto';
  v_nome_campanha text := 'Campanha Indiara';
  -- ------------------------------------------------------------------

  v_empresa_id  uuid;
  v_setor_id    uuid;
  v_atendente_id uuid;
begin
  if v_email_admin is null or position('@' in v_email_admin) = 0 then
    raise exception 'Troque v_email_admin por um e-mail de verdade antes de rodar.';
  end if;

  -- 1. A campanha. `hub.empresas` é a unidade de escopo de TODA a RLS;
  --    sem ela nenhuma consulta devolve linha.
  select id into v_empresa_id from hub.empresas where nome = v_nome_campanha;
  if v_empresa_id is null then
    insert into hub.empresas (nome, tipo)
    values (v_nome_campanha, 'campanha')
    returning id into v_empresa_id;
    raise notice 'campanha criada: %', v_nome_campanha;
  else
    raise notice 'campanha já existia: %', v_nome_campanha;
  end if;

  -- 2. Uma frente de trabalho. O Kanban e a fila precisam de pelo menos
  --    um setor para ter onde pendurar conversa.
  select id into v_setor_id
  from hub.setores where empresa_id = v_empresa_id and nome = 'Mobilização';
  if v_setor_id is null then
    insert into hub.setores (empresa_id, nome, cor)
    values (v_empresa_id, 'Mobilização', '#1f5f4a')
    returning id into v_setor_id;
  end if;

  -- 3. O admin. `user_id` fica NULO de propósito: quem faz a ligação com
  --    o Supabase Auth é o e-mail (ver hub.meu_atendente_id, segunda
  --    condição do OR). No primeiro login o vínculo é resolvido.
  select id into v_atendente_id
  from hub.atendentes where lower(email) = lower(v_email_admin);
  if v_atendente_id is null then
    insert into hub.atendentes (empresa_id, setor_id, nome, email, perfil, ativo)
    values (v_empresa_id, v_setor_id, v_nome_admin, lower(v_email_admin), 'admin', true)
    returning id into v_atendente_id;
    raise notice 'admin criado: %', v_email_admin;
  else
    raise notice 'admin já existia: %', v_email_admin;
  end if;

  -- 4. Vínculo N:N. `hub.minhas_empresas()` lê DESTA tabela, não de
  --    `atendentes.empresa_id` — sem esta linha o admin entra e não vê
  --    nada, que é o modo de falha mais confuso de todos.
  insert into hub.atendente_empresas (atendente_id, empresa_id)
  values (v_atendente_id, v_empresa_id)
  on conflict do nothing;

  raise notice '=== BOOTSTRAP OK ===';
  raise notice 'Agora crie o usuário em Authentication > Users > Add user';
  raise notice 'com o e-mail % e marque "Auto Confirm User".', v_email_admin;
end $$;

-- ---------------------------------------------------------------------
-- Conferência — o que você deve ver
-- ---------------------------------------------------------------------
select
  e.nome                                        as campanha,
  a.nome                                        as admin,
  a.email,
  a.perfil,
  (select count(*) from hub.atendente_empresas ae where ae.atendente_id = a.id) as empresas_vinculadas
from hub.atendentes a
join hub.empresas e on e.id = a.empresa_id
where a.perfil = 'admin';

commit;
