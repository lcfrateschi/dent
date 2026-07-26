import { describe, expect, it } from 'vitest'
import { codigoTussTemFormatoValido, ehFaixaOdontologica, lerCsvTuss } from '@/lib/domain/tuss'

describe('formato do código TUSS', () => {
  it('exige exatamente 8 dígitos', () => {
    expect(codigoTussTemFormatoValido('81000403')).toBe(true)
    expect(codigoTussTemFormatoValido('8100040')).toBe(false)
    expect(codigoTussTemFormatoValido('810004033')).toBe(false)
    expect(codigoTussTemFormatoValido('8100040a')).toBe(false)
    expect(codigoTussTemFormatoValido('')).toBe(false)
  })

  it('tolera espaço em volta', () => {
    expect(codigoTussTemFormatoValido('  81000403  ')).toBe(true)
  })

  it('reconhece a faixa odontológica INTEIRA: 81 a 87', () => {
    // Corrigido depois de baixar a tabela oficial: só 39 dos 370 procedimentos
    // odontológicos começam com 81. A maioria está em 82 e 85, e a versão
    // anterior desta checagem recusaria 331 códigos válidos.
    for (const c of ['81000030', '82000875', '83000089', '84000198', '85100196', '86000357', '87000199']) {
      expect(ehFaixaOdontologica(c), c).toBe(true)
    }
    // Fora da faixa: medicina (0x–5x) e o que passa de 87.
    for (const c of ['10101012', '31201180', '88000001', '80000001']) {
      expect(ehFaixaOdontologica(c), c).toBe(false)
    }
  })

  it('formato válido NÃO significa código existente', () => {
    // Só a ANS sabe se um código existe. É por isso que o arquivo dela é
    // insumo obrigatório, e não há tabela embutida no projeto.
    expect(codigoTussTemFormatoValido('81999999')).toBe(true)
    expect(ehFaixaOdontologica('81999999')).toBe(true)
  })
})

describe('leitura do CSV', () => {
  it('lê código e descrição', () => {
    const { linhas } = lerCsvTuss('81000403;Restauração em resina composta\n81000012;Profilaxia')
    expect(linhas).toHaveLength(2)
    expect(linhas[0]).toMatchObject({
      codigoTuss: '81000403',
      descricao: 'Restauração em resina composta',
    })
  })

  it('pula o cabeçalho sem precisar de configuração', () => {
    const { linhas } = lerCsvTuss('codigo_tuss;descricao\n81000403;Restauração')
    expect(linhas).toHaveLength(1)
  })

  it('tolera BOM, CRLF, aspas e espaço — o arquivo passa pelo Excel', () => {
    const csv = '﻿codigo;desc\r\n"81000403"; "Restauração" \r\n\r\n81000012;Profilaxia\r\n'
    const { linhas } = lerCsvTuss(csv)
    expect(linhas).toHaveLength(2)
    expect(linhas[0]!.descricao).toBe('Restauração')
  })

  it('aceita a terceira coluna de mapeamento para o código interno', () => {
    const { linhas } = lerCsvTuss('81000403;Restauração;REST-2F')
    expect(linhas[0]!.codigoInterno).toBe('REST-2F')
  })

  it('distingue DATA de código interno na terceira coluna', () => {
    // Os dois arquivos que a clínica usa têm formatos diferentes: a tabela
    // oficial da ANS traz `inicio_vigencia` na terceira coluna, o arquivo de
    // mapeamento traz o código interno. Confundir os dois faria o importador
    // tentar casar o catálogo com "2010-06-09".
    const oficial = lerCsvTuss('81000030;Consulta odontológica;2010-06-09;').linhas[0]!
    expect(oficial.inicioVigencia).toBe('2010-06-09')
    expect(oficial.codigoInterno).toBeUndefined()

    const mapeamento = lerCsvTuss('81000030;Consulta odontológica;CONS-001').linhas[0]!
    expect(mapeamento.codigoInterno).toBe('CONS-001')
    expect(mapeamento.inicioVigencia).toBeUndefined()
  })

  it('lê a quarta coluna como fim de vigência', () => {
    const l = lerCsvTuss('81000030;X;2010-06-09;2024-12-31').linhas[0]!
    expect(l.fimVigencia).toBe('2024-12-31')
  })

  it('SEPARA o que tem formato inválido em vez de importar errado', () => {
    const { linhas, invalidas } = lerCsvTuss(
      ['81000403;Bom', '123;Curto', '10101012;Fora da faixa', '81abcdef;Com letra'].join('\n'),
    )
    expect(linhas).toHaveLength(1)
    expect(invalidas).toHaveLength(3)
    expect(invalidas.join(' ')).toContain('8 dígitos')
    expect(invalidas.join(' ')).toContain('faixa odontológica')
  })

  it('arquivo vazio não quebra', () => {
    expect(lerCsvTuss('').linhas).toHaveLength(0)
    expect(lerCsvTuss('\n\n\n').linhas).toHaveLength(0)
  })

  it('linha sem descrição ainda é lida — a descrição é só para casar', () => {
    const { linhas } = lerCsvTuss('81000403')
    expect(linhas).toHaveLength(1)
    expect(linhas[0]!.descricao).toBe('')
  })
})
