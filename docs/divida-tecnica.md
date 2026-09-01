# Dívida técnica registrada

Formato: data, o que é, por que existe, quando resolver. Item some da
lista quando resolvido — isto não é changelog.

---

## 2026-08-05 — Normalização de telefone só existe em TypeScript

**O que é:** `normalizarTelefone()` em `src/services/mensagens.ts` é a
única normalização de telefone do sistema — conta dígitos e decide se
prefixa `55` (dígitos de `hub.clientes.telefone`, chave de correlação com
o WhatsApp). Ela existe porque `hub.normalizar_telefone` nunca foi criada
em nenhuma migration.

**Por que importa agora:** deixou de ser dívida dormente. O importador de
XLSX/CSV (Fase 2) precisa deduplicar dezenas de milhares de linhas contra
`hub.clientes.telefone`, e dedupe em massa é trabalho de banco, não de
laço em Node. Sem a função em SQL, o importador teria que reimplementar a
regra numa terceira linguagem — e duas normalizações que discordam em um
caso de borda produzem eleitor duplicado, que vira **duas mensagens para a
mesma pessoa**.

**Quando resolver:** na Fase 1, junto com o modelo de dados eleitoral.
Criar `hub.normalizar_telefone(text) returns text`, usar no índice único
de dedupe, e fazer `services/mensagens.ts` chamar via RPC em vez de
reimplementar. Uma fonte só.

---

## 2026-08-31 — `types.ts` do front ainda descreve o schema antigo

**O que é:** `politica_envioIAWhatsapp_Front/src/integrations/supabase/types.ts`
é gerado por `supabase gen types --schema hub` e ainda contém as views e
colunas de ponte com o ERP que a Fase 0 removeu das migrations
(`v_cliente_ficha`, `v_cliente_inativo`, `cod_cliente`, `cod_vendedor`,
`cod_filial`).

**Por que existe:** o arquivo só pode ser regenerado contra um banco de
verdade, e o projeto Supabase da campanha ainda não foi criado (é um dos
gates humanos da Fase 0). Editá-lo à mão seria pior: ele é gerado, e a
edição manual seria sobrescrita na primeira regeneração, provavelmente
sem ninguém notar.

**Impacto hoje:** nenhum em runtime — nada em `src/` lê essas views;
conferido por busca em 31/08. É só tipo morto.

**Quando resolver:** assim que o projeto Supabase da campanha existir e as
migrations forem aplicadas. Rodar `supabase gen types --schema hub` e
commitar o resultado. Item de aceite da Fase 1.
