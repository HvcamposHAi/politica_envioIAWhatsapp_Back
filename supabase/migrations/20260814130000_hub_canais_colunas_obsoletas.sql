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

begin;

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

commit;
