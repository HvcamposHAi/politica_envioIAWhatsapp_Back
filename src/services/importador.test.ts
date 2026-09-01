import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  analisar,
  conferirMapeamento,
  lerPlanilha,
  separarTags,
  sugerirMapeamento,
  validarTelefone,
  type Mapeamento,
} from './importador.js';

async function planilhaXlsx(linhas: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('eleitores');
  for (const l of linhas) ws.addRow(l);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('validarTelefone', () => {
  it('aceita celular com DDD válido', () => {
    expect(validarTelefone('47999887766')).toMatchObject({ ok: true, normalizado: '5547999887766' });
  });

  it('aceita fixo, mesmo raramente tendo WhatsApp', () => {
    // Rejeitar aqui esconderia do admin que a planilha veio cheia de fixo.
    expect(validarTelefone('4733445566')).toMatchObject({ ok: true, normalizado: '554733445566' });
  });

  it('aceita número que já vem com o 55', () => {
    expect(validarTelefone('+55 (47) 99988-7766')).toMatchObject({ ok: true });
  });

  it('rejeita DDD que não existe', () => {
    const r = validarTelefone('20999887766');
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('DDD 20');
  });

  it('rejeita celular de 9 dígitos que não começa com 9', () => {
    const r = validarTelefone('47899887766');
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('começar com 9');
  });

  it('rejeita fixo que começa com 1', () => {
    const r = validarTelefone('4713445566');
    expect(r.ok).toBe(false);
    expect(r.motivo).toContain('entre 2 e 5');
  });

  it('rejeita número curto em vez de chutar o DDD', () => {
    // Chutar o DDD da cidade da campanha mandaria a mensagem para um
    // desconhecido com o mesmo número em outro estado.
    const r = validarTelefone('999887766');
    expect(r.ok).toBe(false);
  });

  it('rejeita vazio e lixo', () => {
    expect(validarTelefone('').ok).toBe(false);
    expect(validarTelefone('não tem').ok).toBe(false);
  });
});

describe('sugerirMapeamento', () => {
  it('reconhece os cabeçalhos comuns de planilha de campanha', () => {
    const mapa = sugerirMapeamento(['Nome Completo', 'Celular', 'Bairro', 'Cidade']);
    expect(mapa['Nome Completo']).toBe('nome');
    expect(mapa['Celular']).toBe('telefone');
    expect(mapa['Bairro']).toBe('bairro');
    expect(mapa['Cidade']).toBe('cidade');
  });

  it('reconhece variações de acento e caixa', () => {
    const mapa = sugerirMapeamento(['MUNICÍPIO', 'whatsapp', 'Pauta de Interesse']);
    expect(mapa['MUNICÍPIO']).toBe('cidade');
    expect(mapa['whatsapp']).toBe('telefone');
    expect(mapa['Pauta de Interesse']).toBe('tags');
  });

  it('não aponta duas colunas para o mesmo campo', () => {
    const mapa = sugerirMapeamento(['Telefone', 'Celular', 'WhatsApp']);
    const paraTelefone = Object.values(mapa).filter((c) => c === 'telefone');
    expect(paraTelefone).toHaveLength(1);
  });

  it('devolve mapa vazio quando nenhum cabeçalho é reconhecível', () => {
    expect(sugerirMapeamento(['A', 'B', 'C'])).toEqual({});
  });
});

describe('conferirMapeamento', () => {
  it('exige nome e telefone', () => {
    const problemas = conferirMapeamento({ Bairro: 'bairro' });
    expect(problemas.map((p) => p.campo).sort()).toEqual(['nome', 'telefone']);
  });

  it('recusa duas colunas para o mesmo campo', () => {
    const mapa: Mapeamento = { Nome: 'nome', Fone: 'telefone', Celular: 'telefone' };
    const problemas = conferirMapeamento(mapa);
    expect(problemas).toHaveLength(1);
    expect(problemas[0].mensagem).toContain('Duas colunas');
  });

  it('aceita mapeamento mínimo', () => {
    expect(conferirMapeamento({ Nome: 'nome', Fone: 'telefone' })).toEqual([]);
  });
});

describe('separarTags', () => {
  it('separa por vírgula, ponto e vírgula e barra', () => {
    expect(separarTags('Saúde, Educação; Transporte/Cultura')).toEqual([
      'saúde',
      'educação',
      'transporte',
      'cultura',
    ]);
  });

  it('remove repetição e vazio', () => {
    expect(separarTags('saúde,,SAÚDE, ')).toEqual(['saúde']);
  });

  it('vazio vira lista vazia, não [""]', () => {
    expect(separarTags(undefined)).toEqual([]);
    expect(separarTags('')).toEqual([]);
  });
});

describe('lerPlanilha', () => {
  it('lê XLSX com cabeçalho e devolve as linhas casadas', async () => {
    const buf = await planilhaXlsx([
      ['Nome', 'Telefone', 'Bairro'],
      ['Maria Silva', '47999887766', 'Centro'],
      ['João Souza', '47988776655', 'Vila Nova'],
    ]);
    const { colunas, linhas } = await lerPlanilha(buf, 'lista.xlsx');
    expect(colunas).toEqual(['Nome', 'Telefone', 'Bairro']);
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatchObject({ Nome: 'Maria Silva', Bairro: 'Centro', __linha: '2' });
  });

  it('lê CSV', async () => {
    const csv = Buffer.from('Nome,Telefone\nMaria,47999887766\nJoão,47988776655\n', 'utf-8');
    const { colunas, linhas } = await lerPlanilha(csv, 'lista.csv');
    expect(colunas).toEqual(['Nome', 'Telefone']);
    expect(linhas).toHaveLength(2);
  });

  it('numera coluna sem cabeçalho em vez de descartá-la', async () => {
    const buf = await planilhaXlsx([
      ['Nome', '', 'Bairro'],
      ['Maria', '47999887766', 'Centro'],
    ]);
    const { colunas } = await lerPlanilha(buf, 'l.xlsx');
    expect(colunas[1]).toBe('Coluna 2');
  });

  it('mantém o telefone como texto quando a planilha o guardou como número', async () => {
    // Defeito clássico de planilha de campanha: o Excel guarda o telefone
    // como número e come o zero à esquerda. Aqui ele tem que chegar como
    // string, para a normalização decidir o que fazer.
    const buf = await planilhaXlsx([
      ['Nome', 'Telefone'],
      ['Maria', 47999887766],
    ]);
    const { linhas } = await lerPlanilha(buf, 'l.xlsx');
    expect(linhas[0].Telefone).toBe('47999887766');
  });

  it('ignora linha totalmente vazia no meio do arquivo', async () => {
    const csv = Buffer.from('Nome,Telefone\nMaria,47999887766\n,\nJoão,47988776655\n', 'utf-8');
    const { linhas } = await lerPlanilha(csv, 'l.csv');
    expect(linhas).toHaveLength(2);
  });

  it('preserva o número da linha do arquivo, não o índice do array', async () => {
    // É o número que a pessoa vê ao abrir a planilha para corrigir.
    const csv = Buffer.from('Nome,Telefone\nMaria,999\nJoão,47988776655\n', 'utf-8');
    const { linhas } = await lerPlanilha(csv, 'l.csv');
    const mapa: Mapeamento = { Nome: 'nome', Telefone: 'telefone' };
    const r = analisar(linhas, mapa);
    expect(r.rejeitados[0].linha).toBe(2);
    expect(r.aceitos[0].linha).toBe(3);
  });
});

describe('analisar', () => {
  const mapa: Mapeamento = {
    Nome: 'nome',
    Telefone: 'telefone',
    Bairro: 'bairro',
    Tags: 'tags',
  };

  function linha(n: number, nome: string, telefone: string, bairro = '', tags = '') {
    return { __linha: String(n), Nome: nome, Telefone: telefone, Bairro: bairro, Tags: tags };
  }

  it('aceita linha completa e normaliza o telefone', () => {
    const r = analisar([linha(2, 'Maria Silva', '(47) 99988-7766', 'Centro', 'saúde,creche')], mapa);
    expect(r.aceitos).toHaveLength(1);
    expect(r.aceitos[0]).toMatchObject({
      nome: 'Maria Silva',
      telefone: '5547999887766',
      bairro: 'Centro',
      tags: ['saúde', 'creche'],
    });
  });

  it('rejeita linha sem nome, com o motivo', () => {
    const r = analisar([linha(2, '', '47999887766')], mapa);
    expect(r.aceitos).toHaveLength(0);
    expect(r.rejeitados[0].motivo).toBe('Sem nome.');
  });

  it('rejeita telefone inválido sem descartar em silêncio', () => {
    const r = analisar([linha(2, 'Maria', '123')], mapa);
    expect(r.rejeitados).toHaveLength(1);
    expect(r.rejeitados[0].linha).toBe(2);
    expect(r.rejeitados[0].motivo).toBeTruthy();
  });

  it('deduplica dentro do arquivo apontando a primeira ocorrência', () => {
    const r = analisar(
      [
        linha(2, 'Maria Silva', '47999887766'),
        linha(3, 'Maria S.', '(47) 99988-7766'), // mesmo número, outra grafia
      ],
      mapa,
    );
    expect(r.aceitos).toHaveLength(1);
    expect(r.duplicadosNoArquivo).toHaveLength(1);
    expect(r.duplicadosNoArquivo[0].motivo).toContain('linha 2');
  });

  it('separa duplicado de rejeitado', () => {
    // Duplicado não é erro de quem montou a planilha; rejeitado é. Contar
    // junto esconderia do admin qual dos dois problemas ele tem.
    const r = analisar(
      [linha(2, 'Maria', '47999887766'), linha(3, 'Maria', '47999887766'), linha(4, 'João', 'xx')],
      mapa,
    );
    expect(r.aceitos).toHaveLength(1);
    expect(r.duplicadosNoArquivo).toHaveLength(1);
    expect(r.rejeitados).toHaveLength(1);
  });

  it('campos opcionais ausentes viram undefined, não string vazia', () => {
    const r = analisar([linha(2, 'Maria', '47999887766', '   ')], mapa);
    expect(r.aceitos[0].bairro).toBeUndefined();
    expect(r.aceitos[0].tags).toEqual([]);
  });

  it('funciona com mapeamento que só tem os obrigatórios', () => {
    const r = analisar([{ __linha: '2', Nome: 'Maria', Telefone: '47999887766' }], {
      Nome: 'nome',
      Telefone: 'telefone',
    });
    expect(r.aceitos).toHaveLength(1);
    expect(r.aceitos[0].bairro).toBeUndefined();
  });
});
