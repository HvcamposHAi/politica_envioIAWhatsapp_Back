/**
 * A lista de casos da normalização de telefone — a especificação, num
 * lugar só.
 *
 * A regra existe DUAS vezes no sistema, e não dá para eliminar nenhuma
 * das duas:
 *
 *   · `normalizarTelefone()` (services/mensagens.ts) roda no caminho
 *     quente da mensagem que chega. Ir ao banco para normalizar um
 *     telefone por mensagem recebida é round-trip por nada.
 *   · `hub.normalizar_telefone()` (migration 20260831120000) roda no
 *     importador, que deduplica dezenas de milhares de linhas de uma vez.
 *     Isso é trabalho de banco; trazer a base para o Node para comparar
 *     string é o desenho errado.
 *
 * Duas implementações que discordam num caso de borda produzem eleitor
 * duplicado — e eleitor duplicado é DUAS MENSAGENS PARA A MESMA PESSOA,
 * que é exatamente o que faz alguém denunciar a linha.
 *
 * Então: uma especificação, duas verificações. Esta lista é conferida
 * pelo TypeScript em normalizarTelefone.test.ts e pelo Postgres no bloco
 * de autovalidação 8.1 da migration. Mexeu na regra? Mexa nos três.
 */
export interface CasoTelefone {
  entrada: string;
  esperado: string;
  porque: string;
}

export const CASOS_TELEFONE: readonly CasoTelefone[] = [
  {
    entrada: '47999887766',
    esperado: '5547999887766',
    porque: 'celular com DDD, sem DDI — o caso comum de planilha',
  },
  {
    entrada: '4733445566',
    esperado: '554733445566',
    porque: 'fixo com DDD: 10 dígitos também ganham o 55',
  },
  {
    entrada: '(47) 99988-7766',
    esperado: '5547999887766',
    porque: 'máscara de formulário — pontuação some antes de contar',
  },
  {
    entrada: '+55 47 99988-7766',
    esperado: '5547999887766',
    porque: 'já vem com DDI: 13 dígitos, não recebe outro 55',
  },
  {
    entrada: '5547999887766',
    esperado: '5547999887766',
    porque: 'já normalizado — a função é idempotente',
  },
  {
    entrada: '999887766',
    esperado: '999887766',
    porque:
      'nove dígitos: celular sem DDD. NÃO tenta adivinhar o DDD — volta cru e ' +
      'o importador rejeita, porque chutar DDD manda mensagem para estranho',
  },
  {
    entrada: '',
    esperado: '',
    porque: 'vazio continua vazio, não vira "55"',
  },
  {
    entrada: 'abc',
    esperado: '',
    porque: 'sem dígito nenhum: some, e a linha é rejeitada na validação',
  },
] as const;
