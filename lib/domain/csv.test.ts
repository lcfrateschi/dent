import { describe, expect, it } from 'vitest'
import { celulaCsv, dinheiroCsv, gerarCsv, nomeDeArquivoCsv } from './csv'

const SEM_BOM = { bom: false } as const

describe('escape de célula', () => {
  it('deixa texto simples em paz', () => {
    expect(celulaCsv('Maria')).toBe('Maria')
    expect(celulaCsv(123)).toBe('123')
    expect(celulaCsv('')).toBe('')
  })

  it('nulo e undefined viram célula vazia', () => {
    expect(celulaCsv(null)).toBe('')
    expect(celulaCsv(undefined)).toBe('')
  })

  it('aspas duplas quando há separador, aspas ou quebra de linha', () => {
    expect(celulaCsv('Silva; Maria')).toBe('"Silva; Maria"')
    expect(celulaCsv('a"b')).toBe('"a""b"')
    expect(celulaCsv('linha1\nlinha2')).toBe('"linha1\nlinha2"')
  })

  it('respeita o separador informado', () => {
    expect(celulaCsv('a,b', ',')).toBe('"a,b"')
    // Com ';' como separador, a vírgula é texto comum.
    expect(celulaCsv('a,b', ';')).toBe('a,b')
  })
})

describe('injeção de fórmula em planilha', () => {
  /**
   * O ataque não é contra o servidor: é contra quem abre o CSV no Excel. Um campo
   * de observação com `=HYPERLINK(...)` executa na máquina da recepção.
   */
  it('NEUTRALIZA célula que começa com caractere de fórmula', () => {
    for (const perigoso of [
      '=1+1',
      '=HYPERLINK("http://malicioso","clique")',
      '+1+1',
      '@SUM(A1)',
      '\tinjecao',
      '\rinjecao',
      '=cmd|\' /C calc\'!A0',
    ]) {
      const saida = celulaCsv(perigoso)
      expect(saida.startsWith("'") || saida.startsWith('"\''), perigoso).toBe(true)
    }
  })

  it('não estraga número negativo legítimo', () => {
    // '-150.00' é valor, não fórmula. Prefixar quebraria a soma na planilha.
    expect(celulaCsv('-150.00')).toBe('-150.00')
    expect(celulaCsv('-150,00')).toBe('-150,00')
    expect(celulaCsv(-42)).toBe('-42')
  })

  it('mas texto que começa com "-" e não é número é neutralizado', () => {
    expect(celulaCsv('-cmd')).toBe("'-cmd")
  })

  it('o apóstrofo protege sem sujar o dado visível', () => {
    // No Excel o apóstrofo inicial não aparece na célula.
    expect(celulaCsv('=A1')).toBe("'=A1")
  })

  it('protege mesmo quando também precisa de aspas', () => {
    const saida = celulaCsv('=A1;B2')
    expect(saida).toBe('"\'=A1;B2"')
  })
})

describe('geração do arquivo', () => {
  it('monta cabeçalho e linhas com CRLF', () => {
    const csv = gerarCsv(['Nome', 'Valor'], [['Maria', '100.00'], ['João', '200.00']], SEM_BOM)
    expect(csv).toBe('Nome;Valor\r\nMaria;100.00\r\nJoão;200.00')
  })

  it('usa ponto e vírgula por padrão — é o que o Excel pt-BR espera', () => {
    // Com ',' o Excel em português joga tudo numa coluna só.
    expect(gerarCsv(['a', 'b'], [], SEM_BOM)).toBe('a;b')
  })

  it('inclui BOM por padrão, para o acento não sair quebrado', () => {
    const comBom = gerarCsv(['Procedimento'], [['Restauração']])
    expect(comBom.charCodeAt(0)).toBe(0xfeff)
    expect(comBom).toContain('Restauração')
  })

  it('sem linhas ainda produz o cabeçalho', () => {
    expect(gerarCsv(['a', 'b'], [], SEM_BOM)).toBe('a;b')
  })

  it('cabeçalho também é escapado', () => {
    expect(gerarCsv(['=nome'], [], SEM_BOM)).toBe("'=nome")
  })

  it('linha com número diferente de colunas não quebra a geração', () => {
    // Preferível a exportação desalinhada do que exceção no meio do download.
    const csv = gerarCsv(['a', 'b'], [['1'], ['1', '2', '3']], SEM_BOM)
    expect(csv.split('\r\n')).toHaveLength(3)
  })
})

describe('nome do arquivo', () => {
  it('inclui o período e é seguro para cabeçalho', () => {
    expect(nomeDeArquivoCsv('Produção por profissional', '2026-07-01', '2026-07-31')).toBe(
      'Producao-por-profissional_2026-07-01_a_2026-07-31.csv',
    )
  })

  it('neutraliza o que quebraria o Content-Disposition', () => {
    for (const base of ['a"b', 'a\r\nX: 1', '../etc/passwd', ';rm -rf /']) {
      const nome = nomeDeArquivoCsv(base, '2026-07-01', '2026-07-31')
      expect(/^[A-Za-z0-9_.-]+$/.test(nome), `${base} → ${nome}`).toBe(true)
    }
  })

  it('nunca fica sem nome', () => {
    expect(nomeDeArquivoCsv('', '2026-07-01', '2026-07-31')).toBe(
      'relatorio_2026-07-01_a_2026-07-31.csv',
    )
    expect(nomeDeArquivoCsv('😀', '2026-07-01', '2026-07-31')).toBe(
      'relatorio_2026-07-01_a_2026-07-31.csv',
    )
  })
})

describe('dinheiro em planilha', () => {
  it('usa vírgula decimal', () => {
    expect(dinheiroCsv('1234.56')).toBe('1234,56')
    expect(dinheiroCsv('0.00')).toBe('0,00')
  })
})
