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

begin;

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

commit;

-- hub.conversas já está na publicação supabase_realtime com replica identity
-- full (20260731000200) — as colunas novas propagam sozinhas para quem assina,
-- incluindo o Kanban, que passa a assinar o canal "chamados" nesta entrega.
-- hub.conversa_notas fica FORA da publicação de propósito: o histórico é lido
-- sob demanda (dialog do card), não vale um canal a mais.
notify pgrst, 'reload schema';
