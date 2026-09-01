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

begin;

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

commit;
