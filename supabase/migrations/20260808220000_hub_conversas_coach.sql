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

begin;

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

commit;

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
