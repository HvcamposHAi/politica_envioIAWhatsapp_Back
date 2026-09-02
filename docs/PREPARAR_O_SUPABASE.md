# Preparar o Supabase — passo a passo

Guia literal. Cada passo diz o que clicar, o que vai aparecer e como saber
se deu certo.

**Este é o primeiro dos três provedores.** Nada mais funciona sem ele: o
backend no Render precisa das chaves daqui, e o front no Cloudflare precisa
da URL daqui. Faça este por inteiro antes de abrir o Render.

Tempo: cerca de 40 minutos, quase tudo esperando o banco provisionar.

---

## Passo 1 — Criar o projeto

1. Entrar em <https://supabase.com/dashboard>.
2. **New project**.
3. Preencher:

| Campo | O que pôr |
| --- | --- |
| Name | `central-indiara` |
| Database Password | **Gere uma senha forte e guarde.** Você não vai usá-la no dia a dia, mas ela não pode ser recuperada depois — só resetada. |
| Region | **Leia o aviso abaixo antes de escolher.** |

> ### ⚠️ A região é a decisão que não dá para desfazer
>
> Mudar a região depois significa criar outro projeto e migrar tudo.
>
> O **Render não tem região no Brasil**. Então existem duas escolhas
> coerentes, e uma incoerente:
>
> | Escolha | Efeito |
> | --- | --- |
> | Supabase e Render **ambos** no leste dos EUA | ✅ recomendado — as consultas ficam na mesma região |
> | Supabase em São Paulo, Render nos EUA | ❌ cada consulta atravessa o continente, e o backend faz muitas |
> | Supabase e Render ambos em outra região igual | ✅ também serve |
>
> A intuição engana aqui: o eleitor **não fala com o Supabase**. Quem fala
> é o backend, o tempo todo. Aproximar o banco do Brasil e deixar o backend
> nos EUA piora tudo.
>
> **Recomendo `East US (North Virginia)`** e o Render em `Ohio` ou
> `Virginia`.

4. **Create new project** e espere. Leva de 2 a 5 minutos.

**Deu certo quando:** o painel do projeto abre e não há mais a faixa
"Setting up project".

---

## Passo 2 — Copiar as credenciais

No painel: **Project Settings** (engrenagem) → **API**.

Copie três coisas para um bloco de notas:

| O que | Onde está | Vai para |
| --- | --- | --- |
| **Project URL** | topo da página, `https://xxxx.supabase.co` | Render **e** Cloudflare |
| **publishable / anon** key | seção *Project API keys* | Render **e** Cloudflare |
| **service_role** key | mesma seção, precisa clicar em *Reveal* | **só** Render |

> ### 🔴 A `service_role` é a chave que abre tudo
>
> Ela **ignora todas as regras de acesso do banco**. Quem a tiver lê e
> apaga o cadastro inteiro de eleitores, de qualquer lugar do mundo.
>
> - Vai **só** para as variáveis do Render.
> - **Nunca** para o Cloudflare, nunca para o `.env` do front, nunca para o
>   navegador, nunca para um print em grupo de WhatsApp.
> - Se ela vazar: mesma tela, botão de gerar nova chave. Faça isso na hora.
>
> A **publishable** é o oposto: ela é pública por natureza, vai dentro do
> arquivo que todo navegador baixa, e sozinha não dá acesso a nada — quem
> barra é a RLS.

Anote também o **Project ref** (o `xxxx` da URL). Você precisa dele no
Passo 4.

---

## Passo 3 — Instalar o CLI do Supabase

No seu computador:

```bash
npm install -g supabase
supabase --version
```

**Deu certo quando** o comando devolve um número de versão.

Agora entre na sua conta:

```bash
supabase login
```

Abre o navegador, você autoriza, volta ao terminal.

---

## Passo 4 — Aplicar as 31 migrations

É o passo que cria todas as tabelas. Na pasta do backend:

```bash
cd politica_envioIAWhatsapp_Back
supabase link --project-ref SEU-PROJECT-REF
supabase db push
```

Ele vai listar as 31 migrations e pedir confirmação. Confirme.

**Deu certo quando** aparece `Finished supabase db push.` e, no meio da
saída, várias linhas de `NOTICE` dizendo `=== OK: ... ===`.

> ### Esses `NOTICE` não são enfeite
>
> Cada migration termina com um bloco que **confere o próprio trabalho** e
> aborta se algo estiver errado. Alguns exemplos do que eles provam:
>
> - `OK: normalizar_telefone bate nos 8 casos` — a regra de telefone do
>   banco concorda com a do código. Se divergissem, o mesmo eleitor entraria
>   duas vezes e receberia duas mensagens.
> - `OK: 1 trava de transporte trocada por 3 travas de consentimento` — os
>   guarda-corpos de opt-out, base legal e teto diário existem. Se sobrasse
>   menos de três, o push falha.
> - `OK: posse do gateway exclusiva, renovável e liberável` — a trava que
>   impede duas instâncias do backend disputarem a mesma linha de WhatsApp.
>
> **Se o `db push` falhar, não tente forçar.** A mensagem de erro diz qual
> migration e qual verificação reprovou. Me traga a mensagem.

**Confira no painel:** Table Editor → seletor de schema no topo → escolher
**`hub`**. Você deve ver `empresas`, `atendentes`, `clientes`, `conversas`,
`mensagens`, `disparos`, `disparo_alvos`, `importacoes`, `listas`,
`gateway_lease` e outras. Todas vazias.

---

## Passo 5 — Criar a campanha e o primeiro admin

**Sem este passo você não consegue entrar na aplicação.** A tela de login
não tem cadastro: ela casa o usuário do Supabase Auth com uma linha da
tabela `atendentes`, pelo e-mail. Banco vazio = login que "funciona" e uma
tela vazia, sem erro que explique o motivo.

1. Abra `supabase/seed/bootstrap.sql` num editor.
2. Troque os três valores no topo:

```sql
v_email_admin   text := 'seu@email.com';
v_nome_admin    text := 'Seu Nome';
v_nome_campanha text := 'Campanha Indiara';
```

3. Copie o arquivo **inteiro**, cole no **SQL Editor** do Supabase e clique
   em **Run**.

**Deu certo quando** a última tabela do resultado mostra uma linha com a
campanha, o seu nome, `admin` e `empresas_vinculadas = 1`.

4. Agora crie o usuário de verdade: **Authentication** → **Users** →
   **Add user** → **Create new user**.
   - E-mail: **o mesmo** que você pôs no SQL.
   - Senha: escolha uma.
   - Marque **Auto Confirm User** — sem isso o Supabase espera uma
     confirmação por e-mail que ainda não está configurada.

> **Se a senha for recusada com "weak password"**, ela consta em vazamento
> conhecido. O projeto tem essa proteção ligada. Escolha outra — e não é
> frescura: senha vazada num sistema que guarda o cadastro de eleitores é o
> caminho mais curto para o problema.

---

## Passo 6 — Criar o bucket de mídia

Guarda foto, áudio, vídeo e documento que chegam pelo WhatsApp.

1. **Storage** → **New bucket**.
2. Name: `midia`
3. **Public bucket: DESLIGADO.**

> ### 🔴 Este é o interruptor mais importante desta página
>
> Bucket público significa: qualquer pessoa que descubra o endereço de um
> arquivo o abre, sem login. Estamos falando de **fotos e áudios que
> eleitores mandaram para a campanha**.
>
> Deixe desligado. O backend gera um link assinado que vale 10 minutos toda
> vez que alguém da equipe abre uma mídia.
>
> Se errar: dá para trocar depois em Storage → o bucket → Settings. Mas
> confira agora, é mais barato.

4. **Create bucket**.

**Deu certo quando** o bucket `midia` aparece na lista **sem** a etiqueta
`Public`.

---

## Passo 7 — Gerar os tipos para o front

Um comando, na pasta do backend:

```bash
supabase gen types --schema hub > ../politica_envioIAWhatsapp_Front/src/integrations/supabase/types.ts
```

Isso substitui um arquivo que hoje ainda descreve o schema antigo (está
registrado em `docs/divida-tecnica.md` como pendência).

**Deu certo quando:**

```bash
grep -c "gateway_lease" ../politica_envioIAWhatsapp_Front/src/integrations/supabase/types.ts
```

devolve um número maior que zero — prova que o arquivo veio do banco novo.

---

## Passo 8 — Deixar anotado para os próximos provedores

Guarde este bloco. Você vai colar pedaço dele no Render e no Cloudflare:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_PUBLISHABLE_KEY=eyJ...        (a publishable/anon)
SUPABASE_SERVICE_ROLE_KEY=eyJ...       (só no Render!)
SUPABASE_BUCKET_MIDIA=midia
```

---

## O que fica para DEPOIS do Cloudflare

Um item só, e não dá para fazer antes porque depende do endereço do site:

**Authentication → URL Configuration → Redirect URLs**, adicionar:

```
https://SEU-SITE.workers.dev
https://SEU-SITE.workers.dev/definir-senha
```

Sem isso, o link de definir senha que a equipe recebe é recusado — e **o
erro não explica o motivo**. Está no Passo 7 do guia do Cloudflare.

---

## Problemas comuns

**`supabase link` pede senha do banco**
É a que você gerou no Passo 1. Se perdeu: Project Settings → Database →
*Reset database password*.

**`db push` diz "Found local migration files to be inserted before the last migration"**
O banco não está vazio — alguém já aplicou algo. Não force. Me traga a
mensagem.

**Entro na aplicação e a tela fica vazia, sem erro**
É o Passo 5 faltando ou com e-mail diferente. Confira que o e-mail em
`hub.atendentes` é **exatamente** o mesmo de Authentication → Users.

**"Invalid login credentials"**
O usuário não existe em Authentication → Users, ou a senha está errada. A
linha em `hub.atendentes` sozinha não cria o login — são os dois.

---

## Próximo passo

Com o Supabase pronto, siga para a **Parte 2** de
[`DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md`](DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md)
— o backend no Render. Depois dele, o
[guia do Cloudflare](../../politica_envioIAWhatsapp_Front/docs/PUBLICAR_NO_CLOUDFLARE.md).
