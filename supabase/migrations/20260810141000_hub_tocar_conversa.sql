-- 20260810141000_hub_tocar_conversa.sql
-- Ordenação cronológica por atividade real (PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md §5.2).
--
-- O QUE FAZ. Carimba `hub.conversas.atualizado_em` com o instante da MENSAGEM
-- (não o do processamento) e, opcionalmente, incrementa `nao_lidas`. É o que
-- faz a Caixa e o Kanban reordenarem.
--
-- POR QUE PRECISA SER UMA FUNÇÃO, e não um update do cliente:
--
-- 1. greatest(). O backend passa o instante da mensagem, e num backlog de
--    reconexão esse instante é PASSADO. Com atribuição simples a conversa
--    DESCERIA na lista justamente ao receber mensagem — o oposto do que se
--    pede dela. Com now(), um backlog de ontem subiria como se fosse de agora.
--    `greatest` é a única forma que atende os dois, e ela tem que acontecer
--    dentro do UPDATE: ler-comparar-gravar da aplicação perde a corrida.
--
-- 2. least(p_em, now()). O timestamp vem do relógio do APARELHO do cliente.
--    Passado antigo é legítimo (é o backlog); futuro nunca é, e um celular
--    adiantado pregaria a conversa no topo da Caixa até o mundo alcançar o
--    relógio dele. O backend já faz o mesmo clamp — repetido aqui porque esta
--    função é a última porta antes do dado e não pode confiar em quem a chama.
--
-- 3. Incremento atômico de nao_lidas. Substitui o select-então-update de
--    services/mensagens.ts, em que duas mensagens simultâneas liam 3 e ambas
--    gravavam 4 — uma delas sumia da contagem.
--
-- GRANTS no padrão de hub.vincular_usuario (20260731000100): só service_role.
-- O navegador nunca chama isto; o front não escreve ordem.
--
-- APLICAR ANTES do deploy do backend novo (que a chama). Segura com o código
-- antigo rodando: nada a invoca até o deploy.

begin;

create or replace function hub.tocar_conversa(
  p_conversa_id uuid,
  p_em          timestamptz,
  p_incrementar boolean default false
) returns timestamptz
language sql
volatile
as $$
  update hub.conversas
     set atualizado_em = greatest(atualizado_em, least(coalesce(p_em, now()), now())),
         nao_lidas     = coalesce(nao_lidas, 0) + case when p_incrementar then 1 else 0 end
   where id = p_conversa_id
  returning atualizado_em;
$$;

comment on function hub.tocar_conversa(uuid, timestamptz, boolean) is
  'Marca atividade na conversa com o instante da mensagem (monotonico, com clamp '
  'no futuro) e opcionalmente incrementa nao_lidas. Chamada por '
  'services/mensagens.ts. Ver PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md.';

revoke all on function hub.tocar_conversa(uuid, timestamptz, boolean) from public, anon, authenticated;
grant execute on function hub.tocar_conversa(uuid, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------------
-- Autovalidação COMPORTAMENTAL, não só de existência.
--
-- Conferir que a função "existe" não provaria nada do que importa aqui: as
-- três regras (monotonicidade, clamp, incremento único) são o motivo de ela
-- existir. O teste roda contra uma linha temporária e a apaga no fim; se
-- qualquer regra falhar, o `raise` desfaz a transação inteira e a função nem
-- chega a ser criada.
-- ---------------------------------------------------------------------
do $$
declare
  v_conv uuid;
  v_cli  uuid;
  v_can  uuid;
  v_ini  timestamptz := now() - interval '1 hour';
  v_r    timestamptz;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname='hub' and p.proname='tocar_conversa') then
    raise exception 'hub.tocar_conversa nao foi criada.';
  end if;

  select id into v_cli from hub.clientes limit 1;
  select id into v_can from hub.canais   limit 1;
  if v_cli is null or v_can is null then
    raise notice 'sem cliente/canal para o teste comportamental — validada so a assinatura.';
    return;
  end if;

  -- `fechada_em` preenchido de propósito: a linha de teste não pode aparecer
  -- na Caixa de ninguém nem por um instante.
  insert into hub.conversas (cliente_id, canal_id, status, aberta_em, atualizado_em, nao_lidas, fechada_em)
  values (v_cli, v_can, 'fechado', v_ini, v_ini, 0, now())
  returning id into v_conv;

  -- 1) mensagem ANTIGA (backlog) não pode puxar a conversa para trás
  v_r := hub.tocar_conversa(v_conv, v_ini - interval '2 hours', false);
  if v_r <> v_ini then
    raise exception 'monotonicidade quebrada: backlog moveu atualizado_em para %.', v_r;
  end if;

  -- 2) mensagem NOVA avança o carimbo
  v_r := hub.tocar_conversa(v_conv, v_ini + interval '10 minutes', true);
  if v_r <> v_ini + interval '10 minutes' then
    raise exception 'carimbo nao avancou como esperado: %.', v_r;
  end if;

  -- 3) timestamp no FUTURO é limitado a agora
  v_r := hub.tocar_conversa(v_conv, now() + interval '10 years', false);
  if v_r > now() then
    raise exception 'clamp de futuro falhou: %.', v_r;
  end if;

  -- 4) o incremento aconteceu exatamente uma vez (chamadas 1 e 3 eram false)
  if (select nao_lidas from hub.conversas where id = v_conv) <> 1 then
    raise exception 'nao_lidas incorreto apos exatamente 1 incremento.';
  end if;

  delete from hub.conversas where id = v_conv;
  raise notice 'tocar_conversa OK (monotonicidade, clamp e nao_lidas verificados).';
end $$;

commit;
