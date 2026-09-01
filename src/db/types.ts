// PLACEHOLDER — regenerar depois que as migrations de supabase/migrations/
// forem aplicadas ao projeto zfbjwhaltqewbluqfmtt (Fase 2.5 em diante):
//
//   supabase gen types typescript --linked --schema hub > src/db/types.ts
//
// Não foi possível gerar de verdade agora: o schema `hub` só existe nas
// migrations locais (20260731*.sql), ainda não aplicadas ao banco vivo —
// aplicar depende da Fase 1 (RLS) ter sido confirmada primeiro (A0.2,
// A1.3, A1.4). Ver docs/fase0-fase1-diagnostico.md e o cabeçalho de
// 20260731000000_hub_schema.sql.
//
// Até lá, `Database` fica `any` deliberadamente — melhor um `any` visível
// e comentado do que um tipo inventado que finge ter sido verificado
// contra o banco real. Isto é o "front só consome types.ts gerado pelo
// back" da governança de schema (Fase 2.6): este arquivo é o dono, o
// front nunca edita.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any;
