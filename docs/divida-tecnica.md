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

## 2026-08-31 — `types.ts` do front descrevia o schema antigo — RESOLVIDO em 02/09

Estava aqui porque o arquivo gerado ainda continha as views e colunas de
ponte com o ERP que a Fase 0 removeu, e só podia ser regenerado contra um
banco de verdade.

Resolvido: com o schema aplicado no `Projetos_HAI`,
`supabase gen types typescript --linked --schema hub` regerou o arquivo —
1.698 linhas, as 14 referências ao ERP zeradas, e as tabelas novas
(`gateway_lease`, `importacoes`, `listas`, `lista_eleitores`) presentes.
Build e 218 testes do front passando depois da troca.

**Fica o hábito:** toda vez que uma migration nova for aplicada, regerar.
O `--schema hub` não é opcional — sem ele, os tipos do CRM que divide o
projeto entrariam no código do front.
