# Plano — Central de Envio de Mensagens WhatsApp · Campanha Indiara

Data: 31/08/2026. Autor: sessão de engenharia.
Decisões do cliente que definem este plano (colhidas em 31/08):

| Decisão | Escolha |
| --- | --- |
| Rota de envio em massa | **Baileys com ritmo humano** (não Twilio/WABA) |
| Origem da lista | Arquivo **XLSX/CSV** |
| Prazo | **Curto — campanha em curso** |
| Escopo de IA | Personalização + resposta 1:1 + triagem + painel analítico |

---

## Estado da execução (01/09/2026)

| Fase | Estado | Onde está |
| --- | --- | --- |
| 0 — Descolar do cliente anterior | **feito** | commit `Fase 0` nos dois repos |
| 1 — Modelo de dados eleitoral | **feito** (migration escrita, **não aplicada**) | `supabase/migrations/20260831120000_campanha_eleitores.sql` |
| 2 — Importador XLSX/CSV | **feito** | `services/importador.ts`, `routes/importacao.ts`, `/eleitores` |
| 3 — Motor de disparo | **feito** | `services/ritmoDisparo.ts`, `jobs/disparador.ts`, `routes/disparos.ts`, `/disparos` |
| — Descadastro por resposta | **feito** | `services/optOut.ts` (buraco encontrado depois da Fase 3) |
| 4.1 — Personalização por IA | **feito** | `services/personalizacaoIA.ts` + trava de amostra |
| 4.2 — Resposta automática 1:1 | a fazer | precisa da base de conhecimento da campanha |
| 4.3 — Triagem de respostas | a fazer | adapta `services/analiseIA.ts` |
| 4.4 — Analista no painel | a fazer | adapta `services/aliceFoco.ts` |
| 5 — Painel da campanha | a fazer | adapta `_authenticated.painel.tsx` |
| 6 — Vocabulário e identidade | a fazer | renomeação mecânica, de uma vez |

**Nada foi aplicado nem publicado.** Não há projeto Supabase da campanha, não
há projeto GCP, não há linha de WhatsApp conectada. Tudo abaixo está
verificado por teste automatizado e por `tsc`, e nada foi verificado contra
um Postgres real ou um número real — ver "O que depende de decisão humana".

---

## 0. Ponto de partida — o que realmente está aqui

Os dois repositórios (`politica_envioIAWhatsapp_Back` e `_Front`) são uma
**cópia integral do Hub de WhatsApp da Agro Timbó**, com um único commit
("Initial commit") e todo o resto ainda fora do controle de versão. Isso é
bom: o que veio junto não é protótipo, é código endurecido por incidente
real de produção.

**O que já funciona e vamos reaproveitar:**

- Gateway Baileys multi-linha com reconexão no boot, vigia de canais a cada
  60s, graceful shutdown e backstop de `uncaughtException`
  (`src/channels/`, `src/jobs/vigiaCanais.ts`, `src/server.ts`).
- Recebimento completo: texto, mídia (bucket GCS + URL assinada),
  transcrição de áudio (Speech-to-Text chirp_2 pt-BR), grupos, resposta
  citada, identificação `@lid`.
- Motor de IA já em produção: `services/alice.ts` (analista conversacional,
  Opus 5 / Sonnet 5), `services/resumoIA.ts`, `services/analiseIA.ts`
  (sentimento/risco/CSAT), `services/avaliacao.ts`, `routes/coach.ts`.
- Front TanStack Start + shadcn com Caixa de mensagens em 3 colunas, Kanban,
  fila, painel com gráficos e configurações — `_authenticated.*.tsx`.
- Multi-tenant com RLS não permissiva e helpers `security definer`.
- Deploy Cloud Run endurecido (`deploy.sh`: `min=max=1`, `--no-cpu-throttling`
  — três flags que são pré-requisito de funcionamento, não otimização).

**O que NÃO existe e é justamente o coração desta plataforma:**

- Módulo de disparo. `hub.disparos` e `hub.disparo_alvos` existem no schema
  (`20260731000300_hub_operacao.sql`) mas **não há rota, serviço nem worker**
  — a Fase 8 do plano original nunca foi feita. `src/server.ts` documenta
  isso no próprio cabeçalho: "falta /disparos".
- Qualquer noção de eleitor, lista, segmento, consentimento ou opt-out.
- Importador de arquivo.

**O que está errado por ser cópia** — e é bloqueante:

- Aponta para o Supabase da Agro Timbó (`zfbjwhaltqewbluqfmtt`), que contém
  140 mil clientes com CPF e 2,3 milhões de registros de faturamento de
  **outro cliente**. O `cloudbuild.yaml` do front tem a chave anon desse
  projeto hardcoded como default de substituição.
- Aponta para o GCP `agrotimbo-agentsai` e para o serviço `hub-api`.
- Carrega as views de ponte com o ERP da Agro Timbó
  (`20260731000400_hub_views_erp.sql`), `whatsapp_devolucao_buffer`, seed de
  demonstração e 30+ arquivos em `supabase/migrations_pendentes/`.

---

## 1. Duas travas que esta decisão remove — registrado para não virar surpresa

### 1.1 Disparo por Baileys

O sistema tem hoje **duas camadas** que proíbem o que a campanha quer fazer:

- Código: `bloquearDisparoEmMassa()` em `src/channels/baileys.adapter.ts:654`.
- Banco: trigger `hub.impede_disparo_baileys`, escrito como *allowlist*
  (bloqueia tudo que não for `twilio`), com o comentário registrado no
  arquivo: "nunca disparo em massa por Baileys" é caro demais para depender
  de um `if`.

Seguir por Baileys exige remover as duas. **Não vamos deixar o schema sem
guarda-corpo** — a trava de transporte é substituída por três novas, de outra
natureza (§3.4): opt-out, consentimento e teto diário. O risco de ban do
número continua real: Baileys é cliente não oficial e volume atípico numa
linha nova é o gatilho clássico. Mitigações em §5.

**Contingência obrigatória antes do primeiro disparo:** número dedicado
(chip separado, nunca o número pessoal da candidata) e um segundo chip já
comprado e habilitado em espera. A base de eleitores e o histórico vivem no
Postgres — trocar de linha é escanear um QR novo, não recomeçar.

### 1.2 Procedência da lista

`hub.clientes` (eleitores) passa a ter colunas de base legal obrigatórias.
Regras inegociáveis no código:

- Toda mensagem enviada carrega identificação da campanha e instrução de
  descadastro.
- Pedido de descadastro (por palavra-chave OU detectado pela IA em linguagem
  natural) grava `opt_out_em` **antes** de qualquer outro processamento e é
  irreversível pela UI.
- Registro sem procedência declarada é importado como `bloqueado` e não entra
  em nenhuma lista de disparo.

---

## 2. Caminho mínimo até o primeiro disparo real

Dado o prazo curto, a ordem abaixo é deliberada: **as Fases 0→3 entregam um
disparo funcionando com substituição simples de campos** (`{{nome}}`,
`{{bairro}}`). A IA (Fase 4) entra na segunda onda, sem bloquear a primeira.

```
Fase 0  Descolar da Agro Timbó ........ ~1 dia     [bloqueante]
Fase 1  Modelo de dados eleitoral ..... ~1 dia     [bloqueante]
Fase 2  Importador XLSX/CSV ........... ~1-2 dias
Fase 3  Motor de disparo .............. ~2-3 dias   <-- primeiro envio real
-----------------------------------------------------
Fase 4  IA (4 frentes) ................ ~2-3 dias
Fase 5  Painel da campanha ............ ~1-2 dias
Fase 6  Vocabulário e rebranding ...... ~1 dia
```

---

## Fase 0 — Descolar da Agro Timbó  *(bloqueante)*

Nada pode ser ligado antes disto. Não é higiene, é isolamento de dados de
terceiro.

1. **Projeto Supabase novo e dedicado.** Não reusar `zfbjwhaltqewbluqfmtt`
   em hipótese nenhuma.
2. **Projeto GCP novo** (ou ao menos serviço, bucket e Secret Manager
   próprios). Ajustar `deploy.sh` (`SERVICO`), `cloudbuild.yaml` (`_IMAGE` e
   substituições) e os `.env`/`.env.example` dos dois repos.
3. **Baseline de schema consolidada.** As 30+ `migrations_pendentes` nunca
   foram aplicadas neste projeto — colapsar tudo numa migration única
   `00000000000000_baseline_campanha.sql`, já sem:
   - `20260731000400_hub_views_erp.sql` (views do ERP);
   - `whatsapp_devolucao_buffer`, `whatsapp_conversas_ativas`;
   - colunas de ponte: `empresas.cod_filial`, `clientes.cod_cliente`,
     `atendentes.cod_vendedor`;
   - `supabase/seed/` e `supabase/manual/` (diagnósticos de outro incidente).
4. **Manter o nome do schema `hub`.** Renomear para `campanha` tocaria
   centenas de linhas por ganho cosmético; o vocabulário do usuário muda na
   Fase 6, no front.
5. Reescrever `README.md`, `AGENTS.md`, `docs/*` herdados e o `name` dos dois
   `package.json`. Fazer o primeiro commit de verdade — hoje tudo está
   untracked.
6. Girar credenciais: a chave anon da Agro Timbó está versionada em
   `cloudbuild.yaml:24`. Ela sai daqui, e quem responde por aquele projeto
   deve saber que circulou.

**Saída:** `npm test` verde nos dois repos, `/health` respondendo no serviço
novo, banco novo com a baseline aplicada.

---

## Fase 1 — Modelo de dados eleitoral  *(bloqueante)*

Reaproveitar as tabelas existentes em vez de criar um modelo paralelo:
`conversas`, `mensagens`, `canais` e todo o RLS continuam valendo.

**Remapeamento conceitual (sem mexer em tabela):**

| Tabela existente | Passa a significar |
| --- | --- |
| `hub.empresas` | a campanha (uma linha: "Campanha Indiara") |
| `hub.setores` | frentes de trabalho (Mobilização, Demandas, Imprensa) |
| `hub.atendentes` | equipe de campanha (perfis operador/supervisor/admin servem) |
| `hub.clientes` | **eleitores** — estendida abaixo |
| `hub.conversas` | conversa 1:1 com o eleitor |

**Migration nova — estende `hub.clientes`:**

- `bairro text`
- `zona_eleitoral text`
- `tags text[] default '{}'` — pautas de interesse
- `origem text not null` — procedência declarada
- `base_legal text not null` — consentimento ou legítimo interesse
- `consentimento_em timestamptz`
- `opt_out_em timestamptz`, `opt_out_motivo text`
- `importacao_id uuid references hub.importacoes(id)`
- `situacao text not null default 'ativo'` — ativo, bloqueado ou opt_out

**Tabelas novas:**

- `hub.importacoes` — arquivo, hash, quem subiu, procedência declarada,
  linhas lidas/aceitas/rejeitadas, motivo agregado. Auditoria: precisa ser
  possível responder "de onde veio este telefone" sem consultar memória.
- `hub.listas` + `hub.lista_eleitores` — segmentos (por bairro, tag, origem).
- Ampliar `hub.disparos`: `lista_id`, `texto_base`, `janela_inicio`,
  `janela_fim`, `intervalo_min_seg`, `intervalo_max_seg`, `teto_diario`,
  `pausado_em`, `pausa_motivo`.
- Ampliar `hub.disparo_alvos`: `texto_gerado`, `tentativas`,
  `agendado_para`. O índice único `(disparo_id, telefone)` já existe e é a
  garantia de idempotência em restart — preservar.

**Guarda-corpos novos (substituem `impede_disparo_baileys`):**

- `impede_envio_opt_out` — trigger em `disparo_alvos` que recusa insert de
  eleitor com `opt_out_em` preenchido ou situação diferente de ativo.
- `impede_disparo_sem_base_legal` — recusa disparo cuja lista contenha
  registro sem base legal.
- Teto diário conferido no banco, não só no worker.

**Dívida técnica a resolver aqui:** `normalizarTelefone()` existe só em
TypeScript (`services/mensagens.ts`) — ver `docs/divida-tecnica.md`. O
importador precisa da mesma regra em SQL para deduplicar. Criar
`hub.normalizar_telefone()` e fazer o TS chamar via RPC: uma fonte só.

---

## Fase 2 — Importador XLSX/CSV

**Backend** — `src/routes/importacao.ts` + `src/services/importador.ts`:

1. Upload via `multer` (já é dependência) com teto de tamanho.
2. Parse com **`exceljs`** — nova dependência; lê XLSX e CSV, é mantida e não
   carrega o histórico de CVEs do SheetJS.
3. **Mapeamento de colunas devolvido para a UI.** O arquivo do cliente nunca
   vem com o cabeçalho que a gente quer — o backend devolve as colunas
   detectadas e a UI pede ao admin para casar cada uma (Nome, Telefone,
   Bairro…). Sem adivinhação silenciosa.
4. Normalização e validação por linha: dígitos, DDD válido, nono dígito de
   celular, prefixo 55. Linha inválida entra no relatório com o motivo, nunca
   é descartada em silêncio.
5. Dedupe contra a base e dentro do próprio arquivo.
6. **Prévia obrigatória antes de gravar:** X aceitos, Y duplicados, Z
   inválidos, W já em opt-out (esses nunca voltam). Só depois o commit.
7. Procedência e base legal são campos obrigatórios do formulário de
   importação, não opcionais.

**Front** — rota nova `/eleitores`:

- Upload → mapeamento → prévia → confirmação.
- Tabela de eleitores com busca e filtro por bairro, tag e situação.
- Histórico de importações com o relatório de cada uma.
- Botão de opt-out manual, para quem pedir por outro canal.

---

## Fase 3 — Motor de disparo com ritmo humano  *(o coração)*

`src/jobs/disparador.ts` + `src/routes/disparos.ts`.

O Cloud Run já roda `min=max=1` sem throttling de CPU por causa dos
WebSockets — ou seja, **há um processo único, permanente e com CPU alocada**.
É exatamente o ambiente que uma fila em processo precisa; não vale criar
worker separado agora.

### 3.1 Ciclo do worker

A cada tick, para cada disparo em `enviando`:

1. Está dentro da janela horária? Fora dela, dorme. Sem envio de madrugada —
   é o comportamento que mais gera denúncia e bloqueio.
2. O canal está conectado? Se não, **pausa o disparo sozinho** e registra o
   motivo (reaproveita `jobs/vigiaCanais.ts`).
3. Teto diário já batido? Dorme até o dia seguinte.
4. Pega **um** alvo pendente, com `for update skip locked`.
5. Envia `presenceUpdate('composing')` por um tempo proporcional ao tamanho
   do texto, depois `enviar()` pelo `ChannelPort`.
6. Grava `wa_message_id`, status e `enviado_em`; cria a `conversa` para que a
   resposta caia na Caixa como qualquer outra.
7. Dorme um intervalo aleatório entre o mínimo e o máximo configurados
   (padrão sugerido: 25 a 90 segundos).

### 3.2 Rampa de aquecimento

Linha nova não começa disparando. Teto por dia de vida do canal,
configurável, com default conservador:

```
dia 1: 40    dia 2: 80    dia 3: 150    dia 4: 250    dia 5+: 400
```

Isso não é truque para escapar de detecção — é a única forma de o número não
parecer, já no primeiro dia, exatamente o que um número banido parece.

### 3.3 Circuit breaker e kill switch

- Taxa de falha de envio acima do limiar numa janela curta → pausa automática
  e alerta no painel.
- Taxa de opt-out acima do limiar → pausa automática. Opt-out em massa é o
  sinal antecedente da denúncia; é o número que mais importa monitorar.
- **Botão único "Parar tudo"** no painel, que esvazia a fila de todos os
  disparos ativos. Precisa existir antes do primeiro envio, não depois.

### 3.4 Ordem de checagem antes de cada envio

```
opt-out → situação ativa → base legal → janela → canal ok
        → teto diário → já enviado? → envia
```

Idempotência: em restart do Cloud Run (todo deploy é um), o worker retoma
pelos alvos pendentes — o índice único garante que ninguém recebe duas vezes.

---

## Fase 4 — IA humanizada  *(4 frentes)*

### 4.1 Personalização do disparo — `services/personalizacao.ts`

- Gera a variação por eleitor a partir de um **texto-base aprovado pela
  candidata**, mais os dados do eleitor (nome, bairro, tags).
- **Pré-gerada antes de o disparo começar**, em lote (N eleitores por
  chamada), gravada em `disparo_alvos.texto_gerado`. Gerar durante o envio
  faria a latência da IA virar o intervalo entre mensagens — irregular e caro.
- **Guarda anti-invenção:** o prompt proíbe criar fato, número, data ou
  promessa que não esteja no texto-base, e um validador determinístico
  rejeita variação que introduza dígito, data ou verbo de compromisso ausente
  do original. Promessa de campanha inventada por IA é problema jurídico, não
  bug de qualidade.
- **Revisão humana obrigatória de amostra** (ex.: 20 variações) antes de o
  disparo sair de rascunho.
- Todo texto enviado fica gravado: é preciso poder responder exatamente o que
  foi dito a cada pessoa.

### 4.2 Resposta automática 1:1 — `services/agenteCampanha.ts`

- Reaproveita a arquitetura de `services/alice.ts`: contexto montado no
  servidor, nunca escolhido pelo texto de quem escreve.
- Base de conhecimento da campanha (propostas, biografia, agenda, perguntas
  frequentes) em `hub.base_conhecimento`, editável no front.
- **Sempre se identifica como assistente da campanha.** Isso protege a
  candidata; assistente que se passa por pessoa é o cenário que vira notícia.
- Escala para humano quando não sabe — cai na fila da Caixa, que já existe.
- **Detecção de descadastro em linguagem natural** ("para", "não quero mais",
  "me tira daí", "sai"): grava opt-out na hora, responde confirmando, não
  passa por humano nem por fila.

### 4.3 Triagem — adaptar `services/analiseIA.ts`

Classifica cada resposta em `apoiador`, `indeciso`, `contrario`,
`demanda_bairro`, `descadastro` ou `ofensa`. Grava em `conversas.etiquetas` e
`conversas.sentimento` (colunas já existem) e alimenta Kanban e painel. O
caso `ofensa` sai da automação e vai para revisão humana.

### 4.4 Alice adaptada ao contexto de campanha

`services/aliceFoco.ts` monta contexto de vendas (valor faturado, motivo de
perda, conversão). Trocar por: alcance por bairro, taxa de resposta, temas
mais citados, saldo apoiador/contrário, opt-outs. O gestor pergunta em
linguagem natural — a mecânica não muda, só o que entra no prompt.

---

## Fase 5 — Painel da campanha

Reaproveita `_authenticated.painel.tsx` inteiro; troca-se o que é medido:

- **Saúde da linha** (o semáforo já existe) — o indicador mais crítico agora.
- Progresso do disparo: enviados / entregues / lidos / respondidos.
- **Opt-outs, em destaque.** É a métrica que mede o dano à campanha e o
  gatilho do circuit breaker.
- Taxa de resposta por bairro, temas mais citados, saldo de triagem.
- Kanban (`_authenticated.chamados.tsx`) vira funil de mobilização:
  Novo contato → Respondeu → Interessado → Apoiador → Voluntário.

---

## Fase 6 — Vocabulário e rebranding

Renomeação mecânica, feita **de uma vez e por último**, para não conflitar
com o desenvolvimento das fases anteriores:

`cliente→eleitor · atendente→equipe · empresa→campanha · setor→frente ·
chamado→demanda · venda/valor→apoio · cotação→interesse`

Inclui identidade visual, favicon, título e textos da tela de login.

---

## 5. Riscos e contingências

| Risco | Probabilidade | Mitigação |
| --- | --- | --- |
| **Ban do número** | Alta | Chip dedicado + reserva já habilitado; rampa; janela; intervalo; circuit breaker. A base fica no Postgres — trocar de linha é reconectar um QR. |
| Opt-out e denúncia em massa | Média | Identificação clara, descadastro em uma palavra, pausa automática por limiar. |
| IA inventar promessa | Média | Prompt fechado + validador determinístico + revisão de amostra obrigatória. |
| Custo de IA | Média | Pré-geração em lote; Sonnet na personalização, Opus só no painel analítico; estimar custo por mil antes de liberar. |
| Prazo | Alta | Fases 0–3 entregam disparo com merge simples de campos; IA é segunda onda. |
| Queda do Cloud Run | Baixa | `deploy.sh` já cobre (`min=max=1`, sem throttling); o worker é idempotente. |

---

## 6. O que depende de decisão humana antes de começar

1. **Número de WhatsApp dedicado** — qual chip, e qual o reserva.
2. **Projeto Supabase e GCP novos** — quem cria, em qual conta.
3. **Procedência da lista XLSX/CSV** — de onde vieram os telefones. Define o
   preenchimento de `base_legal` e se cabe uma etapa prévia de captação de
   consentimento.
4. **Texto-base aprovado pela candidata** — a IA varia em cima dele, não o
   inventa.
5. **Base de conhecimento da campanha** — propostas, biografia, agenda, para
   a resposta 1:1.
6. **Limites operacionais** — janela horária, teto diário desejado e limiar
   de opt-out que pausa a campanha.
