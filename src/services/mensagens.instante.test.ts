// Teste pontual: a data/hora gravada em hub.mensagens.enviada_em é a da
// MENSAGEM (messageTimestamp do WhatsApp), não a do processamento.
// Ver PLANO_ORDENACAO_CRONOLOGICA_CAIXA.md §1.2 e §9.2.
import { describe, expect, it } from 'vitest';
import { instanteDaMensagem } from './mensagens.js';

const AGORA = new Date('2026-08-10T18:00:00.000Z');

describe('instanteDaMensagem', () => {
  it('preserva timestamp do PASSADO — é o backlog de reconexão', () => {
    // O caso que motivou a mudança: o Baileys entrega de uma vez tudo que
    // chegou enquanto a sessão esteve fora. Se isto virasse `now()`, a tarde
    // inteira do cliente ficaria empilhada no mesmo minuto.
    const duasHorasAntes = new Date('2026-08-10T16:00:00.000Z');
    expect(instanteDaMensagem(duasHorasAntes, AGORA)).toBe('2026-08-10T16:00:00.000Z');
  });

  it('preserva timestamp de dias atrás (sessão fora por muito tempo)', () => {
    const tresDias = new Date('2026-08-07T09:13:00.000Z');
    expect(instanteDaMensagem(tresDias, AGORA)).toBe('2026-08-07T09:13:00.000Z');
  });

  it('LIMITA timestamp do futuro a agora — relógio do aparelho adiantado', () => {
    // Sem o clamp, um celular com a data errada pregaria a conversa no topo
    // da Caixa até o mundo alcançar o relógio dele.
    const daquiUmAno = new Date('2027-08-10T18:00:00.000Z');
    expect(instanteDaMensagem(daquiUmAno, AGORA)).toBe(AGORA.toISOString());
  });

  it('limita mesmo um futuro de poucos segundos (sem tolerância)', () => {
    const trintaSegAdiante = new Date(AGORA.getTime() + 30_000);
    expect(instanteDaMensagem(trintaSegAdiante, AGORA)).toBe(AGORA.toISOString());
  });

  it('cai em agora quando o adapter não resolveu o timestamp', () => {
    expect(instanteDaMensagem(undefined, AGORA)).toBe(AGORA.toISOString());
  });

  it('cai em agora com epoch 0 (messageTimestamp ausente vira Date(0))', () => {
    expect(instanteDaMensagem(new Date(0), AGORA)).toBe(AGORA.toISOString());
  });

  it('cai em agora com data inválida em vez de gravar NaN', () => {
    expect(instanteDaMensagem(new Date('nao é data'), AGORA)).toBe(AGORA.toISOString());
  });

  it('data anterior a 1970 não vira timestamp negativo', () => {
    expect(instanteDaMensagem(new Date('1969-01-01T00:00:00.000Z'), AGORA)).toBe(
      AGORA.toISOString(),
    );
  });

  it('é idempotente: aplicar de novo no resultado não muda nada', () => {
    const uma = instanteDaMensagem(new Date('2026-08-10T16:00:00.000Z'), AGORA);
    expect(instanteDaMensagem(new Date(uma), AGORA)).toBe(uma);
  });

  it('devolve ISO 8601 em UTC — é o formato que o PostgREST espera', () => {
    // 14:00 em -03:00 é 17:00Z, uma hora antes de AGORA: passa sem clamp.
    expect(instanteDaMensagem(new Date('2026-08-10T14:00:00-03:00'), AGORA)).toBe(
      '2026-08-10T17:00:00.000Z',
    );
  });
});
