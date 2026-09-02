-- =====================================================================
-- PASSO 4 — Conferir o que subiu + criar a campanha e o primeiro admin
-- =====================================================================
--
-- Cole INTEIRO no SQL Editor e rode. Duas partes:
--
--   PARTE A  confere que os guarda-corpos de verdade estão no banco.
--            Se algum faltar, ABORTA e nada da parte B acontece.
--   PARTE B  cria a campanha, a frente de trabalho e o admin, sem os
--            quais o login funciona e a aplicação mostra tela vazia.
--
-- Idempotente: rodar duas vezes não duplica nada.
--
-- ⚠️  TROQUE OS TRÊS VALORES no início da PARTE B antes de rodar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PARTE A — conferência
-- ---------------------------------------------------------------------
do $$
declare
  v_n        int;
  v_faltando text;
begin
  -- A1. As três travas de consentimento existem, e a trava velha de
  --     transporte (que exigia Twilio) não existe mais.
  if exists (select 1 from pg_trigger where tgname = 'disparos_bloqueia_baileys') then
    raise exception 'A trava velha de transporte ainda existe — o schema não é o esperado.';
  end if;

  select count(*) into v_n from pg_trigger
   where tgname in ('disparo_alvos_respeita_opt_out',
                    'disparos_exige_base_legal',
                    'disparo_alvos_confere_teto');
  if v_n <> 3 then
    raise exception 'Esperava 3 guarda-corpos de consentimento, encontrei %.', v_n;
  end if;

  -- A2. A posse do gateway, que impede duas instâncias do backend
  --     disputarem a mesma linha de WhatsApp durante um deploy.
  if to_regclass('hub.gateway_lease') is null then
    raise exception 'hub.gateway_lease não existe — a última migration não aplicou.';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'hub' and p.proname = 'tomar_lease') then
    raise exception 'hub.tomar_lease() não existe.';
  end if;

  -- A3. Toda tabela de hub com RLS ligada, e ZERO grant para `anon`.
  --     `anon` é a chave que vai no navegador de qualquer pessoa.
  select string_agg(c.relname, ', ') into v_faltando
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'hub' and c.relkind = 'r' and not c.relrowsecurity;
  if v_faltando is not null then
    raise exception 'Tabelas de hub SEM RLS: %', v_faltando;
  end if;

  select count(*) into v_n
    from information_schema.role_table_grants
   where table_schema = 'hub' and grantee = 'anon';
  if v_n > 0 then
    raise exception 'ERRO GRAVE: % grant(s) para `anon` no schema hub.', v_n;
  end if;

  -- A4. A regra de telefone do banco concorda com a do código. Se
  --     divergissem, o mesmo eleitor entraria duas vezes na base e
  --     receberia duas mensagens.
  if hub.normalizar_telefone('(47) 99988-7766') <> '5547999887766'
     or hub.normalizar_telefone('999887766') <> '999887766' then
    raise exception 'hub.normalizar_telefone não está com o comportamento esperado.';
  end if;

  -- A5. O CRM que já morava neste projeto continua de pé.
  select count(*) into v_n
    from information_schema.tables where table_schema = 'public';
  if v_n = 0 then
    raise exception 'O schema public está vazio — algo apagou o CRM. PARE e investigue.';
  end if;

  raise notice '=== PARTE A OK ===';
  raise notice '  3 travas de consentimento, posse do gateway, RLS completa,';
  raise notice '  zero grant para anon, telefone consistente,';
  raise notice '  e o schema public segue com % tabela(s).', v_n;
end $$;

-- ---------------------------------------------------------------------
-- PARTE B — bootstrap
-- ---------------------------------------------------------------------
do $$
declare
  -- ================= TROQUE ESTES TRÊS VALORES =================
  v_email_admin   text := 'humberto@hai.expert';
  v_nome_admin    text := 'Humberto';
  v_nome_campanha text := 'Campanha Indiara';
  -- =============================================================

  v_empresa_id   uuid;
  v_setor_id     uuid;
  v_atendente_id uuid;
begin
  if position('@' in v_email_admin) = 0 then
    raise exception 'Troque v_email_admin por um e-mail de verdade antes de rodar.';
  end if;

  -- B1. A campanha. hub.empresas é a unidade de escopo de TODA a RLS;
  --     sem ela nenhuma consulta devolve linha.
  select id into v_empresa_id from hub.empresas where nome = v_nome_campanha;
  if v_empresa_id is null then
    insert into hub.empresas (nome, tipo)
    values (v_nome_campanha, 'campanha')
    returning id into v_empresa_id;
    raise notice 'campanha criada: %', v_nome_campanha;
  else
    raise notice 'campanha já existia: %', v_nome_campanha;
  end if;

  -- B2. Uma frente de trabalho. Kanban e fila precisam de pelo menos um
  --     setor para ter onde pendurar conversa.
  select id into v_setor_id
    from hub.setores where empresa_id = v_empresa_id and nome = 'Mobilização';
  if v_setor_id is null then
    insert into hub.setores (empresa_id, nome, cor)
    values (v_empresa_id, 'Mobilização', '#1f5f4a')
    returning id into v_setor_id;
  end if;

  -- B3. O admin. `user_id` fica NULO de propósito: quem liga esta linha
  --     ao Supabase Auth é o E-MAIL (ver hub.meu_atendente_id, segunda
  --     condição do OR). O vínculo é resolvido no primeiro login.
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

  -- B4. Vínculo N:N. hub.minhas_empresas() lê DESTA tabela, não de
  --     atendentes.empresa_id — sem esta linha o admin entra e não vê
  --     nada, que é o modo de falha mais confuso de todos.
  insert into hub.atendente_empresas (atendente_id, empresa_id)
  values (v_atendente_id, v_empresa_id)
  on conflict do nothing;

  raise notice '=== PARTE B OK ===';
  raise notice 'Agora: Authentication > Users. Se % NÃO estiver lá,', v_email_admin;
  raise notice 'clique em Add user, use esse mesmo e-mail e marque "Auto Confirm User".';
end $$;

-- ---------------------------------------------------------------------
-- Resultado final — é isto que você deve ver
-- ---------------------------------------------------------------------
select
  e.nome                                          as campanha,
  a.nome                                          as admin,
  a.email,
  a.perfil,
  s.nome                                          as frente,
  (select count(*) from hub.atendente_empresas ae
    where ae.atendente_id = a.id)                 as empresas_vinculadas,
  (select count(*) from information_schema.tables
    where table_schema = 'hub')                   as tabelas_no_hub
from hub.atendentes a
join hub.empresas e on e.id = a.empresa_id
left join hub.setores s on s.id = a.setor_id
where a.perfil = 'admin';
