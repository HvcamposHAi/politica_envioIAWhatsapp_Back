-- =====================================================================
-- Correções do disparo — dossiê de 10/09/2026
-- =====================================================================
--
-- Origem: campanha de teste de 04/09 não enviou nenhuma mensagem. A
-- investigação (dossiê "Por que o disparo não saiu") achou quinze
-- defeitos; os que vivem no banco estão corrigidos aqui.
--
-- O que esta migration resolve:
--
--   D-05  hub.confere_teto_diario() só incrementava enviados_hoje quando
--         havia teto explícito. Como a UI nunca define teto, o contador
--         ficava travado em 0 PARA SEMPRE — e a rampa de aquecimento
--         (services/ritmoDisparo.ts) lê exatamente esse contador. Ou
--         seja: a rampa que a tela promete ao admin nunca freou nada.
--
--   D-06  O mesmo gatilho virava o dia por `current_date`, que roda no
--         fuso do BANCO (UTC no Supabase), enquanto o worker decide por
--         America/Sao_Paulo. O comentário antigo afirmava que os dois
--         concordavam. Não concordavam: três horas de desacordo, e a
--         virada caía dentro da janela de envio (que fecha às 20:00).
--
--   D-11  A retirada de alvo da fila era `select ... limit 1` seguido de
--         `update` segundos depois. A posse do gateway reduz o risco,
--         mas ela é falha-fechada com TTL de 45s: uma instabilidade de
--         rede na renovação e duas instâncias se sobrepõem. O índice
--         único barra a duplicata DEPOIS de a mensagem ter saído.
--
--   D-10  `pausa_motivo` é texto livre, então não havia como distinguir
--         por código "a linha caiu sozinha e já voltou" de "um humano
--         mandou parar". Sem essa distinção, retomada automática é
--         impossível de fazer com segurança.
--
--   Estágios 1 e 5 da mecânica proposta precisam de estados novos em
--   hub.disparo_alvos (`sem_whatsapp`, `entrega_incerta`) e de um estado
--   de reserva (`enviando_agora`).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Estados novos do alvo
--
--   sem_whatsapp      — o pré-voo (onWhatsApp) disse que o número não
--                       está registrado. NUNCA entra como 'pendente':
--                       hoje o adapter reconstruiria o JID por dígitos e
--                       o sendMessage devolveria um id normalmente, com
--                       a mensagem indo para lugar nenhum. Este estado é
--                       o que transforma uma falha silenciosa em número
--                       na tela ANTES do disparo.
--   enviando_agora    — reservado por uma instância, ainda não enviado.
--   entrega_incerta   — saiu, o WhatsApp aceitou, e o ack de entrega não
--                       chegou dentro do prazo. Não é 'falhou' (pode ter
--                       chegado) e não pode continuar contando como
--                       sucesso.
-- ---------------------------------------------------------------------
alter table hub.disparo_alvos
  drop constraint disparo_alvos_status_check;

alter table hub.disparo_alvos
  add constraint disparo_alvos_status_check
    check (status in (
      'pendente', 'enviando_agora', 'enviado', 'entregue', 'lido',
      'falhou', 'cancelado', 'sem_whatsapp', 'entrega_incerta'
    ));

alter table hub.disparo_alvos
  add column reservado_em timestamptz;

comment on column hub.disparo_alvos.reservado_em is
  'Quando este alvo foi tirado da fila por hub.reservar_proximo_alvo(). '
  'Reserva mais velha que o prazo volta para a fila por '
  'hub.liberar_alvos_travados() — senão um processo morto entre a '
  'reserva e o envio deixaria o alvo preso para sempre.';

-- Mapear ack -> alvo exige buscar por wa_message_id. Sem índice, todo
-- ack do WhatsApp vira seq scan numa tabela do tamanho da campanha.
create index disparo_alvos_wa_message_idx
  on hub.disparo_alvos (wa_message_id)
  where wa_message_id is not null;

-- A varredura de reservas travadas pergunta "quem está em enviando_agora
-- há mais de N minutos".
create index disparo_alvos_reservados_idx
  on hub.disparo_alvos (reservado_em)
  where status = 'enviando_agora';

-- ---------------------------------------------------------------------
-- 2. Motivo de pausa tipado (D-10)
--
-- `pausa_motivo` continua existindo e continua sendo o texto que a
-- pessoa lê na tela. O código passa a decidir por `pausa_codigo`, que é
-- fechado. A diferença importa para exatamente uma coisa: só
-- `linha_caiu` pode ser retomado automaticamente. Opt-out, taxa de falha
-- e parada manual exigem gente — e essa é a regra que protege a pessoa
-- do outro lado.
-- ---------------------------------------------------------------------
alter table hub.disparos
  add column pausa_codigo text;

alter table hub.disparos
  add constraint disparos_pausa_codigo_check
    check (pausa_codigo is null or pausa_codigo in (
      'linha_caiu', 'sem_canal', 'taxa_de_optout', 'taxa_de_falha',
      'parada_manual', 'parada_geral'
    ));

comment on column hub.disparos.pausa_codigo is
  'Por que a campanha está pausada, em valor fechado. Só "linha_caiu" é '
  'elegível a retomada automática (jobs/disparador.ts). Todo o resto '
  'espera decisão humana, de propósito.';

-- BACKFILL DELIBERADAMENTE CONSERVADOR. As campanhas que já estão
-- pausadas no banco foram pausadas pelo texto "a linha de WhatsApp caiu"
-- — o que, pela regra nova, as tornaria elegíveis a retomada automática
-- no primeiro boot depois deste deploy. Elas são as duas campanhas de
-- teste de 04/09, apontam para a MESMA lista de quatro pessoas, e
-- retomar as duas entrega mensagem em dobro (D-09). Entram como
-- 'parada_manual': nada retoma sozinho por causa desta migration.
update hub.disparos
   set pausa_codigo = 'parada_manual'
 where pausado_em is not null
   and pausa_codigo is null;

-- ---------------------------------------------------------------------
-- 2b. O interruptor de envio, por empresa e persistente (D-07 + D-13)
--
-- Até aqui o interruptor era uma variável em memória do processo. Dois
-- defeitos saíam disso:
--
--   D-07  `pararTudo()` pausava TODA campanha em status 'enviando', sem
--         filtro de empresa — um admin da empresa A parava as campanhas
--         da empresa B. Hoje há uma empresa só; o defeito estava
--         latente, não inofensivo.
--   D-13  todo restart devolvia o interruptor ao default do ambiente,
--         sem a tela perceber. "Parar tudo" clicado às 18h não
--         sobrevivia ao deploy das 19h.
--
-- Default `false`: uma empresa nova não dispara até alguém ligar de
-- propósito. É a mesma escolha do DISPARO_ATIVO do ambiente, que continua
-- existindo como chave-geral do PROCESSO — as duas precisam estar ligadas
-- para uma mensagem sair.
-- ---------------------------------------------------------------------
alter table hub.empresas
  add column disparo_ativo boolean not null default false;

comment on column hub.empresas.disparo_ativo is
  'Interruptor de envio desta empresa, persistente. Desligado por '
  '"Parar tudo" e religado por "Religar envio" (routes/disparos.ts). '
  'Combina com DISPARO_ATIVO do ambiente, que é a chave-geral do '
  'processo: as duas precisam estar ligadas.';

-- ---------------------------------------------------------------------
-- 3. O contador diário, consertado (D-05 + D-06)
--
-- Duas mudanças, ambas pequenas e ambas com consequência grande:
--
--   · o `return new` antecipado quando não há teto SAIU. O teto continua
--     sendo conferido só quando existe; o CONTADOR passa a ser escrito
--     sempre, porque quem depende dele não é o teto — é a rampa.
--   · `current_date` virou o dia civil no fuso da campanha, que é o
--     mesmo que diaNaCampanha() usa do lado do worker. Agora a afirmação
--     do comentário é verdadeira.
-- ---------------------------------------------------------------------
create or replace function hub.confere_teto_diario()
returns trigger
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare
  v_teto     int;
  v_enviados int;
  v_dia      date;
  -- O MESMO dia civil que services/ritmoDisparo.ts (diaNaCampanha) usa.
  -- `current_date` daria o dia em UTC: entre 21:00 e 00:00 de Brasília o
  -- banco já estaria no dia seguinte e zeraria o contador no meio da
  -- janela de envio, dando à campanha um teto extra toda noite.
  v_hoje     date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if new.status <> 'enviado' or old.status = 'enviado' then
    return new;
  end if;

  select d.teto_diario, d.enviados_hoje, d.contador_dia
    into v_teto, v_enviados, v_dia
  from hub.disparos d where d.id = new.disparo_id
  for update;

  -- Contador de outro dia é contador zerado.
  if v_dia is distinct from v_hoje then
    v_enviados := 0;
  end if;

  -- O teto explícito continua sendo opcional e continua sendo barreira
  -- dura quando existe. A rampa de aquecimento é conferida do lado do
  -- worker (ritmoDisparo.decidir), que lê o contador escrito logo abaixo.
  if v_teto is not null and v_enviados >= v_teto then
    raise exception
      'Teto diário do disparo % atingido (% de %). O envio recomeça amanhã.',
      new.disparo_id, v_enviados, v_teto;
  end if;

  -- SEMPRE. Este é o conserto de D-05: sem esta escrita, enviados_hoje
  -- fica em 0 para sempre em toda campanha sem teto explícito — que é
  -- toda campanha criada pela tela — e a rampa 40/80/150/250/400 nunca
  -- freia nada, apesar de o formulário prometer ao admin que freia.
  update hub.disparos
     set enviados_hoje = v_enviados + 1,
         contador_dia  = v_hoje
   where id = new.disparo_id;

  return new;
end $$;

-- ---------------------------------------------------------------------
-- 4. Reserva atômica do próximo alvo (D-11)
--
-- `FOR UPDATE SKIP LOCKED` é o instrumento certo para fila em Postgres:
-- duas instâncias chamando isto ao mesmo tempo recebem alvos DIFERENTES,
-- sem uma esperar a outra, sem nenhuma receber o mesmo.
--
-- `returns setof` e não o tipo composto direto: um composto sem match
-- devolve uma linha inteira de NULLs, que do lado do Node é
-- indistinguível de um alvo com todos os campos nulos. Com setof, "não
-- tem alvo" é uma lista vazia — que é o que de fato aconteceu.
-- ---------------------------------------------------------------------
create or replace function hub.reservar_proximo_alvo(p_disparo_id uuid)
returns setof hub.disparo_alvos
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
begin
  -- O UPDATE vai dentro de uma CTE e o RETURN QUERY devolve o SELECT dela.
  -- `RETURN QUERY UPDATE ... RETURNING` direto não é aceito em toda versão
  -- do PL/pgSQL; a forma com CTE é equivalente e universal.
  return query
  with reservado as (
    update hub.disparo_alvos a
       set status       = 'enviando_agora',
           reservado_em = now()
     where a.id = (
       select b.id
         from hub.disparo_alvos b
        where b.disparo_id = p_disparo_id
          and b.status = 'pendente'
        order by b.agendado_para nulls first, b.id
        for update skip locked
        limit 1
     )
    returning a.*
  )
  select * from reservado;
end $$;

comment on function hub.reservar_proximo_alvo(uuid) is
  'Tira UM alvo pendente da fila e o marca como enviando_agora, '
  'atomicamente. Substitui o select+update de jobs/disparador.ts, que '
  'deixava uma janela de segundos entre ler e marcar.';

-- ---------------------------------------------------------------------
-- 5. Devolver à fila o que ficou preso
--
-- Um processo que morre entre a reserva e o envio deixa o alvo em
-- `enviando_agora` para sempre. Todo deploy é um restart, então isto não
-- é hipótese remota.
--
-- Quem voltar para 'pendente' passa de novo pelo trigger de opt-out —
-- de propósito: entre a reserva e agora a pessoa pode ter pedido para
-- sair. Por isso os dois caminhos são separados, e quem não pode mais
-- receber vira 'cancelado' em vez de estourar a varredura inteira.
-- ---------------------------------------------------------------------
create or replace function hub.liberar_alvos_travados(p_minutos int default 2)
returns int
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare
  v_limite timestamptz := now() - make_interval(mins => greatest(p_minutos, 1));
  v_devolvidos int;
begin
  -- Quem não pode mais receber sai da fila em vez de voltar para ela.
  update hub.disparo_alvos a
     set status = 'cancelado',
         erro   = 'Descadastrado enquanto a reserva estava presa.'
    from hub.clientes c
   where a.cliente_id = c.id
     and a.status = 'enviando_agora'
     and a.reservado_em < v_limite
     and (c.opt_out_em is not null or c.situacao <> 'ativo');

  update hub.disparo_alvos a
     set status = 'pendente',
         reservado_em = null
   where a.status = 'enviando_agora'
     and a.reservado_em < v_limite;

  get diagnostics v_devolvidos = row_count;
  return v_devolvidos;
end $$;

comment on function hub.liberar_alvos_travados(int) is
  'Devolve à fila alvos reservados por um processo que morreu antes de '
  'enviar. Roda no boot e periodicamente (jobs/disparador.ts).';

-- ---------------------------------------------------------------------
-- 6. Acesso
--
-- Mesmo padrão de hub.tomar_lease: as funções mexem na fila de envio e
-- são `security definer`. Um autenticado qualquer chamando
-- reservar_proximo_alvo pelo PostgREST tiraria alvos da fila da campanha
-- sem enviar nada.
-- ---------------------------------------------------------------------
revoke all on function hub.reservar_proximo_alvo(uuid)  from public, anon, authenticated;
revoke all on function hub.liberar_alvos_travados(int)  from public, anon, authenticated;
grant execute on function hub.reservar_proximo_alvo(uuid) to service_role;
grant execute on function hub.liberar_alvos_travados(int) to service_role;

-- ---------------------------------------------------------------------
-- 7. Autovalidação
--
-- Mesmo padrão das migrations anteriores: a migration prova o que
-- afirma, na hora de aplicar, em vez de depender de alguém conferir
-- depois. Um teste de banco que não roda não é um teste.
-- ---------------------------------------------------------------------
do $$
declare
  v_empresa   uuid;
  v_cliente   uuid;
  v_disparo   uuid;
  v_alvo      uuid;
  v_enviados  int;
  v_dia       date;
  v_reservado uuid;
  v_conta     int;
begin
  select id into v_empresa from hub.empresas limit 1;
  if v_empresa is null then
    raise notice 'autovalidação pulada: nenhuma empresa cadastrada';
    return;
  end if;

  insert into hub.clientes (empresa_id, nome, telefone, origem, base_legal, situacao)
  values (v_empresa, 'Autovalidação Migration', '5500000000000',
          'autovalidacao', 'consentimento', 'ativo')
  returning id into v_cliente;

  insert into hub.disparos (empresa_id, nome, status, texto_base)
  values (v_empresa, 'autovalidacao 20260910', 'rascunho', 'x')
  returning id into v_disparo;

  insert into hub.disparo_alvos (disparo_id, cliente_id, telefone, status)
  values (v_disparo, v_cliente, '5500000000000', 'pendente')
  returning id into v_alvo;

  -- (a) A reserva é atômica e devolve exatamente um alvo.
  select id into v_reservado from hub.reservar_proximo_alvo(v_disparo);
  if v_reservado is distinct from v_alvo then
    raise exception 'autovalidação: reservar_proximo_alvo não devolveu o alvo pendente';
  end if;

  -- (b) A fila ficou vazia: uma segunda reserva não devolve linha nenhuma.
  select count(*) into v_conta from hub.reservar_proximo_alvo(v_disparo);
  if v_conta <> 0 then
    raise exception 'autovalidação: segunda reserva devolveu % linha(s), deveria ser 0', v_conta;
  end if;

  -- (c) D-05: o contador incrementa MESMO com teto_diario nulo.
  update hub.disparo_alvos set status = 'enviado' where id = v_alvo;

  select enviados_hoje, contador_dia into v_enviados, v_dia
  from hub.disparos where id = v_disparo;

  if v_enviados <> 1 then
    raise exception
      'autovalidação D-05: enviados_hoje = %, deveria ser 1 (campanha sem teto explícito)',
      v_enviados;
  end if;

  -- (d) D-06: o dia gravado é o de Brasília, não o de UTC.
  if v_dia <> (now() at time zone 'America/Sao_Paulo')::date then
    raise exception
      'autovalidação D-06: contador_dia = %, deveria ser % (fuso da campanha)',
      v_dia, (now() at time zone 'America/Sao_Paulo')::date;
  end if;

  delete from hub.disparo_alvos where disparo_id = v_disparo;
  delete from hub.disparos where id = v_disparo;
  delete from hub.clientes where id = v_cliente;

  raise notice 'autovalidação OK: reserva atômica, contador sem teto e fuso da campanha';
end $$;

commit;
