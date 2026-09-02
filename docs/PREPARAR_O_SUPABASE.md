# Preparar o Supabase — passo a passo

Projeto alvo: **`Projetos_HAI`** (`juvcuodpttyuhqbhaptw`), East US (North
Virginia), plano Free.

**Este é o primeiro dos três provedores.** O Render precisa das chaves
daqui; o Cloudflare precisa da URL daqui. Faça este por inteiro antes.

---

## Antes: o que eu conferi neste projeto

Você escolheu um projeto que **já está em uso**. Inspecionei antes de
escrever qualquer passo, e o resultado é misto — bom no técnico, com uma
decisão sua pendente no resto.

### ✅ O que está seguro (verificado, não suposto)

O `Projetos_HAI` já tem **18 migrations aplicadas** (março e abril de 2026)
e um `public` cheio de outra aplicação — um CRM, com `deals`, `campanhas`,
`email_messages`, `demandas` e um `public.clientes` próprio.

Mesmo assim, subir a Central aqui **não quebra nada daquilo**:

| Verificação | Resultado |
| --- | --- |
| Nossas 31 migrations tocam o schema `public`? | **Nenhuma.** Tudo vive em `hub`. |
| `hub.clientes` colide com `public.clientes`? | Não — schemas diferentes. |
| `alter default privileges` afeta tabelas futuras do CRM? | Não — está escopado com `in schema hub`. |
| A ordem das migrations conflita? | Não — as nossas são de julho/agosto, as existentes de março/abril. |

### ⚠️ O que continua sendo decisão sua

**A chave `service_role` é do PROJETO, não do schema.** Não existe uma
chave que veja só o `hub`. Na prática:

- O backend da campanha vai carregar uma chave que lê e escreve **todo o
  CRM** — `deals`, `email_messages`, a base de clientes daquela aplicação.
- O backend do CRM já carrega uma chave que lê e escreve **o cadastro de
  eleitores** e o histórico de conversas da campanha.
- Uma chave vazada, de qualquer um dos dois lados, entrega os dois
  conjuntos de dados.

É a mesma classe de problema que a Fase 0 resolveu ao separar da Agro
Timbó — com a diferença de que ali eram dados de outro cliente, e aqui é
tudo seu.

**O plano é Free.** O seu próprio painel mostra *"No backups"*. Uma base de
eleitores e o histórico de mensagens de uma campanha, sem backup, é uma
perda que não tem desfazer. O Free também dá 1 GB de Storage, e mídia de
WhatsApp (foto, áudio, vídeo) é justamente o que cresce rápido.

**Minha recomendação:** projeto separado para a campanha, ou pelo menos
subir este para um plano com backup antes do primeiro disparo.

**Se preferir seguir com o `Projetos_HAI` assim mesmo, os passos abaixo
funcionam** — foram escritos para ele.

---

## Passo 1 — Já feito

O projeto existe, está `Healthy`, e a região **East US (North Virginia)** é
exatamente a que eu recomendaria: quando você criar o serviço no Render,
escolha `Ohio` ou `Virginia` e os dois ficam na mesma região.

Eu também já **vinculei o repositório** a ele:

```bash
supabase link --project-ref juvcuodpttyuhqbhaptw   # já executado
```

Confira com:

```bash
cd politica_envioIAWhatsapp_Back
supabase migration list
```

**Deu certo quando** você vê as 18 migrations do CRM na coluna `Remote` e
as nossas 31 só na coluna `Local`.

---

## Passo 2 — Copiar as credenciais

**Project Settings** (engrenagem) → **API**.

| O que | Vai para |
| --- | --- |
| **Project URL** — `https://juvcuodpttyuhqbhaptw.supabase.co` | Render **e** Cloudflare |
| **publishable / anon** key | Render **e** Cloudflare |
| **service_role** key (clicar em *Reveal*) | **só** Render |

> ### 🔴 Neste projeto, a `service_role` pesa mais
>
> Ela ignora todas as regras de acesso — e aqui isso inclui o CRM inteiro,
> não só a campanha. Ela vai **só** para as variáveis do Render. Nunca
> para o Cloudflare, nunca para o `.env` do front, nunca para um print.
>
> A **publishable** é o oposto: vai dentro do arquivo que todo navegador
> baixa, e sozinha não abre nada — quem barra é a RLS.

---

## Passo 3 — Aplicar as 31 migrations

```bash
cd politica_envioIAWhatsapp_Back
supabase db push
```

Ele lista as 31 e pede confirmação.

**Deu certo quando** aparece `Finished supabase db push.` e, no meio da
saída, várias linhas de `NOTICE` com `=== OK: ... ===`.

> ### Esses `NOTICE` não são enfeite
>
> Cada migration confere o próprio trabalho e aborta se algo estiver
> errado. Três exemplos do que provam:
>
> - `OK: normalizar_telefone bate nos 8 casos` — a regra de telefone do
>   banco concorda com a do código. Se divergissem, o mesmo eleitor
>   entraria duas vezes e receberia duas mensagens.
> - `OK: 1 trava de transporte trocada por 3 travas de consentimento` — os
>   guarda-corpos de opt-out, base legal e teto diário existem. Menos de
>   três reprova o push.
> - `OK: posse do gateway exclusiva` — a trava que impede duas instâncias
>   do backend disputarem a mesma linha de WhatsApp.
>
> **Se falhar, não force.** A mensagem diz qual migration e qual
> verificação reprovou. Me traga.

**Confira:** Table Editor → seletor de schema no topo → **`hub`**. Devem
aparecer `empresas`, `atendentes`, `clientes`, `conversas`, `mensagens`,
`disparos`, `disparo_alvos`, `importacoes`, `listas`, `gateway_lease` e
outras — todas vazias. O `public` continua exatamente como estava.

---

## Passo 4 — Criar a campanha e o primeiro admin

**Sem este passo você não entra na aplicação.** A tela de login não tem
cadastro: ela casa o usuário do Supabase Auth com uma linha de
`hub.atendentes`, pelo e-mail. Banco vazio = login que "funciona" e tela
vazia, sem erro que explique.

1. Abra `supabase/seed/bootstrap.sql` e troque os três valores do topo:

```sql
v_email_admin   text := 'humberto@hai.expert';
v_nome_admin    text := 'Humberto';
v_nome_campanha text := 'Campanha Indiara';
```

2. Copie o arquivo **inteiro**, cole no **SQL Editor** e **Run**.

**Deu certo quando** a tabela do resultado mostra a campanha, o seu nome,
`admin` e `empresas_vinculadas = 1`.

3. **Authentication** → **Users**.

> ### ⚠️ Aqui o Auth é compartilhado com o CRM
>
> Esta tela já tem os usuários da outra aplicação. Não apague ninguém.
>
> Se o seu e-mail **já estiver** na lista (por causa do CRM), **não crie
> outro** — o do Passo 4.2 já basta, e o vínculo acontece pelo e-mail.
>
> Se **não** estiver: **Add user** → **Create new user**, com o mesmo
> e-mail do SQL, e marque **Auto Confirm User**.
>
> Vale saber como isto se comporta: um usuário do CRM que entrar na
> Central recebe um token válido, mas **não vê nada** — sem linha em
> `hub.atendentes`, `meu_atendente_id()` devolve nulo e todas as consultas
> voltam vazias. Falha fechada, que é o comportamento certo. Mas é o
> motivo de o cadastro da equipe da campanha ter que ser explícito.

> **Se a senha for recusada com "weak password"**, ela consta em vazamento
> conhecido — o projeto tem essa proteção ligada. Escolha outra.

---

## Passo 5 — Criar o bucket de mídia

Guarda foto, áudio, vídeo e documento que chegam pelo WhatsApp.

1. **Storage**. Confira se já existe um bucket chamado `midia` (do CRM). Se
   existir, **não reaproveite** — crie `midia-campanha` e ajuste a variável
   `SUPABASE_BUCKET_MIDIA` no Render de acordo.
2. **New bucket** → Name: `midia` → **Public bucket: DESLIGADO**.

> ### 🔴 O interruptor mais importante desta página
>
> Bucket público = qualquer um que descubra o endereço de um arquivo o
> abre, sem login. São **fotos e áudios que eleitores mandaram para a
> campanha**.
>
> Deixe desligado. O backend gera um link assinado de 10 minutos toda vez
> que alguém da equipe abre uma mídia.

3. **Create bucket**.

**Deu certo quando** o bucket aparece **sem** a etiqueta `Public`.

> **Lembrete do plano Free:** 1 GB de Storage no total, dividido com o que
> o CRM já usa. Áudio de WhatsApp é pequeno; vídeo não é. Vale olhar o
> consumo depois do primeiro dia de conversa real.

---

## Passo 6 — Gerar os tipos para o front

```bash
supabase gen types --schema hub > ../politica_envioIAWhatsapp_Front/src/integrations/supabase/types.ts
```

O `--schema hub` importa: sem ele, os tipos do CRM inteiro entrariam no
código do front.

**Deu certo quando:**

```bash
grep -c "gateway_lease" ../politica_envioIAWhatsapp_Front/src/integrations/supabase/types.ts
```

devolve um número maior que zero — prova que o arquivo veio do banco, e do
schema certo.

---

## Passo 7 — Anotar para os próximos provedores

```
SUPABASE_URL=https://juvcuodpttyuhqbhaptw.supabase.co
SUPABASE_PUBLISHABLE_KEY=eyJ...        (publishable/anon)
SUPABASE_SERVICE_ROLE_KEY=eyJ...       (só no Render!)
SUPABASE_BUCKET_MIDIA=midia
```

---

## O que fica para DEPOIS do Cloudflare

**Authentication → URL Configuration → Redirect URLs**, acrescentar:

```
https://SEU-SITE.workers.dev
https://SEU-SITE.workers.dev/definir-senha
```

> ⚠️ Essa configuração é **do projeto inteiro**. Você está acrescentando à
> lista que o CRM já usa — **não remova o que estiver lá**, ou o login da
> outra aplicação para de funcionar.

Sem isso, o link de definir senha da equipe é recusado, e **o erro não
explica o motivo**.

---

## Problemas comuns

**`db push` diz "Found local migration files to be inserted before the last migration"**
Alguma migration nossa ficou com data anterior à última do CRM. Não use
`--include-all` sem entender: me traga a mensagem.

**Entro e a tela fica vazia, sem erro**
Passo 4 faltando, ou e-mail diferente. O e-mail em `hub.atendentes` tem que
ser **idêntico** ao de Authentication → Users.

**"Invalid login credentials"**
O usuário não existe no Auth, ou a senha está errada. A linha em
`hub.atendentes` sozinha não cria login — são os dois.

**Quero desfazer tudo que subimos neste projeto**
`drop schema hub cascade;` no SQL Editor remove a Central inteira sem tocar
no CRM. É a vantagem prática de tudo viver num schema só. **Confira duas
vezes antes** — leva junto eleitores, conversas e disparos.

---

## Próximo passo

**Parte 2** de
[`DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md`](DEPLOY_CLOUDFLARE_RENDER_SUPABASE.md)
— o backend no Render, na região `Ohio` ou `Virginia` para casar com este
projeto. Depois, o
[guia do Cloudflare](../../politica_envioIAWhatsapp_Front/docs/PUBLICAR_NO_CLOUDFLARE.md).
