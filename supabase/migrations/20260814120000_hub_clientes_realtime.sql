-- =====================================================================
-- hub.clientes no Realtime — o nome do contato na Caixa, sem F5
-- =====================================================================
--
-- Relato do Jens (11/08): no primeiro contato de um cliente novo a lista
-- da Caixa mostrava um traço no lugar do nome, e "sair e voltar" da tela
-- resolvia. Não era dado faltando no banco: era evento que nunca chegava.
--
-- O backend cria o cliente com `nome = telefone` (sentinela de "nunca
-- identificado", resolverCliente em src/services/mensagens.ts) e grava o
-- pushName depois, num UPDATE separado. A Caixa assina hub.conversas e
-- hub.mensagens, mas NÃO assinava hub.clientes — então esse segundo
-- evento não tinha por onde chegar à tela. Mesma lacuna fazia a edição
-- manual de identificação feita por um colega não aparecer para os outros.
--
-- Não leva `replica identity full`, de propósito: o front só consome o
-- valor NOVO da linha (INSERT/UPDATE já carregam a linha nova inteira com
-- qualquer replica identity) e ninguém depende do valor ANTERIOR nem de
-- DELETE nesta tabela. Ver a NOTA DE CAPACIDADE de
-- 20260731000200_hub_realtime.sql: `full` reescreve a linha completa no
-- WAL a cada update, e este banco já é apertado de WAL.
--
-- A RLS continua valendo: o Realtime aplica as policies por linha, então
-- o atendente só recebe evento de cliente que ele já podia ler.
-- =====================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception
      'Publicação `supabase_realtime` não existe neste projeto — mesma falha fechada '
      'de 20260731000200_hub_realtime.sql.';
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'clientes'
  ) then
    raise notice 'já publicada: hub.clientes';
  else
    alter publication supabase_realtime add table hub.clientes;
    raise notice 'publicada: hub.clientes';
  end if;
end $$;

-- Autovalidação: "Success. No rows returned" não prova nada no editor do
-- Supabase. Se a publicação não pegou, isto derruba a transação.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'hub' and tablename = 'clientes'
  ) then
    raise exception 'Realtime incompleto: hub.clientes não está na publicação.';
  end if;
  raise notice '=== OK: hub.clientes publicada no Realtime. ===';
end $$;

commit;
