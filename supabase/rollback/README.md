# Scripts de rollback — herdados, NÃO revisados

Estes arquivos vieram do hub de atendimento que originou esta plataforma.
Cada um desfaz a migration de mesmo nome em `../migrations/`.

**Três avisos antes de rodar qualquer um:**

1. O CLI do Supabase **não** lê esta pasta. `supabase db push` aplica só
   `../migrations/`. É exatamente por isso que os rollbacks moram aqui e
   não lá — um `_rollback.sql` dentro de `migrations/` seria aplicado na
   sequência e desfaria a migration anterior no meio do push.

2. **Nenhum deles foi revisado para esta plataforma.** Em particular,
   `20260818120000_hub_rls_escopo_atendente_rollback.sql` recria objetos
   que dependiam da réplica de ERP de outro cliente (`public.faturamento`,
   `public.clientes`), removida na Fase 0. Rodá-lo como está falha.

3. Num banco novo, rollback de migration de baseline quase nunca é a
   ferramenta certa: recriar o projeto é mais rápido e mais confiável.
   Estes scripts servem para o dia em que o banco tiver dados de campanha
   que não podem ser perdidos.

O rollback de `20260810120000_hub_midia_grupos_transcricao` foi perdido na
limpeza da Fase 0 (a pasta original foi removida junto com os
diagnósticos do outro cliente, e não havia histórico de git para
recuperar). A migration correspondente continua em `../migrations/` e é
aplicável normalmente.
