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

## Disparo — o que ficou em aberto depois das correções de 10/09/2026

Contexto: a campanha de teste de 04/09 não enviou nenhuma mensagem. A
investigação virou o dossiê "Por que o disparo não saiu" e produziu a
migration `20260910120000_disparo_correcoes.sql` mais as mudanças em
`jobs/disparador.ts`, `channels/baileys.adapter.ts`, `services/ackEntrega.ts`
e `routes/disparos.ts`. O que **não** foi resolvido:

### D-12 — versão do Baileys: a decisão documentada e a instalada divergem

`package.json` e o lock fixam `7.0.0-rc14`, um release candidate. O
cabeçalho de `channels/baileys.adapter.ts` documenta `6.7.24` como escolha
deliberada, com a justificativa: *"para uma integração de produção onde o
Risco #1 do plano é justamente ban/instabilidade de sessão, a linha estável
é a escolha defensável, não a mais nova"*.

Não dá para resolver isto por leitura de código — é uma decisão. As duas
saídas são legítimas:

- **fixar `6.7.24`**: honra a justificativa escrita. Exige revalidar
  `onWhatsApp()` e o tratamento de `@lid`, que diferem entre as linhas —
  e o estágio 1 inteiro depende de `onWhatsApp()`;
- **assumir a 7.x**: atualizar o cabeçalho do adapter com a razão nova.

O que **não** é aceitável é o estado atual, com duas versões da verdade
convivendo: todo diagnóstico de sessão parte de premissa errada.

### D-14 — a tela promete segmentação que não existe

`POST /listas` aceita `filtro.bairros` e `filtro.tags`; o front chama
`criarLista({empresaId, nome})` sem filtro, sempre. Toda campanha vai para a
base ativa inteira, enquanto o placeholder do formulário sugere o contrário
("Ex.: apresentação — bairro Centro").

Junto com isso: `/disparos/:id/personalizar`, `/amostra` e
`/aprovar-amostra` não são chamados em lugar nenhum do front. A trava de
amostra aprovada em `/iniciar` é, hoje, código inalcançável — sem UI que
personalize, `texto_gerado` é sempre nulo e a trava nunca dispara.

As duas saídas são aceitáveis (expor os controles, ou remover a promessa do
texto da tela). A combinação atual não é.

### `db/types.ts` continua defasado

Já registrado antes desta passada e continua valendo: os tipos gerados
descrevem o schema anterior à Fase 1, então todo acesso às colunas de ritmo
passa por `as unknown as` e o compilador não protege nada nesse caminho. As
colunas novas desta migration (`pausa_codigo`, `reservado_em`,
`empresas.disparo_ativo`) entram na mesma situação.
