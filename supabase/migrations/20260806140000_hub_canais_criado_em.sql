-- =====================================================================
-- Auditoria — hub.canais.criado_em
-- =====================================================================
--
-- `hub.canais` nasceu em 20260731000000 sem nenhum timestamp de criação.
-- Isso impede diagnosticar linhas "zumbi": um canal criado no Passo 1 de
-- conectar-numero.tsx (grava direto em hub.canais, em `conexao_status =
-- 'lendo_qr'`) e nunca completado no Passo 2 (QR não lido, aba fechada,
-- erro do backend) fica ocupando `numero` na constraint
-- `canais_numero_unico` (20260731000000, linha 107) para sempre, sem
-- nenhum jeito de saber há quanto tempo aquilo está lá.
--
-- Convenção já usada em hub.canal_sessoes/hub.agentes_config e trazida
-- para hub.conversas em 20260805120000: timestamptz default now(),
-- mantido pela aplicação, não por trigger.
-- =====================================================================

begin;

alter table hub.canais
  add column if not exists criado_em timestamptz not null default now();

commit;
