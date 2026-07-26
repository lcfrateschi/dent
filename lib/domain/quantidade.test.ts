import { describe, expect, it } from 'vitest'
import {
  comparaQtd,
  converterCompra,
  deMilesimos,
  ehZeroQtd,
  formatarQuantidade,
  multiplicarQtd,
  paraMilesimos,
  somarQtd,
  subtrairQtd,
} from './quantidade'

describe('quantidade', () => {
  it('converte ida e volta', () => {
    expect(paraMilesimos('1.5')).toBe(1500)
    expect(paraMilesimos('12')).toBe(12_000)
    expect(paraMilesimos('0.001')).toBe(1)
    expect(deMilesimos(1500)).toBe('1.500')
    expect(deMilesimos(0)).toBe('0.000')
    expect(deMilesimos(-250)).toBe('-0.250')
  })

  it('soma decimal sem o erro de float', () => {
    // 0.1 + 0.2 em float dá 0.30000000000000004 — é a razão do módulo existir.
    expect(somarQtd('0.1', '0.2')).toBe('0.300')
    // Trinta gotas de 0,05 ml fecham em 1,5 ml exato.
    expect(somarQtd(...Array.from({ length: 30 }, () => '0.05'))).toBe('1.500')
  })

  it('subtrai até negativo — quem barra saldo negativo é o banco, não a aritmética', () => {
    expect(subtrairQtd('1', '3')).toBe('-2.000')
  })

  it('recusa formato que não cabe em numeric(12,3)', () => {
    expect(() => paraMilesimos('1.2345')).toThrow(/inválida/i)
    expect(() => paraMilesimos('abc')).toThrow()
    expect(() => paraMilesimos('')).toThrow()
    expect(() => paraMilesimos('1,5')).toThrow()
  })

  it('recusa milésimo fracionário — arredondar é decisão de quem chama', () => {
    expect(() => deMilesimos(0.5)).toThrow(/inteiros/i)
  })

  it('compara e detecta zero', () => {
    expect(comparaQtd('1.000', '1')).toBe(0)
    expect(comparaQtd('0.999', '1')).toBe(-1)
    expect(comparaQtd('2', '1')).toBe(1)
    expect(ehZeroQtd('0.000')).toBe(true)
    expect(ehZeroQtd('0.001')).toBe(false)
  })

  describe('converterCompra — o erro clássico da nota fiscal', () => {
    it('2 caixas de 100 luvas são 200 luvas, não 2', () => {
      expect(converterCompra('2', 100)).toBe('200.000')
    })

    it('material sem embalagem múltipla usa fator 1', () => {
      expect(converterCompra('50', 1)).toBe('50.000')
    })

    it('recusa fator zero — daria entrada de nada', () => {
      expect(() => converterCompra('2', 0)).toThrow(/>= 1/)
      expect(() => converterCompra('2', 1.5)).toThrow()
    })
  })

  it('multiplica por fator inteiro', () => {
    expect(multiplicarQtd('1.5', 4)).toBe('6.000')
    expect(multiplicarQtd('1.5', 0)).toBe('0.000')
    expect(() => multiplicarQtd('1', -1)).toThrow()
  })

  describe('formatarQuantidade — o que a recepção lê', () => {
    it('não mostra decimal inútil', () => {
      expect(formatarQuantidade('12.000', 'un')).toBe('12 un')
    })

    it('usa vírgula decimal e corta zero à direita', () => {
      expect(formatarQuantidade('0.500', 'ml')).toBe('0,5 ml')
      expect(formatarQuantidade('1.250', 'g')).toBe('1,25 g')
      expect(formatarQuantidade('0.001', 'g')).toBe('0,001 g')
    })

    it('funciona sem unidade e com negativo', () => {
      expect(formatarQuantidade('3.000')).toBe('3')
      expect(formatarQuantidade('-2.500', 'un')).toBe('-2,5 un')
    })
  })
})
