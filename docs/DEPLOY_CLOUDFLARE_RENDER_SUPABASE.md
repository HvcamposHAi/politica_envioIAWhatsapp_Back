# Deploy — Cloudflare (front) · Render (backend) · Supabase (banco)

Runbook de execução. Substitui o alvo herdado (Cloud Run + GCS + Secret
Manager + Speech-to-Text), que ainda está escrito em `deploy.sh` e
`cloudbuild.yaml`.

**Estado:** o que está marcado como *verificado* foi rodado nesta máquina.
O resto são passos de console de provedor, que ninguém consegue verificar
sem as contas criadas.

---

## Resumo do que muda

| Peça | Antes (herdado) | Agora | Precisa mexer no código? |
| --- | --- | --- | --- |
| Front | Container Node no Cloud Run | Cloudflare Workers | **sim** — 1 linha |
| Backend | Container no Cloud Run | Render (Docker) | **sim** — trava de instância |
| Banco | Supabase | Supabase | não |
| Mídia (foto, áudio, doc) | Google Cloud Storage | Supabase Storage | **sim** — 1 arquivo |
| Transcrição de áudio | Google Speech-to-Text | *desativada* | não (desliga sozinha) |
| Segredos | GCP Secret Manager | Variáveis do Render | não (já tem fallback) |
| Conexão direta ao Postgres | — | — | **nenhuma** (ver §0.5) |

---

## Parte 0 — Mudanças de código  ✅ FEITAS EM 01/09/2026

> **Esta parte já está aplicada e commitada.** Ficou escrita porque explica
> *por que* cada peça é como é — o próximo a mexer precisa disso. Quem só
> vai provisionar pode pular direto para a Parte 1.
>
> | | Item | Estado |
> | --- | --- | --- |
> | 0.1 | Preset do Nitro → `cloudflare-module` | feito, build verificado |
> | 0.2 | Mídia → Supabase Storage | feito, `midiaStorage.ts` reescrito |
> | 0.3 | Posse do gateway | feito, migration + `jobs/lease.ts` + 14 testes |
> | 0.4 | Transcrição | fechada por duas condições, não uma |
> | 0.5 | `DATABASE_URL` removida do `.env.example` | feito |
> | 0.6 | `deploy.sh` e `cloudbuild.yaml` → `render.yaml` | feito, apagados |
>
> Verificado: 606 testes no backend, 218 no front, `tsc` limpo, os dois
> builds passando. **Nada aplicado em banco nem publicado.**

### 0.1 Front: preset do Nitro *(verificado)*

Em [`vite.config.ts`](../../politica_envioIAWhatsapp_Front/vite.config.ts),
uma linha:

```diff
-        preset: "node-server",
+        preset: "cloudflare-module",
```

Verificado nesta máquina: `bun run build` passa, gera
`.output/server/wrangler.json` com `nodejs_compat` e o binding de assets já
preenchidos. Não precisa escrever `wrangler.toml` à mão.

Dois detalhes reais do build:

- O nome do Worker é gerado a partir do remote do git
  (`hvcamposhai-politica-envioiawhatsapp-front`). Trocar por algo decente
  em `nitro.cloudflare.wrangler.name` no `vite.config.ts`.
- Rodando no Windows, o `wrangler.json` gerado sai com `"directory": "..\\public"`
  (barra invertida). O build do Cloudflare roda em Linux e gera `../public`
  correto — só não deploye a partir do Windows com o arquivo gerado
  localmente.

> **Nitro 3 beta:** o preset válido é `cloudflare-module`. `cloudflare`
> (sem sufixo) falha com *"Nitro entry is missing"* — confirmado tentando.

### 0.2 Backend: armazenamento de mídia → Supabase Storage

`services/midiaStorage.ts` é o **único** módulo que fala com o Google Cloud
Storage. Ele exporta 7 funções (`subirBuffer`, `subirStream`, `urlAssinada`,
`baixarBuffer`, `apagar`, `montarCaminho`, `midiaConfigurada`) consumidas em
6 lugares. Reescrever esse arquivo contra `supabase.storage`, mantendo a
mesma assinatura, resolve todos os 6 de uma vez.

O mapeamento é quase um-para-um:

| Hoje (GCS) | Supabase Storage |
| --- | --- |
| `bucket.file(p).save(buffer)` | `storage.from(bucket).upload(p, buffer)` |
| `getSignedUrl({action:'read', expires})` | `createSignedUrl(p, ttlSegundos)` |
| `bucket.file(p).download()` | `storage.from(bucket).download(p)` |
| `bucket.file(p).delete()` | `storage.from(bucket).remove([p])` |

`uriGs()` some: era só para a transcrição (§0.4), que fica desligada.

Ganho colateral: acaba a exigência de `iam.serviceAccountTokenCreator` sobre
a própria service account — a pegadinha que fazia `urlAssinada()` explodir em
runtime com *"Cannot sign data without client_email"*.

### 0.3 Backend: trava de instância única *(o item mais sério)*

**O problema.** Render faz deploy sem downtime: a instância nova sobe e passa
no health check **antes** de a velha receber SIGTERM. Durante essa janela há
dois processos, e cada um roda `reconectarCanaisAoSubir()` nos mesmos canais.
Duas sessões Baileys na mesma identidade se derrubam mutuamente — o WhatsApp
manda `440 connectionReplaced` e as duas entram em duelo de reconexão.

Não é hipótese: é exatamente o incidente que o `deploy.sh` do Cloud Run
documenta, e o motivo de `--max-instances=1` existir lá. No Render, `1
instância` não resolve sozinho, porque a sobreposição acontece **dentro** do
deploy.

**A solução: lease no banco.** Uma linha em `hub.gateway_lease` com o id da
instância e um `expira_em`; quem segura a lease renova a cada 15s, e só o
dono chama `reconectarCanaisAoSubir()`. A instância velha para de renovar no
SIGTERM; a nova assume quando a lease vence.

> Advisory lock do Postgres (`pg_try_advisory_lock`) seria o instrumento
> natural, mas **não serve aqui**: ele é preso à sessão de conexão, e este
> backend não abre conexão direta com o Postgres — tudo vai por PostgREST
> (§0.5), onde cada chamada é uma conexão diferente. A lease em tabela
> funciona sobre PostgREST e não acrescenta dependência.

Custo: uma migration curta + ~40 linhas em `channels/registry.ts`.

### 0.4 Transcrição de áudio: some sozinha

`transcricaoAtiva()` já devolve `false` sem `GCP_PROJECT_ID`
(`services/transcricaoAudio.ts:41`). Sem GCP, a transcrição desliga e o
player de áudio continua funcionando — a mensagem fica gravada com o motivo
na tela, não como texto vazio. **Nenhuma mudança de código.**

O que se perde: o texto do áudio deixa de alimentar o resumo e a análise de
IA. Para uma campanha, onde a maior parte da resposta é texto curto, é uma
perda pequena. Se virar problema, o caminho é um provedor de transcrição por
API (não é gratuito e não está neste plano).

### 0.5 `DATABASE_URL` não é usado — tire do `.env.example`

Conferido por busca: **nenhum arquivo em `src/` lê `DATABASE_URL`.** O
`.env.example` afirma que o "worker Baileys" precisa de conexão direta, e
isso é falso — `channels/auth-state.postgres.ts` grava em
`hub.canal_sessoes` pelo `supabaseAdmin`, ou seja, PostgREST sobre HTTPS.

Duas consequências boas:

- **O problema clássico de Render + Supabase não existe aqui.** Não há
  conexão direta ao Postgres, então não há IPv6 inalcançável nem escolha
  entre pooler em modo transação e modo sessão.
- Uma variável a menos para configurar errado. Remover a linha do
  `.env.example` evita alguém perder uma hora com ela.

### 0.6 Arquivos que ficam obsoletos

`deploy.sh` (gcloud) e `cloudbuild.yaml` (Cloud Build) não servem mais.
Trocar por um `render.yaml` no backend. **Não apague o cabeçalho de
`deploy.sh` sem ler**: ele explica por que o serviço precisa de instância
única, sem throttling de CPU e sempre acordada — as três razões continuam
valendo no Render, com nomes diferentes.

---

## Parte 1 — Supabase

1. **Criar o projeto** dedicado à campanha. Não reaproveitar nenhum outro:
   este backend roda com `service_role`, que ignora RLS e lê tudo.

2. **Região.** Escolher pensando em onde o Render vai ficar (§2.1), não só
   na proximidade com o eleitor. Toda leitura do backend é uma chamada
   HTTPS; banco e backend em continentes diferentes somam latência em cada
   uma delas. Se o Render ficar no leste dos EUA, o Supabase ali também.

3. **Aplicar as migrations** — 30 arquivos, sequência linear em banco vazio:

   ```bash
   cd politica_envioIAWhatsapp_Back
   supabase link --project-ref <ref-do-projeto>
   supabase db push
   ```

   Cada migration tem bloco de autovalidação: se `db push` terminar sem
   `raise exception`, o schema está como devia. A da Fase 1 falha de
   propósito se sobrarem menos de três guarda-corpos de consentimento.

   > `supabase/rollback/` **não** é aplicado pelo `db push` (o CLI só lê
   > `migrations/`), e não foi revisado para esta plataforma. Ver o README
   > daquela pasta.

4. **Bucket de mídia** (depois de §0.2): criar um bucket **privado**
   (ex.: `midia`). Privado é requisito, não preferência — são fotos e áudios
   de conversas de eleitores. O acesso do front é por URL assinada de curta
   duração, gerada pelo backend.

5. **Auth → URL Configuration:** cadastrar a URL do front (§3) e
   `<url-do-front>/definir-senha` em *Redirect URLs*. Sem isso o link de
   convite é rejeitado, e o erro não diz por quê.

6. **Guardar as três credenciais:** `SUPABASE_URL`, a chave *publishable*
   (anon) e a `service_role`. A `service_role` vai **só** para o Render,
   nunca para o Cloudflare.

7. **Gerar os tipos** e commitar no front — é o item de aceite da Fase 1
   registrado em `docs/divida-tecnica.md`:

   ```bash
   supabase gen types --schema hub > ../politica_envioIAWhatsapp_Front/src/integrations/supabase/types.ts
   ```

---

## Parte 2 — Render (backend)

### 2.1 Criar o serviço

- **Tipo:** Web Service, a partir do repositório `politica_envioIAWhatsapp_Back`.
- **Runtime: Docker.** O `Dockerfile` já instala `ffmpeg`, que **não é
  opcional**: sem ele a nota de voz gravada no navegador (webm/opus) não é
  convertida, o Hub diz "enviado", e boa parte dos Androids do outro lado
  mostra um anexo que não toca. Runtime Node nativo do Render não tem ffmpeg.
- **Região:** o Render não oferece região no Brasil (confira a lista atual
  no console). A mais próxima é o leste dos EUA. Combine com a região do
  Supabase (§1.2).
- **Health check path:** `/health`.
- **Instâncias:** 1. Autoscaling **desligado**.

### 2.2 Plano: não pode ser o gratuito

O plano gratuito do Render suspende o serviço por inatividade. Este serviço
segura WebSockets do WhatsApp em memória: suspender é derrubar todas as
linhas, e ninguém percebe até o eleitor não receber resposta. É a mesma
razão do `--min-instances=1` no Cloud Run. **Instância paga, sempre
acordada.**

### 2.3 Disco persistente: não precisa

As credenciais da sessão Baileys ficam em `hub.canal_sessoes`, no Postgres —
não em disco. Um restart do Render não pede QR novo.

### 2.4 Variáveis de ambiente

Do `.env.example`, **menos** as de GCP. O mínimo para subir:

```
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
SUPABASE_BUCKET_MIDIA=midia
MIDIA_TAMANHO_MAX_MB=16
MIDIA_URL_TTL_SEGUNDOS=600
MIDIA_CONCORRENCIA=2
DISPARO_JANELA_INICIO=09:00
DISPARO_JANELA_FIM=20:00
DISPARO_INTERVALO_MIN_SEG=25
DISPARO_INTERVALO_MAX_SEG=90
DISPARO_RAMPA=40,80,150,250,400
DISPARO_LIMIAR_FALHA_PCT=15
DISPARO_LIMIAR_OPTOUT_PCT=5
DISPARO_ATIVO=true
CORS_ORIGIN=<url do front>
APP_BASE_URL=<url do front>
```

**Não definir `GCP_PROJECT_ID`.** A presença dela liga o caminho do Secret
Manager em `services/twilioCredenciais.ts` e desliga a leitura por variável
de ambiente. Ausente é o modo certo aqui.

`PORT`: o Render injeta. O default 8081 do código só vale fora dele.

**Suba com `DISPARO_ATIVO=false` no primeiro deploy.** O worker roda e não
faz nada; ligar depois de conferir a linha conectada é mais barato que
descobrir um problema com mensagem já saindo.

### 2.5 Deploy

Deploy automático pelo branch é conveniente, mas lembre da janela de
sobreposição da §0.3: **enquanto a lease não existir, todo deploy é um
risco de duelo de sessão.** Até lá, prefira deploy manual em horário de
baixo movimento, e confira no log se as linhas voltaram.

---

## Parte 3 — Cloudflare (front)

1. **Workers**, não Pages: o front tem SSR, e o preset `cloudflare-module`
   produz um Worker (o `wrangler.json` gerado tem `main` e o binding
   `ASSETS`).

2. **Build:**
   - Comando: `bun install && bun run build`
   - Configuração do Wrangler: `.output/server/wrangler.json` (gerado pelo
     build — não versionar um `wrangler.toml` à mão).

3. **As variáveis `VITE_*` são de BUILD, não de runtime.** O Vite injeta
   `import.meta.env` no bundle na hora do build. Colocá-las como variável de
   runtime do Worker não tem efeito nenhum — o app sobe com elas vazias e
   falha com *"VITE_API_URL não configurada"*. Cadastre em **variáveis de
   build**:

   ```
   VITE_SUPABASE_URL=
   VITE_SUPABASE_PUBLISHABLE_KEY=
   VITE_API_URL=<url do backend no Render>
   ```

4. **Só a chave publishable.** Ela vai embutida no bundle e é visível no
   DevTools de qualquer pessoa — é pública por natureza. A `service_role`
   nunca entra aqui, em nenhuma circunstância.

5. **Domínio próprio**, se houver. A URL definitiva é o que fecha o §4.

---

## Parte 4 — Amarrar as pontas

Ordem importa: cada item precisa da URL definida no anterior.

1. Front no ar → anote a URL final.
2. No **Render**: `CORS_ORIGIN` e `APP_BASE_URL` = URL do front. Sem o
   primeiro, toda chamada do navegador morre em CORS; sem o segundo, o link
   de convite aponta para `localhost:8080`.
3. No **Supabase → Auth → URL Configuration**: a URL do front e
   `<url>/definir-senha` em *Redirect URLs*.
4. No **Cloudflare**: `VITE_API_URL` = URL do backend no Render, e
   **rebuild** — é build-time, mudar a variável sem rebuildar não faz nada.

---

## Parte 5 — Verificação, na ordem

```bash
# 1. Backend de pé
curl https://<backend>.onrender.com/health          # 200

# 2. Sem credencial não passa (a barreira é o JWT, não o CORS)
curl https://<backend>.onrender.com/disparos        # 401

# 3. Front carrega e o login funciona
#    (se travar em "weak_password", a senha consta em vazamento conhecido —
#     o projeto tem HIBP ligado. Confira em api.pwnedpasswords.com antes.)

# 4. Conectar a linha: Configurações › Canais › ler o QR
#    O QR chega por Realtime, não por poll — se não aparecer, o problema é
#    Realtime, não o Baileys.

# 5. Mandar uma mensagem de teste PARA a linha, de outro celular.
#    Ela tem que aparecer na Caixa em segundos.

# 6. Responder "SAIR" desse mesmo celular.
#    Tem que voltar a confirmação de descadastro, e o contato tem que
#    ficar como "Descadastrado" em /eleitores. Este é o teste que prova a
#    obrigação legal funcionando ponta a ponta — faça antes do primeiro
#    disparo, não depois.

# 7. Só então: DISPARO_ATIVO=true, e um disparo de 5 alvos para números
#    da própria equipe.
```

---

## Parte 6 — O que fica pior nesta stack

Honestidade sobre trocas, não recuo do plano:

| Item | Efeito |
| --- | --- |
| **Latência do banco** | Sem região no Brasil no Render, cada chamada PostgREST atravessa o continente. A Caixa continua usável; o painel com muitas consultas fica perceptivelmente mais lento. |
| **Transcrição de áudio** | Desligada. Áudio toca, mas não vira texto para o resumo nem para a triagem. |
| **Janela de deploy** | Até a lease da §0.3 existir, todo deploy tem risco de duelo de sessão. No Cloud Run isso era resolvido por configuração; aqui é código. |
| **Segredos** | Variáveis do Render em vez de Secret Manager. Não é pior em segurança prática, mas some a rotação de versão de segredo e a tela de admin que salvava a credencial Twilio (`POST /configuracoes/twilio` passa a responder que não há Secret Manager configurado — comportamento já previsto no código). |

O que **melhora**: some a exigência de IAM sobre a própria service account
para assinar URL, some o Artifact Registry, e o deploy do front deixa de ser
um build de container para virar um build estático + Worker — mais rápido e
mais barato.

---

## Ordem de execução recomendada

```
0.1 preset do Nitro  ─┐
0.2 Supabase Storage  ├─ código, ~meio dia
0.3 lease de instância┤
0.5 limpar .env.example ┘
        ↓
1. Supabase (projeto, migrations, bucket, tipos)
        ↓
2. Render (Docker, plano pago, DISPARO_ATIVO=false)
        ↓
3. Cloudflare (Workers, variáveis de BUILD)
        ↓
4. amarrar CORS / redirect / VITE_API_URL + rebuild
        ↓
5. verificação, terminando no teste de "SAIR"
        ↓
   DISPARO_ATIVO=true
```

Os gates humanos do plano continuam valendo e não são resolvidos por
nenhum provedor: chip dedicado + reserva, procedência da lista, texto-base
aprovado, base de conhecimento e os limites operacionais. Ver
`PLANO_CAMPANHA_INDIARA.md` §6.
