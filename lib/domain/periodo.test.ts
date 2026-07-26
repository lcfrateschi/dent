import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  anoDe,
  diaSemanaDe,
  diasDoPeriodo,
  diasEntre,
  mesDe,
  periodoAnterior,
  periodoLivre,
  resolverPeriodo,
  trimestreDe,
} from './periodo'

describe('períodos de calendário', () => {
  it('mês', () => {
    expect(mesDe('2026-07-15')).toMatchObject({
      de: '2026-07-01',
      ate: '2026-07-31',
      rotulo: 'julho de 2026',
    })
  })

  it('mês com 30 dias e fevereiro', () => {
    expect(mesDe('2026-04-10').ate).toBe('2026-04-30')
    expect(mesDe('2026-02-10').ate).toBe('2026-02-28')
    // 2028 é bissexto.
    expect(mesDe('2028-02-10').ate).toBe('2028-02-29')
  })

  it('trimestre', () => {
    expect(trimestreDe('2026-07-15')).toMatchObject({
      de: '2026-07-01',
      ate: '2026-09-30',
      rotulo: '3º trimestre de 2026',
    })
    expect(trimestreDe('2026-01-01').ate).toBe('2026-03-31')
    expect(trimestreDe('2026-12-31')).toMatchObject({ de: '2026-10-01', ate: '2026-12-31' })
  })

  it('ano', () => {
    expect(anoDe('2026-07-15')).toMatchObject({ de: '2026-01-01', ate: '2026-12-31', rotulo: '2026' })
  })

  it('período livre é validado', () => {
    expect(periodoLivre('2026-01-05', '2026-01-10').rotulo).toBe('05/01/2026 a 10/01/2026')
    expect(() => periodoLivre('2026-01-10', '2026-01-05')).toThrowError(ErroDominio)
    expect(() => periodoLivre('2026-13-01', '2026-13-05')).toThrowError(ErroDominio)
    // Um dia só é período válido.
    expect(periodoLivre('2026-01-05', '2026-01-05').de).toBe('2026-01-05')
  })

  it('recusa período absurdamente longo', () => {
    expect(() => periodoLivre('2000-01-01', '2026-01-01')).toThrowError(ErroDominio)
  })
})

describe('período anterior equivalente', () => {
  it('mês anterior é o mês do calendário, não "31 dias atrás"', () => {
    // "Os 31 dias anteriores" a julho pegaria parte de junho e parte de julho,
    // e a variação não significaria nada.
    expect(periodoAnterior(mesDe('2026-07-15'))).toMatchObject({
      de: '2026-06-01',
      ate: '2026-06-30',
      rotulo: 'junho de 2026',
    })
  })

  it('atravessa a virada do ano', () => {
    expect(periodoAnterior(mesDe('2026-01-10'))).toMatchObject({
      de: '2025-12-01',
      ate: '2025-12-31',
    })
  })

  it('março → fevereiro, respeitando o tamanho do mês', () => {
    expect(periodoAnterior(mesDe('2026-03-31')).ate).toBe('2026-02-28')
  })

  it('trimestre e ano anteriores', () => {
    expect(periodoAnterior(trimestreDe('2026-07-01'))).toMatchObject({
      de: '2026-04-01',
      ate: '2026-06-30',
    })
    expect(periodoAnterior(trimestreDe('2026-01-01'))).toMatchObject({
      de: '2025-10-01',
      ate: '2025-12-31',
    })
    expect(periodoAnterior(anoDe('2026-05-05'))).toMatchObject({
      de: '2025-01-01',
      ate: '2025-12-31',
    })
  })

  it('período livre volta a mesma quantidade de dias, sem sobrepor', () => {
    const p = periodoLivre('2026-07-10', '2026-07-19') // 10 dias
    const anterior = periodoAnterior(p)
    expect(diasEntre(anterior.de, anterior.ate)).toBe(10)
    expect(anterior.ate).toBe('2026-07-09')
    expect(anterior.de).toBe('2026-06-30')
  })
})

describe('resolver a partir da URL', () => {
  it('mês é o padrão', () => {
    expect(resolverPeriodo('2026-07-15').tipo).toBe('mes')
    expect(resolverPeriodo('2026-07-15', {}).tipo).toBe('mes')
  })

  it('respeita o tipo pedido', () => {
    expect(resolverPeriodo('2026-07-15', { tipo: 'ano' }).tipo).toBe('ano')
    expect(resolverPeriodo('2026-07-15', { tipo: 'trimestre' }).tipo).toBe('trimestre')
  })

  it('aceita período livre por de/ate', () => {
    const p = resolverPeriodo('2026-07-15', { de: '2026-01-01', ate: '2026-01-31' })
    expect(p).toMatchObject({ tipo: 'livre', de: '2026-01-01', ate: '2026-01-31' })
  })

  it('parâmetro inválido na URL cai no padrão em vez de estourar', () => {
    // A URL vem de fora. Um relatório não deve dar 500 por parâmetro editado.
    for (const p of [
      { de: 'xx', ate: 'yy' },
      { de: '2026-99-99', ate: '2026-99-99' },
      { de: '2026-07-31', ate: '2026-07-01' },
      { tipo: 'livre' },
      { tipo: 'inexistente' },
      { de: '2026-07-01' },
      { de: '1900-01-01', ate: '2026-01-01' },
    ]) {
      expect(resolverPeriodo('2026-07-15', p).tipo, JSON.stringify(p)).toBe('mes')
    }
  })
})

describe('dias', () => {
  it('conta as duas pontas', () => {
    expect(diasEntre('2026-07-01', '2026-07-01')).toBe(1)
    expect(diasEntre('2026-07-01', '2026-07-31')).toBe(31)
    expect(diasEntre('2026-01-01', '2026-12-31')).toBe(365)
    expect(diasEntre('2028-01-01', '2028-12-31')).toBe(366)
  })

  it('enumera o período', () => {
    const dias = diasDoPeriodo(periodoLivre('2026-07-30', '2026-08-02'))
    expect(dias).toEqual(['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'])
  })

  it('enumera um mês inteiro', () => {
    expect(diasDoPeriodo(mesDe('2026-07-01'))).toHaveLength(31)
  })

  it('dia da semana não depende do fuso do servidor', () => {
    // 26/07/2026 é domingo.
    expect(diaSemanaDe('2026-07-26')).toBe(0)
    expect(diaSemanaDe('2026-07-27')).toBe(1)
    expect(diaSemanaDe('2026-07-31')).toBe(5)
  })
})
