# central_indiara_backend

Backend da **Central de Envio de Mensagens WhatsApp** da campanha Indiara.
Dono do schema `hub` no projeto Supabase da campanha, do worker de sessões
Baileys e do motor de disparo.

Plano completo: [`docs/PLANO_CAMPANHA_INDIARA.md`](docs/PLANO_CAMPANHA_INDIARA.md).
Este README cobre só o que já existe neste repo.

## Origem do código

Este projeto começou como cópia de um hub de atendimento por WhatsApp
construído para outro cliente. O que veio junto — gateway Baileys
multi-linha, mídia, transcrição de áudio, motor de IA, RLS, deploy Cloud
Run endurecido — não é protótipo: é código que passou por incidente real
de produção, e os comentários no fonte explicam por que cada decisão está
como está. **Não remova esses comentários por parecerem verbosos.**

A Fase 0 (31/08/2026) desacoplou tudo que era do outro cliente: réplica de
ERP, views de ponte, seeds de demonstração e credenciais. Ver
`docs/PLANO_CAMPANHA_INDIARA.md`.

## Estado atual (31/08/2026)

| Área | Estado |
| --- | --- |
| Gateway Baileys (conectar, receber, enviar 1:1) | funcionando |
| Mídia, transcrição de áudio, grupos | funcionando |
| IA de atendimento (resumo, sentimento, CSAT, analista) | funcionando |
| Schema `hub` desacoplado do ERP | **Fase 0 — feito** |
| Modelo de eleitor, listas, consentimento | Fase 1 — a fazer |
| Importador XLSX/CSV | Fase 2 — a fazer |
| Motor de disparo com ritmo humano | Fase 3 — a fazer |
| IA de campanha (personalização, triagem) | Fase 4 — a fazer |

## Setup

```bash
npm install
cp .env.example .env   # preencher com as credenciais do projeto da campanha
npm run build && npm start   # ou: npm run dev
npm test
```

`GET /health` deve responder `200`.

## Migrations

```bash
supabase link --project-ref <ref-do-projeto-da-campanha>
supabase db push
```

As migrations em `supabase/migrations/` são uma **sequência linear
aplicável num banco vazio**. Ordem por nome de arquivo, como o CLI do
Supabase faz.

`supabase/rollback/` guarda os scripts de desfazer herdados do hub
original. Eles **não** são aplicados por `db push` (o CLI só lê
`migrations/`) e **não** foram revisados para esta plataforma — ver o
README daquela pasta antes de rodar qualquer um.

## Governança de schema

As migrations vivem **só aqui**. O front consome
`src/integrations/supabase/types.ts`, gerado por
`supabase gen types --schema hub`, e nunca edita o schema.
