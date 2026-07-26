import { describe, expect, it } from 'vitest'
import {
  compara,
  deCentavos,
  multiplicar,
  paraCentavos,
  percentual,
  ratear,
  somar,
  subtrair,
} from './dinheiro'
import { ErroDominio } from './erros'

describe('conversão para centavos', () => {
  it('converte formatos válidos', () => {
    expect(paraCentavos('1234.56')).toBe(123456)
    expect(paraCentavos('0.01')).toBe(1)
    expect(paraCentavos('0.1')).toBe(10) // uma casa decimal = décimos
    expect(paraCentavos('100')).toBe(10000)
    expect(paraCentavos('-50.25')).toBe(-5025)
    expect(paraCentavos('  10.00  ')).toBe(1000)
  })

  it('rejeita formato inválido em vez de virar NaN silencioso', () => {
    for (const ruim of ['', 'abc', '1,50', '1.234', '1.5.6', 'R$ 10', '1e3']) {
      expect(() => paraCentavos(ruim), `deveria rejeitar "${ruim}"`).toThrowError(ErroDominio)
    }
  })

  it('faz ida e volta sem perder centavo', () => {
    for (const v of ['0.00', '0.01', '1.99', '999.99', '12345.67']) {
      expect(deCentavos(paraCentavos(v))).toBe(v)
    }
  })

  it('deCentavos rejeita fração — perder meio centavo é bug, não arredondamento', () => {
    expect(() => deCentavos(10.5)).toThrowError(ErroDominio)
  })
})

describe('aritmética', () => {
  it('soma sem erro de float', () => {
    // 0.1 + 0.2 em float dá 0.30000000000000004
    expect(somar('0.10', '0.20')).toBe('0.30')
    expect(somar('19.99', '0.01')).toBe('20.00')
    expect(somar('1.10', '2.20', '3.30')).toBe('6.60')
  })

  it('subtrai e compara', () => {
    expect(subtrair('100.00', '33.34')).toBe('66.66')
    expect(compara('10.00', '10.00')).toBe(0)
    expect(compara('9.99', '10.00')).toBe(-1)
    expect(compara('10.01', '10.00')).toBe(1)
  })

  it('multiplica por quantidade inteira', () => {
    expect(multiplicar('19.90', 3)).toBe('59.70')
    expect(multiplicar('19.90', 0)).toBe('0.00')
    expect(() => multiplicar('19.90', 1.5)).toThrowError(ErroDominio)
    expect(() => multiplicar('19.90', -1)).toThrowError(ErroDominio)
  })

  it('aplica percentual arredondando ao centavo', () => {
    expect(percentual('100.00', '50')).toBe('50.00')
    expect(percentual('100.00', '100')).toBe('100.00')
    expect(percentual('100.00', '0')).toBe('0.00')
    // 33.33% de 10.00 = 3.333 → 3.33
    expect(percentual('10.00', '33.33')).toBe('3.33')
    // 70% de 0.01 = 0.007 → arredonda para 0.01
    expect(percentual('0.01', '70')).toBe('0.01')
  })
})

describe('rateio', () => {
  it('a soma das partes é sempre exatamente o total', () => {
    const casos: [string, number][] = [
      ['100.00', 3],
      ['0.05', 3],
      ['1000.00', 7],
      ['19.99', 12],
      ['0.01', 1],
      ['123.45', 6],
      ['999999.99', 60],
    ]
    for (const [total, partes] of casos) {
      const r = ratear(total, partes)
      expect(r, `${total} / ${partes}`).toHaveLength(partes)
      expect(somar(...r), `${total} / ${partes}`).toBe(
        deCentavos(paraCentavos(total)),
      )
    }
  })

  it('põe a sobra na primeira parte', () => {
    expect(ratear('100.00', 3)).toEqual(['33.34', '33.33', '33.33'])
    expect(ratear('10.00', 4)).toEqual(['2.50', '2.50', '2.50', '2.50'])
    expect(ratear('0.05', 3)).toEqual(['0.03', '0.01', '0.01'])
  })

  it('em uma parte devolve o total', () => {
    expect(ratear('123.45', 1)).toEqual(['123.45'])
  })

  it('rejeita entrada inválida', () => {
    expect(() => ratear('100.00', 0)).toThrowError(ErroDominio)
    expect(() => ratear('100.00', 2.5)).toThrowError(ErroDominio)
    expect(() => ratear('-100.00', 2)).toThrowError(ErroDominio)
  })
})
