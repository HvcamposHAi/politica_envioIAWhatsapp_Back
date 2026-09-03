# Subir o backend no Render — passo a passo

Guia literal. Segundo dos três provedores: o Supabase já tem que estar
pronto, e o Cloudflare vem depois daqui.

**Plano escolhido: gratuito.** Leia o quadro abaixo antes de começar — ele
muda o que você pode esperar do sistema, não só o preço.

---

## ⚠️ O que o plano gratuito faz com ESTE serviço

O `free` do Render suspende o serviço depois de **~15 minutos sem
requisição HTTP**. Num site comum isso é invisível: chega visita, ele
acorda. Aqui não, porque este serviço não é um site.

| O que quebra | Por quê |
| --- | --- |
| As linhas de WhatsApp caem | Os sockets vivem na memória do processo. Suspender = desconectar todas. |
| Nada acorda sozinho | Ele volta com uma requisição **HTTP**. Mensagem de WhatsApp que chega **não é uma** — é um WebSocket que o próprio processo abre. A linha fica fora do ar até alguém abrir o painel. |
| O disparo para no meio | O worker é um `setInterval`. Processo suspenso, campanha parada, sem aviso. |

**Resumo honesto:** no gratuito o sistema funciona enquanto alguém está com
a aba aberta, e para poucos minutos depois de fechar.

### Por que então seguir no gratuito agora

Porque é **suficiente para o que vem em seguida**: subir, conferir a rota
de saúde, fazer login, ler o QR e mandar uma mensagem de teste — tudo com
você olhando a tela.

### O gatilho para trocar, para não virar decisão esquecida

Passe para o plano pago **antes** de qualquer uma destas duas:

- deixar a linha conectada esperando eleitor fora do seu horário;
- ligar `DISPARO_ATIVO=true`.

> **Sobre o truque do pinger:** dá para manter acordado com um monitor
> externo batendo em `/health` a cada 10 minutos. Funciona. Mas o gratuito
> dá **750 horas-instância por mês na conta inteira**, e manter um serviço
> 24/7 consome ~730. Se você já tem outros serviços gratuitos nessa conta,
> a conta não fecha e o serviço é suspenso do mesmo jeito — só que de um
> jeito mais difícil de diagnosticar.

---

## O que você precisa em mãos

Do Supabase (Project Settings → API):

```
SUPABASE_URL=https://juvcuodpttyuhqbhaptw.supabase.co
SUPABASE_PUBLISHABLE_KEY=eyJ...      (publishable / anon)
SUPABASE_SERVICE_ROLE_KEY=eyJ...     (clicar em Reveal)
```

E a chave da Anthropic (`ANTHROPIC_API_KEY`), para a IA.

> 🔴 A `service_role` **ignora todas as regras de acesso** — e neste
> projeto, que divide o Supabase com o CRM, isso inclui o CRM inteiro. Ela
> vai **só** para o Render. Nunca para o Cloudflare, nunca para o `.env` do
> front.

---

## Passo 1 — Criar o serviço

1. <https://dashboard.render.com> → **New** → **Web Service**.
2. **Connect a repository** → escolher `politica_envioIAWhatsapp_Back`.
   - Se o Render ainda não enxerga o repositório, ele oferece
     *Configure account* para dar acesso no GitHub. É uma vez só.
3. Na tela de configuração:

| Campo | Valor |
| --- | --- |
| Name | `central-indiara-api` |
| Language / Runtime | **Docker** |
| Branch | a branch onde está o código |
| Region | a mais próxima do leste dos EUA — **o Supabase está em North Virginia** |
| Instance Type | **Free** |
| Health Check Path | `/health` |

> **Docker não é preferência.** O `Dockerfile` instala o `ffmpeg`, que
> converte a nota de voz gravada no navegador. Sem ele o sistema diz
> "enviado" e boa parte dos Androids do outro lado mostra um anexo que não
> toca. O runtime Node nativo do Render não tem ffmpeg.

> **A região importa mais do que parece.** Toda leitura do backend é uma
> chamada HTTP ao Supabase. Backend e banco em continentes diferentes somam
> latência em *cada uma* delas.

4. **NÃO clique em Create ainda** — falta o Passo 2.

---

## Passo 2 — Variáveis de ambiente

Ainda na tela de criação, seção **Environment Variables**. Adicione:

**As quatro que só você tem:**

```
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
```

**As de configuração (pode copiar como está):**

```
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
DISPARO_ATIVO=false
GATEWAY_LEASE_TTL_SEG=45
GATEWAY_LEASE_RENOVACAO_MS=15000
TRANSCRICAO_ATIVA=false
```

**`CORS_ORIGIN` e `APP_BASE_URL` ficam para depois** — elas recebem a URL
do front, que ainda não existe. Voltamos nelas no guia do Cloudflare.

> ### Duas armadilhas
>
> **`DISPARO_ATIVO=false` é de propósito.** O worker sobe e não faz nada.
> Ligar depois de conferir a linha e de passar no teste de responder "SAIR"
> é muito mais barato que descobrir um problema com mensagem já saindo.
>
> **NÃO adicione `GCP_PROJECT_ID`.** A simples presença dela liga o caminho
> do Google Secret Manager no código e desliga a leitura das credenciais
> Twilio por variável de ambiente. Ausente é o modo certo aqui.
>
> **NÃO adicione `PORT`.** O Render injeta.

5. Agora sim: **Create Web Service**.

---

## Passo 3 — Acompanhar o primeiro build

O build leva alguns minutos (Docker, `npm ci`, `tsc`, mais o `ffmpeg`).

**Deu certo quando** o log mostra, no fim:

```
central_indiara_backend ouvindo na porta 10000
```

e o serviço fica **Live**.

**No log você também deve ver**, logo em seguida:

```
disputa pela posse do gateway iniciada
esta instância assumiu a posse do gateway
```

Isso é a trava que impede duas instâncias disputarem a mesma linha de
WhatsApp durante um deploy. Se aparecer, o banco está acessível e as
credenciais do Supabase estão certas — é um teste de conectividade de
graça.

**Copie a URL do serviço.** Algo como
`https://central-indiara-api.onrender.com`. O Cloudflare vai precisar dela.

---

## Passo 4 — Conferir

```bash
# 1. de pé
curl https://central-indiara-api.onrender.com/health
# esperado: 200

# 2. a barreira é o token, não o CORS
curl https://central-indiara-api.onrender.com/disparos
# esperado: 401
```

Se o `/health` demorar ~50 segundos na primeira vez, é o serviço acordando
da suspensão. É o comportamento do gratuito, não um defeito.

---

## Passo 5 — Próximo provedor

Com a URL em mãos, siga para o
[guia do Cloudflare](../../politica_envioIAWhatsapp_Front/docs/PUBLICAR_NO_CLOUDFLARE.md).
Ela vai em `VITE_API_URL`, **como variável de build**.

Depois que o front existir, volte aqui e preencha as duas que ficaram
pendentes:

```
CORS_ORIGIN=<url do front>
APP_BASE_URL=<url do front>
```

Sem a primeira, toda chamada do navegador morre em CORS. Sem a segunda, o
link de convite da equipe aponta para `localhost`.

---

## Problemas comuns

**O build falha em `npm ci`**
Falta o `package-lock.json` no commit, ou a branch escolhida está
desatualizada. Confira qual branch o Render está usando.

**Sobe, mas o log mostra "falha ao tomar/renovar a posse do gateway"**
O backend não está alcançando o Supabase. Quase sempre é
`SUPABASE_URL` ou `SUPABASE_SERVICE_ROLE_KEY` com erro de cópia — um
espaço no fim já basta.

**O serviço reinicia sozinho de tempos em tempos**
No gratuito, é a suspensão por inatividade. Esperado.

**"Deploy failed" sem mensagem clara**
Abra a aba *Logs* e role até o começo do build. O erro real quase nunca
está na última linha.

---

## Quando trocar de plano

Settings → **Instance Type** → escolher um plano pago. Não precisa
reconfigurar nada: as variáveis, o repositório e a URL continuam os mesmos.

Faça isso **antes** de deixar a linha esperando eleitor fora do seu horário
e **antes** de `DISPARO_ATIVO=true`. Não é otimização de custo — é o que
separa "funciona enquanto olho" de "funciona".
