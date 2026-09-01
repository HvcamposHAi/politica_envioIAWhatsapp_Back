import { describe, expect, it } from 'vitest';
import { normalizarTelefone } from './mensagens.js';
import { CASOS_TELEFONE } from './normalizarTelefone.casos.js';

/**
 * Metade da prova. A outra metade roda no Postgres, no bloco 8.1 da
 * migration 20260831120000_campanha_eleitores.sql, contra esta MESMA
 * lista de casos — ver o cabeçalho de normalizarTelefone.casos.ts.
 *
 * Este arquivo sozinho não prova que as duas implementações concordam;
 * prova que a de TypeScript segue a especificação. A de SQL prova a dela
 * na hora do `supabase db push`, e falha o push se divergir.
 */
describe('normalizarTelefone — especificação compartilhada com hub.normalizar_telefone', () => {
  for (const caso of CASOS_TELEFONE) {
    it(`"${caso.entrada}" -> "${caso.esperado}" (${caso.porque})`, () => {
      expect(normalizarTelefone(caso.entrada)).toBe(caso.esperado);
    });
  }

  it('é idempotente: normalizar o resultado não muda nada', () => {
    for (const caso of CASOS_TELEFONE) {
      const uma = normalizarTelefone(caso.entrada);
      expect(normalizarTelefone(uma)).toBe(uma);
    }
  });

  it('nunca inventa DDD para número curto', () => {
    // Se algum dia alguém "melhorar" a função para completar o DDD da
    // cidade da campanha, este teste quebra — e tem que quebrar. Chutar
    // DDD em disparo de massa manda a mensagem para um desconhecido com
    // o mesmo número em outro estado.
    expect(normalizarTelefone('999887766')).toBe('999887766');
    expect(normalizarTelefone('99988776')).toBe('99988776');
  });
});
