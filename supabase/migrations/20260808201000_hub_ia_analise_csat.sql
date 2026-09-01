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

begin;

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

commit;

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
