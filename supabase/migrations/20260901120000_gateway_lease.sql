-- =====================================================================
-- Posse do gateway — uma instância por vez
-- =====================================================================
--
-- Ver docs/DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md §0.3.
--
-- O PROBLEMA. O Render publica sem derrubar o serviço: a instância nova
-- sobe e passa no health check ANTES de a velha receber SIGTERM. Nessa
-- janela existem dois processos, e cada um:
--
--   1. marca `conexao_status = 'instavel'` em todo canal Baileys que o
--      banco diz estar conectado (a reconciliação de boot em
--      channels/registry.ts) — a instância nova corrompe o estado de
--      canais que a velha ainda tem VIVOS;
--   2. chama `reconectarCanaisAoSubir()` nos mesmos canais — duas sessões
--      Baileys na mesma identidade, que o WhatsApp derruba com
--      `440 connectionReplaced`, e as duas entram em duelo de reconexão;
--   3. roda o worker de disparo — dois processos tirando alvos da mesma
--      fila.
--
-- No Cloud Run isso se resolvia com `--max-instances=1`. No Render "uma
-- instância" NÃO resolve, porque a sobreposição acontece DENTRO do deploy.
--
-- POR QUE NÃO ADVISORY LOCK. `pg_try_advisory_lock` seria o instrumento
-- natural, mas é preso à sessão de conexão — e este backend não abre
-- conexão direta com o Postgres. Tudo passa por PostgREST, onde cada
-- chamada é uma conexão diferente do pool, então o lock morreria no
-- instante seguinte. Daí a posse em tabela, com prazo de validade.
--
-- POR QUE A FUNÇÃO, E NÃO UM UPDATE DO LADO DO NODE. A tomada precisa ser
-- atômica e usar o relógio do BANCO. Dois processos comparando
-- `expira_em` contra o próprio `Date.now()` decidem com relógios
-- diferentes — e o desacordo aparece justamente na troca de instância,
-- que é o único momento em que isto importa.
-- =====================================================================

begin;

create table hub.gateway_lease (
  -- Uma linha só, para sempre. O `check (id)` impede que alguém insira
  -- `false` e crie uma segunda posse silenciosamente.
  id         boolean primary key default true,
  instancia  text not null,
  tomado_em  timestamptz not null default now(),
  expira_em  timestamptz not null,
  constraint gateway_lease_linha_unica check (id)
);

comment on table hub.gateway_lease is
  'Qual instância do backend pode segurar os sockets do WhatsApp e rodar o '
  'worker de disparo. Renovada a cada 15s pelo dono; expira em 45s. '
  'Ver src/jobs/lease.ts e docs/DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md §0.3.';

-- ---------------------------------------------------------------------
-- hub.tomar_lease — tomar OU renovar, atomicamente
--
-- Devolve `true` se esta instância é a dona depois da chamada. Um único
-- INSERT ... ON CONFLICT resolve os três casos:
--   · não existe posse       -> insere, é nossa
--   · a posse já é nossa     -> renova o prazo (tomado_em não muda)
--   · a posse é de outro     -> só toma se estiver VENCIDA
-- ---------------------------------------------------------------------
create or replace function hub.tomar_lease(p_instancia text, p_ttl_seg int default 45)
returns boolean
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare v_linhas int;
begin
  if p_instancia is null or length(trim(p_instancia)) = 0 then
    raise exception 'tomar_lease exige um identificador de instância';
  end if;

  insert into hub.gateway_lease (id, instancia, expira_em)
  values (true, p_instancia, now() + make_interval(secs => greatest(p_ttl_seg, 5)))
  on conflict (id) do update
     set instancia = excluded.instancia,
         expira_em = excluded.expira_em,
         -- `tomado_em` marca desde quando ESTA instância é dona. Renovação
         -- não mexe nele; troca de dono reinicia. É o que permite ver, no
         -- log, se a posse está trocando de mão sem parar.
         tomado_em = case
           when gateway_lease.instancia = excluded.instancia then gateway_lease.tomado_em
           else now()
         end
   where gateway_lease.instancia = p_instancia
      or gateway_lease.expira_em < now();

  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end $$;

-- ---------------------------------------------------------------------
-- hub.liberar_lease — entregar a posse na saída
--
-- Chamada no SIGTERM. Sem ela a instância nova esperaria os 45s do prazo;
-- com ela a troca é imediata. Não apaga a linha: vencer o prazo preserva
-- quem foi o último dono, que é a informação útil no log.
-- ---------------------------------------------------------------------
create or replace function hub.liberar_lease(p_instancia text)
returns boolean
language plpgsql
security definer
set search_path = hub, pg_catalog
as $$
declare v_linhas int;
begin
  update hub.gateway_lease
     set expira_em = now() - interval '1 second'
   where id = true and instancia = p_instancia;
  get diagnostics v_linhas = row_count;
  return v_linhas > 0;
end $$;

-- ---------------------------------------------------------------------
-- Acesso
--
-- As funções são `security definer`: sem revogar do público, qualquer
-- autenticado poderia tomar a posse do gateway pelo PostgREST e derrubar
-- as linhas de WhatsApp de fora. Só o backend (service_role) executa.
-- ---------------------------------------------------------------------
revoke all on function hub.tomar_lease(text, int)  from public, anon, authenticated;
revoke all on function hub.liberar_lease(text)     from public, anon, authenticated;
grant execute on function hub.tomar_lease(text, int) to service_role;
grant execute on function hub.liberar_lease(text)    to service_role;

alter table hub.gateway_lease enable row level security;

-- Leitura para autenticado: o painel mostra quem é o dono e desde quando,
-- que é o primeiro dado a olhar quando "as linhas caíram". Escrita, só
-- pelas funções acima.
create policy gateway_lease_select on hub.gateway_lease for select to authenticated
  using (true);

-- ---------------------------------------------------------------------
-- Autovalidação
-- ---------------------------------------------------------------------
do $$
declare
  v_a boolean;
  v_b boolean;
begin
  -- 1. instância A toma
  select hub.tomar_lease('teste-A', 60) into v_a;
  if not v_a then raise exception 'A deveria ter tomado a posse livre'; end if;

  -- 2. instância B NÃO toma enquanto A está válida
  select hub.tomar_lease('teste-B', 60) into v_b;
  if v_b then raise exception 'B tomou a posse de A ainda válida — a trava não funciona'; end if;

  -- 3. A renova sem problema
  select hub.tomar_lease('teste-A', 60) into v_a;
  if not v_a then raise exception 'A não conseguiu renovar a própria posse'; end if;

  -- 4. A libera, B assume
  perform hub.liberar_lease('teste-A');
  select hub.tomar_lease('teste-B', 60) into v_b;
  if not v_b then raise exception 'B não assumiu depois de A liberar'; end if;

  -- 5. posse vencida é tomável
  update hub.gateway_lease set expira_em = now() - interval '1 minute';
  select hub.tomar_lease('teste-C', 60) into v_a;
  if not v_a then raise exception 'C não tomou uma posse vencida'; end if;

  delete from hub.gateway_lease;
  raise notice '=== OK: posse do gateway exclusiva, renovável e liberável. ===';
end $$;

commit;
