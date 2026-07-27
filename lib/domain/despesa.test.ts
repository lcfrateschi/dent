import { describe, expect, it } from 'vitest'
import {
  competenciaDaData,
  competenciaDoMes,
  competenciaSeguinte,
  competenciasDevidas,
  saldoDaDespesa,
  situacaoDaDespesa,
  vencimentoNaCompetencia,
} from './despesa'
import { ErroDominio } from './erros'

describe('saldo da despesa', () => {
  it('desconta os pagamentos', () => {
    expect(saldoDaDespesa({ valor: '1200.00', pagos: [] })).toBe('1200.00')
    expect(saldoDaDespesa({ valor: '1200.00', pagos: ['500.00'] })).toBe('700.00')
    expect(saldoDaDespesa({ valor: '1200.00', pagos: ['500.00', '700.00'] })).toBe('0.00')
  })

  it('soma em centavos, não em ponto flutuante', () => {
    // 0.1 + 0.2 = 0.30000000000000004 em float. Três vezes 33,33 tem de dar 99,99.
    expect(saldoDaDespesa({ valor: '100.00', pagos: ['33.33', '33.33', '33.33'] })).toBe('0.01')
  })

  it('ESTOURA se os pagamentos passarem do valor, em vez de devolver negativo', () => {
    // Saldo negativo em conta a pagar não é caso de borda: é dado corrompido. Devolver
    // -50 esconderia o problema atrás de um número que soma normalmente no relatório.
    expect(() => saldoDaDespesa({ valor: '100.00', pagos: ['150.00'] })).toThrowError(ErroDominio)
  })
})

describe('situação da despesa', () => {
  const base = { valor: '1000.00', vencimento: '2026-07-10', cancelada: false }
  const HOJE = '2026-07-27'

  it('aberta é sem pagamento e no prazo', () => {
    expect(situacaoDaDespesa({ ...base, vencimento: '2026-08-10', pagos: [] }, HOJE)).toBe('aberta')
  })

  it('parcial é com pagamento e no prazo', () => {
    expect(
      situacaoDaDespesa({ ...base, vencimento: '2026-08-10', pagos: ['400.00'] }, HOJE),
    ).toBe('parcial')
  })

  it('vencida é passar da data com saldo', () => {
    expect(situacaoDaDespesa({ ...base, pagos: [] }, HOJE)).toBe('vencida')
    expect(situacaoDaDespesa({ ...base, pagos: ['400.00'] }, HOJE)).toBe('vencida')
  })

  it('PAGA vence VENCIDA — atraso que já foi resolvido não é pendência', () => {
    // A ordem das perguntas é a decisão: uma conta de julho paga com 15 dias de atraso
    // não deve aparecer na fila de "correr atrás", senão a fila nunca esvazia.
    expect(situacaoDaDespesa({ ...base, pagos: ['1000.00'] }, HOJE)).toBe('paga')
  })

  it('CANCELADA vence tudo, inclusive vencida', () => {
    expect(situacaoDaDespesa({ ...base, pagos: [], cancelada: true }, HOJE)).toBe('cancelada')
  })

  it('vencer HOJE ainda não é vencida', () => {
    // O boleto do dia é pagável até o fim do dia. Tratar como vencida poria a conta na
    // fila de atrasadas na manhã do próprio vencimento.
    expect(situacaoDaDespesa({ ...base, vencimento: HOJE, pagos: [] }, HOJE)).toBe('aberta')
  })
})

describe('competência', () => {
  it('é sempre o dia 1', () => {
    expect(competenciaDoMes(2026, 7)).toBe('2026-07-01')
    expect(competenciaDoMes(2026, 12)).toBe('2026-12-01')
    expect(competenciaDaData('2026-07-19')).toBe('2026-07-01')
  })

  it('recusa mês e ano impossíveis', () => {
    expect(() => competenciaDoMes(2026, 0)).toThrowError(ErroDominio)
    expect(() => competenciaDoMes(2026, 13)).toThrowError(ErroDominio)
    expect(() => competenciaDoMes(1800, 7)).toThrowError(ErroDominio)
  })

  it('atravessa o ano', () => {
    expect(competenciaSeguinte('2026-12-01')).toBe('2027-01-01')
    expect(competenciaSeguinte('2026-07-01')).toBe('2026-08-01')
  })

  it('vencimento respeita o dia da regra e para em 28', () => {
    expect(vencimentoNaCompetencia('2026-02-01', 28)).toBe('2026-02-28')
    expect(vencimentoNaCompetencia('2026-07-01', 5)).toBe('2026-07-05')
    // 31 é recusado aqui e no banco: "dia 31" é uma regra que se comporta diferente em
    // fevereiro, e escorregar sem avisar é pior que recusar no cadastro.
    expect(() => vencimentoNaCompetencia('2026-07-01', 31)).toThrowError(ErroDominio)
  })
})

describe('competências devidas por uma regra recorrente', () => {
  const regra = { inicioEm: '2026-05-01', fimEm: null, diaVencimento: 10, ativo: true }

  it('lista do início até a data pedida, inclusive', () => {
    expect(competenciasDevidas(regra, '2026-07-27')).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
    ])
  })

  it('para no fim do contrato', () => {
    expect(competenciasDevidas({ ...regra, fimEm: '2026-06-30' }, '2026-07-27')).toEqual([
      '2026-05-01',
      '2026-06-01',
    ])
  })

  it('regra inativa não deve nada', () => {
    expect(competenciasDevidas({ ...regra, ativo: false }, '2026-07-27')).toEqual([])
  })

  it('regra que começa no futuro não deve nada — e isso é o normal', () => {
    // Cadastrar hoje o aluguel que começa mês que vem é o caso comum, não a exceção.
    expect(competenciasDevidas({ ...regra, inicioEm: '2026-09-01' }, '2026-07-27')).toEqual([])
  })

  it('começa e termina no mesmo mês', () => {
    expect(
      competenciasDevidas({ ...regra, inicioEm: '2026-07-03', fimEm: '2026-07-20' }, '2026-07-27'),
    ).toEqual(['2026-07-01'])
  })

  it('ESTOURA em vez de devolver mil competências quando a data de início está errada', () => {
    // `1926` em vez de `2026` é um erro de digitação plausível, e sem o teto o gerador
    // inseriria 1.200 despesas antes de alguém notar.
    expect(() => competenciasDevidas({ ...regra, inicioEm: '1926-01-01' }, '2026-07-27')).toThrowError(
      ErroDominio,
    )
  })
})
