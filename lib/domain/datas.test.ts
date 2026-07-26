import { describe, expect, it } from 'vitest'
import {
  addDias,
  addMeses,
  comparaData,
  diasNoMes,
  ehAnoBissexto,
  ehMenorDeIdade,
  idadeEm,
  parseData,
} from './datas'
import { ErroDominio } from './erros'

describe('parse de data civil', () => {
  it('aceita YYYY-MM-DD', () => {
    expect(parseData('2026-07-26')).toEqual({ ano: 2026, mes: 7, dia: 26 })
  })

  it('rejeita formato e datas inexistentes', () => {
    for (const ruim of ['', '26/07/2026', '2026-7-26', '2026-13-01', '2026-02-30', '2025-02-29']) {
      expect(() => parseData(ruim), `deveria rejeitar "${ruim}"`).toThrowError(ErroDominio)
    }
  })

  it('aceita 29 de fevereiro em ano bissexto', () => {
    expect(() => parseData('2028-02-29')).not.toThrow()
  })
})

describe('calendário', () => {
  it('identifica ano bissexto incluindo a regra dos séculos', () => {
    expect(ehAnoBissexto(2028)).toBe(true)
    expect(ehAnoBissexto(2027)).toBe(false)
    expect(ehAnoBissexto(1900)).toBe(false) // divisível por 100, não por 400
    expect(ehAnoBissexto(2000)).toBe(true) // divisível por 400
  })

  it('conta dias no mês', () => {
    expect(diasNoMes(2026, 2)).toBe(28)
    expect(diasNoMes(2028, 2)).toBe(29)
    expect(diasNoMes(2026, 4)).toBe(30)
    expect(diasNoMes(2026, 12)).toBe(31)
  })
})

describe('addMeses — vencimento de parcela', () => {
  it('soma mês simples', () => {
    expect(addMeses('2026-07-26', 1)).toBe('2026-08-26')
    expect(addMeses('2026-07-26', 6)).toBe('2027-01-26')
    expect(addMeses('2026-07-26', 0)).toBe('2026-07-26')
  })

  it('faz clamp no último dia do mês de destino', () => {
    expect(addMeses('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMeses('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMeses('2026-03-31', 1)).toBe('2026-04-30')
  })

  it('não acumula o clamp, porque parte sempre da data original', () => {
    // Este é o bug clássico: 31/jan → 28/fev → 28/mar. O correto é voltar ao 31.
    expect(addMeses('2026-01-31', 2)).toBe('2026-03-31')
    expect(addMeses('2026-01-31', 3)).toBe('2026-04-30')
    expect(addMeses('2026-01-31', 4)).toBe('2026-05-31')
  })

  it('atravessa o ano', () => {
    expect(addMeses('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMeses('2026-12-31', 14)).toBe('2028-02-29')
  })

  it('aceita meses negativos', () => {
    expect(addMeses('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMeses('2026-01-15', -1)).toBe('2025-12-15')
  })
})

describe('addDias', () => {
  it('atravessa mês, ano e fevereiro bissexto', () => {
    expect(addDias('2026-07-26', 6)).toBe('2026-08-01')
    expect(addDias('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDias('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDias('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDias('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('não desliza um dia por causa de fuso — o motivo de não usar Date direto', () => {
    // Em BRT (UTC-3), new Date('2026-03-01').getDate() daria 28/fev.
    expect(addDias('2026-03-01', 0)).toBe('2026-03-01')
    expect(addDias('2026-01-01', 0)).toBe('2026-01-01')
  })
})

describe('comparação e idade', () => {
  it('compara datas civis', () => {
    expect(comparaData('2026-07-26', '2026-07-26')).toBe(0)
    expect(comparaData('2026-07-25', '2026-07-26')).toBe(-1)
    expect(comparaData('2026-08-01', '2026-07-31')).toBe(1)
  })

  it('calcula idade em anos completos', () => {
    expect(idadeEm('2000-07-26', '2026-07-26')).toBe(26) // aniversário hoje
    expect(idadeEm('2000-07-27', '2026-07-26')).toBe(25) // aniversário amanhã
    expect(idadeEm('2000-08-01', '2026-07-26')).toBe(25)
    expect(idadeEm('2026-07-26', '2026-07-26')).toBe(0) // recém-nascido
  })

  it('identifica menor de idade — define quem assina o consentimento', () => {
    expect(ehMenorDeIdade('2010-01-01', '2026-07-26')).toBe(true)
    expect(ehMenorDeIdade('2008-07-26', '2026-07-26')).toBe(false) // faz 18 hoje
    expect(ehMenorDeIdade('2008-07-27', '2026-07-26')).toBe(true) // faz 18 amanhã
  })
})
