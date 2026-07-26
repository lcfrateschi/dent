import { describe, expect, it } from 'vitest'
import { somar } from './dinheiro'
import { ErroDominio } from './erros'
import { gerarParcelas, somaConfere } from './parcelamento'

describe('geração de parcelas', () => {
  it('gera a quantidade pedida com vencimento mensal', () => {
    const p = gerarParcelas({ total: '300.00', quantidade: 3, primeiroVencimento: '2026-08-10' })
    expect(p).toEqual([
      { numero: 1, vencimento: '2026-08-10', valor: '100.00' },
      { numero: 2, vencimento: '2026-09-10', valor: '100.00' },
      { numero: 3, vencimento: '2026-10-10', valor: '100.00' },
    ])
  })

  it('põe a sobra do arredondamento na primeira parcela', () => {
    const p = gerarParcelas({ total: '100.00', quantidade: 3, primeiroVencimento: '2026-08-10' })
    expect(p.map((x) => x.valor)).toEqual(['33.34', '33.33', '33.33'])
  })

  it('a soma das parcelas é sempre o total — a invariante que o trigger checa no banco', () => {
    const casos = ['100.00', '0.13', '19.99', '4999.99', '1.00', '87654.21', '0.12']
    for (const total of casos) {
      for (const quantidade of [1, 2, 3, 6, 12]) {
        const p = gerarParcelas({ total, quantidade, primeiroVencimento: '2026-01-31' })
        expect(somar(...p.map((x) => x.valor)), `${total} em ${quantidade}x`).toBe(total)
        expect(somaConfere(total, p), `${total} em ${quantidade}x`).toBe(true)
      }
    }
  })

  it('nenhuma parcela sai com valor zero — o banco tem CHECK valor > 0', () => {
    const p = gerarParcelas({ total: '0.03', quantidade: 3, primeiroVencimento: '2026-08-10' })
    expect(p.map((x) => x.valor)).toEqual(['0.01', '0.01', '0.01'])
    for (const x of p) expect(Number(x.valor)).toBeGreaterThan(0)
  })

  it('faz clamp de fim de mês sem acumular', () => {
    const p = gerarParcelas({ total: '400.00', quantidade: 4, primeiroVencimento: '2026-01-31' })
    expect(p.map((x) => x.vencimento)).toEqual([
      '2026-01-31',
      '2026-02-28', // fevereiro não tem 31
      '2026-03-31', // volta ao 31, não fica no 28
      '2026-04-30',
    ])
  })

  it('respeita intervalo diferente de mensal', () => {
    const p = gerarParcelas({
      total: '300.00',
      quantidade: 3,
      primeiroVencimento: '2026-01-15',
      intervaloMeses: 2,
    })
    expect(p.map((x) => x.vencimento)).toEqual(['2026-01-15', '2026-03-15', '2026-05-15'])
  })

  it('parcela única é o total à vista', () => {
    const p = gerarParcelas({ total: '150.75', quantidade: 1, primeiroVencimento: '2026-08-10' })
    expect(p).toEqual([{ numero: 1, vencimento: '2026-08-10', valor: '150.75' }])
  })

  it('rejeita total que não cobre um centavo por parcela', () => {
    try {
      gerarParcelas({ total: '0.02', quantidade: 3, primeiroVencimento: '2026-08-10' })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('TOTAL_INSUFICIENTE')
    }
  })

  it('rejeita entradas inválidas', () => {
    const base = { total: '100.00', primeiroVencimento: '2026-08-10' }
    expect(() => gerarParcelas({ ...base, quantidade: 0 })).toThrowError(ErroDominio)
    expect(() => gerarParcelas({ ...base, quantidade: 61 })).toThrowError(ErroDominio)
    expect(() => gerarParcelas({ ...base, quantidade: 2.5 })).toThrowError(ErroDominio)
    expect(() => gerarParcelas({ ...base, quantidade: 3, intervaloMeses: 0 })).toThrowError(ErroDominio)
    expect(() => gerarParcelas({ total: '0.00', quantidade: 1, primeiroVencimento: '2026-08-10' })).toThrowError(ErroDominio)
    expect(() => gerarParcelas({ total: '-10.00', quantidade: 1, primeiroVencimento: '2026-08-10' })).toThrowError(ErroDominio)
    expect(() => gerarParcelas({ ...base, quantidade: 3, primeiroVencimento: '10/08/2026' })).toThrowError(ErroDominio)
  })
})

describe('somaConfere', () => {
  it('detecta divergência', () => {
    const p = [{ numero: 1, vencimento: '2026-08-10', valor: '99.99' }]
    expect(somaConfere('100.00', p)).toBe(false)
    expect(somaConfere('99.99', p)).toBe(true)
  })

  it('lista vazia nunca confere', () => {
    expect(somaConfere('100.00', [])).toBe(false)
  })
})
