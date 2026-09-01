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

begin;

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

commit;
