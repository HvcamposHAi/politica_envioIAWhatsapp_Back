-- =====================================================================
-- hub.clientes.wa_jid — JID técnico do WhatsApp por contato
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- O QUE ESTA MIGRATION CORRIGE
-- ---------------------------------------------------------------------
-- Ver PLANO_CORRECAO_IDENTIFICACAO_LID_WHATSAPP.md (raiz do repo) para a
-- análise completa. Resumo: parte dos contatos do WhatsApp é roteada pelo
-- protocolo por um JID técnico "@lid" (opaco, não é telefone) em vez de
-- "@s.whatsapp.net". `agrotimbo_hubwhatsapp_bkend/src/channels/
-- baileys.adapter.ts` grava, hoje, o texto cru desse JID em
-- `hub.clientes.telefone` — daí os identificadores de 15-18 dígitos que
-- aparecem na Ficha/Chamados em vez de um número.
--
-- Pior do que a exibição: `hub.clientes.telefone` também é usado para
-- MONTAR o JID de saída quando o atendente responde pelo Hub
-- (routes/mensagens.ts -> BaileysChannel.enviar()). Para um contato @lid,
-- isso monta um JID que não corresponde à identidade real do contato — a
-- resposta pode não chegar.
--
-- Esta migration adiciona `hub.clientes.wa_jid`: o JID completo original
-- (ex. "5541999998888@s.whatsapp.net" ou "120363...@lid"), capturado pelo
-- código novo do adapter. Vira a fonte de verdade para:
--   1. Roteamento de envio (substitui a reconstrução por dígitos quando
--      presente).
--   2. Correlação de um contato @lid já conhecido, mesmo antes/depois do
--      telefone real aparecer via `senderPn` — evita fragmentar o cliente
--      em dois quando o telefone real for descoberto numa mensagem futura.
--
-- ---------------------------------------------------------------------
-- O QUE NÃO É AFETADO (de propósito)
-- ---------------------------------------------------------------------
--   · `hub.clientes.telefone` continua NOT NULL e é a chave de correlação
--     primária (`clientes_telefone_empresa`) — esta migration não mexe
--     nela, só adiciona uma coluna nova e nullable ao lado.
--   · Canais Twilio: não têm conceito de "@lid" — `wa_jid` nasce sempre
--     null para clientes que só falam por Twilio, sem efeito colateral.
--   · Nenhum dado existente é alterado por este SQL (a parte de código,
--     dentro da transação, é só DDL). O backfill de `wa_jid` para
--     clientes @lid já existentes é uma ação manual SEPARADA, descrita no
--     bloco de validação pós-aplicação no final deste arquivo — de
--     propósito fora da transação, para você conferir o diagnóstico antes
--     de gravar.
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
    where table_schema = 'hub' and table_name = 'clientes'
  ) then
    raise exception
      'hub.clientes não existe — rodar antes as migrations base do Hub '
      '(20260731000000_hub_schema.sql e seguintes).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Coluna nova, nullable — não muda o comportamento de nenhum cliente
--    existente até o código novo (ou o backfill manual) preenchê-la.
-- ---------------------------------------------------------------------
alter table hub.clientes add column if not exists wa_jid text;

-- ---------------------------------------------------------------------
-- 2. Um JID técnico não pode ser reaproveitado por dois clientes da
--    mesma empresa; null é permitido (contato sem wa_jid capturado
--    ainda, ex.: clientes só de canal Twilio).
-- ---------------------------------------------------------------------
create unique index if not exists clientes_wa_jid_empresa
  on hub.clientes (empresa_id, wa_jid)
  where wa_jid is not null;

-- ---------------------------------------------------------------------
-- 3. AUTOVALIDAÇÃO
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'hub' and table_name = 'clientes' and column_name = 'wa_jid'
  ) then
    raise exception 'hub.clientes.wa_jid não foi criada — migration incompleta.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'hub' and tablename = 'clientes' and indexname = 'clientes_wa_jid_empresa'
  ) then
    raise exception 'índice clientes_wa_jid_empresa não foi criado — migration incompleta.';
  end if;

  raise notice '=== OK: hub.clientes.wa_jid criada e indexada. ===';
end $$;

commit;

-- =====================================================================
-- VALIDAÇÃO E BACKFILL PÓS-APLICAÇÃO — rodar manualmente, fora desta
-- migration (SQL Editor do projeto Supabase Agrotimbo, zfbjwhaltqewbluqfmtt)
-- =====================================================================
--
-- 1. Confirmar a coluna:
--    select column_name, data_type, is_nullable
--    from information_schema.columns
--    where table_schema = 'hub' and table_name = 'clientes' and column_name = 'wa_jid';
--
-- 2. DIAGNÓSTICO — rodar ANTES de qualquer update, e LER o resultado.
--    Mostra quantos clientes hoje têm, em `telefone`, um valor comprido
--    demais para ser um telefone BR real (mais de 13 dígitos — 55+DDD+
--    número já é o máximo). São os candidatos ao problema relatado:
--
--      select length(telefone) as tamanho, count(*) as quantos
--      from hub.clientes
--      group by length(telefone)
--      order by tamanho desc;
--
--    Se alguma linha tiver `tamanho` entre 14 e 15, revise manualmente
--    antes de seguir — pode ser um número internacional legítimo (E.164
--    permite até 15 dígitos), não necessariamente um lid. Acima de 15,
--    é praticamente certo que é um lid.
--
-- 3. BACKFILL — marca esses clientes com `wa_jid` deduzido do próprio
--    `telefone` cru. Isso é o que evita que eles "fragmentem" em um
--    cliente novo assim que o código novo resolver o telefone real deles
--    numa mensagem futura (ver §5.3/§6.4 do plano) — o resolverCliente()
--    novo passa a achá-los pelo `wa_jid` antes de tentar achar por
--    telefone.
--
--      update hub.clientes
--      set wa_jid = telefone || '@lid'
--      where wa_jid is null
--        and length(telefone) > 13;
--
-- 4. Conferir que o backfill bateu com o diagnóstico do passo 2:
--
--      select count(*) as clientes_marcados
--      from hub.clientes
--      where wa_jid is not null;
--
-- 5. Se algo falhar ou precisar desfazer: aplicar
--    20260807160000_hub_clientes_wa_jid_rollback.sql
--    (o backfill do passo 3 é perdido junto — a coluna some — mas é
--    reaplicável rodando o passo 3 de novo depois de recriar a coluna).
-- =====================================================================
