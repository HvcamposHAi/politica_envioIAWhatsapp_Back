-- =====================================================================
-- FASE 5 (fechamento) — hub.conversas.atualizado_em + unicidade de
-- conversa aberta
-- =====================================================================
--
-- 1. atualizado_em
-- ---------------------------------------------------------------------
-- services/mensagens.ts precisa marcar "a conversa recebeu atividade
-- agora" (nova mensagem de cliente, eco de atendente pelo celular, ou
-- resposta pelo app) para o front ordenar/reordenar a lista sem depender
-- só de hub.mensagens.enviada_em via join. `hub.conversas` nunca teve
-- essa coluna — nasceu em 20260731000000 sem ela, e nenhuma migration
-- seguinte (operacao, ura) adicionou. Convenção de `atualizado_em` já
-- existe em duas tabelas do schema (hub.canal_sessoes,
-- hub.agentes_config): timestamptz default now(), mantido pela
-- aplicação, não por trigger — mesmo padrão aqui.
--
-- 2. conversas_aberta_por_cliente_canal
-- ---------------------------------------------------------------------
-- resolverConversaAberta (services/mensagens.ts) faz select-então-insert
-- sem lock. Dois eventos do mesmo cliente quase simultâneos (ex.: duas
-- mensagens em sequência rápida antes da primeira ter side-effects
-- completos) podem achar "nenhuma conversa aberta" os dois e criar duas
-- linhas — o cliente passa a ter dois threads abertos no mesmo canal,
-- mensagem futura caindo ora num ora noutro sem previsibilidade. Fecha a
-- mesma classe de corrida que `clientes_telefone_empresa` já fecha para
-- hub.clientes, com o mesmo padrão de tratamento no código (retry de
-- select ao pegar 23505).
--
-- Parcial (`where fechada_em is null`), não simples: um cliente pode ter
-- N conversas HISTÓRICAS fechadas no mesmo canal — só uma ABERTA por vez
-- é a invariante, não "uma conversa para sempre".
-- =====================================================================

begin;

alter table hub.conversas
  add column atualizado_em timestamptz not null default now();

-- Índice pela mesma razão de `conversas_status_aberta_idx`: Caixa/Kanban
-- ordenam conversa recente primeiro.
create index conversas_atualizado_em_idx on hub.conversas (atualizado_em desc);

create unique index if not exists conversas_aberta_por_cliente_canal
  on hub.conversas (cliente_id, canal_id) where fechada_em is null;

commit;
