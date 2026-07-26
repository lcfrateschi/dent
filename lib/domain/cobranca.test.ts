import { describe, expect, it } from 'vitest'
import {
  type ParcelaParaSituacao,
  type PagamentoDaParcela,
  diasDeAtraso,
  exigirPagamentoCabe,
  fracaoConciliada,
  resumirCobranca,
  saldoDaParcela,
  situacaoDaParcela,
  totalConciliado,
  totalPago,
} from './cobranca'
import { ErroDominio } from './erros'

const HOJE = '2026-10-15'

const pag = (valor: string, over: Partial<PagamentoDaParcela> = {}): PagamentoDaParcela => ({
  valor,
  estornadoEm: null,
  conciliado: true,
  ...over,
})

const parcela = (over: Partial<ParcelaParaSituacao> = {}): ParcelaParaSituacao => ({
  valor: '100.00',
  vencimento: '2026-10-20',
  status: 'aberta',
  pagamentos: [],
  ...over,
})

describe('soma dos pagamentos', () => {
  it('soma os não estornados', () => {
    expect(totalPago([pag('30.00'), pag('20.00')])).toBe('50.00')
    expect(totalPago([])).toBe('0.00')
  })

  it('IGNORA estornado — mas o histórico permanece na lista', () => {
    const ps = [pag('30.00'), pag('50.00', { estornadoEm: new Date('2026-10-10') })]
    expect(totalPago(ps)).toBe('30.00')
    expect(ps).toHaveLength(2)
  })

  it('só o CONCILIADO conta como recebido de verdade', () => {
    // Cheque lançado mas não compensado aparece como pagamento sem ser dinheiro.
    const ps = [pag('30.00'), pag('50.00', { conciliado: false })]
    expect(totalPago(ps)).toBe('80.00')
    expect(totalConciliado(ps)).toBe('30.00')
  })

  it('estornado não conta nem como conciliado', () => {
    const ps = [pag('50.00', { conciliado: true, estornadoEm: new Date('2026-10-10') })]
    expect(totalConciliado(ps)).toBe('0.00')
  })
})

describe('situação da parcela', () => {
  it('sem pagamento e no prazo é aberta', () => {
    expect(situacaoDaParcela(parcela(), HOJE)).toBe('aberta')
  })

  it('com pagamento parcial e no prazo é parcial', () => {
    expect(situacaoDaParcela(parcela({ pagamentos: [pag('40.00')] }), HOJE)).toBe('parcial')
  })

  it('quitada é paga', () => {
    expect(situacaoDaParcela(parcela({ pagamentos: [pag('100.00')] }), HOJE)).toBe('paga')
    // Vários pagamentos que somam o valor.
    expect(
      situacaoDaParcela(parcela({ pagamentos: [pag('40.00'), pag('60.00')] }), HOJE),
    ).toBe('paga')
  })

  it('vence NO dia — o último dia ainda está aberto', () => {
    expect(situacaoDaParcela(parcela({ vencimento: '2026-10-15' }), HOJE)).toBe('aberta')
    expect(situacaoDaParcela(parcela({ vencimento: '2026-10-14' }), HOJE)).toBe('vencida')
  })

  it('PAGA vence VENCIDA — quem pagou com atraso não é inadimplente hoje', () => {
    // Sem esta precedência, a recepção cobraria quem já quitou.
    const p = parcela({ vencimento: '2026-09-01', pagamentos: [pag('100.00')] })
    expect(situacaoDaParcela(p, HOJE)).toBe('paga')
  })

  it('parcial e vencida é VENCIDA — ainda há saldo em atraso', () => {
    const p = parcela({ vencimento: '2026-09-01', pagamentos: [pag('40.00')] })
    expect(situacaoDaParcela(p, HOJE)).toBe('vencida')
  })

  it('cancelada ignora pagamento e vencimento', () => {
    const p = parcela({ status: 'cancelada', vencimento: '2026-01-01', pagamentos: [pag('100.00')] })
    expect(situacaoDaParcela(p, HOJE)).toBe('cancelada')
  })

  it('pagamento estornado devolve a parcela para vencida', () => {
    const p = parcela({
      vencimento: '2026-09-01',
      pagamentos: [pag('100.00', { estornadoEm: new Date('2026-10-01') })],
    })
    expect(situacaoDaParcela(p, HOJE)).toBe('vencida')
  })

  it('pagamento não conciliado ainda conta para quitar a parcela', () => {
    // Conciliação é sobre comissão, não sobre a dívida do paciente estar quitada.
    const p = parcela({ pagamentos: [pag('100.00', { conciliado: false })] })
    expect(situacaoDaParcela(p, HOJE)).toBe('paga')
  })
})

describe('saldo e atraso', () => {
  it('calcula o saldo', () => {
    expect(saldoDaParcela(parcela())).toBe('100.00')
    expect(saldoDaParcela(parcela({ pagamentos: [pag('40.00')] }))).toBe('60.00')
    expect(saldoDaParcela(parcela({ pagamentos: [pag('100.00')] }))).toBe('0.00')
  })

  it('conta os dias de atraso', () => {
    expect(diasDeAtraso(parcela({ vencimento: '2026-10-05' }), HOJE)).toBe(10)
    expect(diasDeAtraso(parcela({ vencimento: '2026-10-14' }), HOJE)).toBe(1)
  })

  it('não conta atraso no que não está vencido', () => {
    expect(diasDeAtraso(parcela({ vencimento: '2026-10-20' }), HOJE)).toBe(0)
    expect(diasDeAtraso(parcela({ vencimento: '2026-10-15' }), HOJE)).toBe(0)
    // Paga com atraso: zero, porque não está vencida.
    expect(
      diasDeAtraso(parcela({ vencimento: '2026-09-01', pagamentos: [pag('100.00')] }), HOJE),
    ).toBe(0)
  })
})

describe('resumo da cobrança', () => {
  const tresParcelas: ParcelaParaSituacao[] = [
    // 1ª: paga
    parcela({ valor: '100.00', vencimento: '2026-08-20', pagamentos: [pag('100.00')] }),
    // 2ª: vencida com pagamento parcial
    parcela({ valor: '100.00', vencimento: '2026-09-20', pagamentos: [pag('30.00')] }),
    // 3ª: aberta, no prazo
    parcela({ valor: '100.00', vencimento: '2026-11-20' }),
  ]

  it('consolida total, pago e a receber', () => {
    const r = resumirCobranca(tresParcelas, HOJE)
    expect(r.total).toBe('300.00')
    expect(r.pago).toBe('130.00')
    expect(r.aReceber).toBe('170.00')
  })

  it('DISTINGUE em atraso de a receber', () => {
    // Só o saldo da parcela VENCIDA está em atraso: 70.
    // Confundir com `aReceber` (170) faria a clínica inteira parecer inadimplente.
    const r = resumirCobranca(tresParcelas, HOJE)
    expect(r.emAtraso).toBe('70.00')
    expect(r.aReceber).toBe('170.00')
  })

  it('conta parcelas por situação', () => {
    const r = resumirCobranca(tresParcelas, HOJE)
    expect(r).toMatchObject({ parcelas: 3, parcelasPagas: 1, parcelasVencidas: 1 })
  })

  it('separa conciliado de pago', () => {
    const r = resumirCobranca(
      [
        parcela({ valor: '100.00', pagamentos: [pag('100.00', { conciliado: false })] }),
        parcela({ valor: '100.00', pagamentos: [pag('100.00')] }),
      ],
      HOJE,
    )
    expect(r.pago).toBe('200.00')
    expect(r.conciliado).toBe('100.00')
  })

  it('marca quitada só quando TODAS estão pagas', () => {
    expect(resumirCobranca(tresParcelas, HOJE).quitada).toBe(false)
    const todas = tresParcelas.map((p) => ({ ...p, pagamentos: [pag(p.valor)] }))
    expect(resumirCobranca(todas, HOJE).quitada).toBe(true)
  })

  it('ignora parcelas canceladas no total', () => {
    const r = resumirCobranca(
      [
        parcela({ valor: '100.00', pagamentos: [pag('100.00')] }),
        parcela({ valor: '999.00', status: 'cancelada' }),
      ],
      HOJE,
    )
    expect(r.total).toBe('100.00')
    expect(r.parcelas).toBe(1)
    expect(r.quitada).toBe(true)
  })

  it('cobrança vazia não é "quitada"', () => {
    const r = resumirCobranca([], HOJE)
    expect(r).toMatchObject({ total: '0.00', aReceber: '0.00', quitada: false })
  })
})

describe('quanto cabe na parcela', () => {
  it('aceita valor até o saldo', () => {
    const p = parcela({ pagamentos: [pag('40.00')] })
    expect(() => exigirPagamentoCabe(p, '60.00')).not.toThrow()
    expect(() => exigirPagamentoCabe(p, '10.00')).not.toThrow()
  })

  it('recusa valor acima do saldo, dizendo qual é o saldo', () => {
    const p = parcela({ pagamentos: [pag('40.00')] })
    try {
      exigirPagamentoCabe(p, '61.00')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('PAGAMENTO_EXCEDE_SALDO')
      expect((e as Error).message).toContain('60.00')
    }
  })

  it('recusa parcela já quitada e parcela cancelada', () => {
    try {
      exigirPagamentoCabe(parcela({ pagamentos: [pag('100.00')] }), '1.00')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('PARCELA_QUITADA')
    }
    try {
      exigirPagamentoCabe(parcela({ status: 'cancelada' }), '1.00')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('PARCELA_CANCELADA')
    }
  })

  it('recusa valor zero ou negativo', () => {
    for (const v of ['0.00', '-10.00']) {
      expect(() => exigirPagamentoCabe(parcela(), v), v).toThrowError(ErroDominio)
    }
  })
})

describe('fração conciliada — multiplicador do rateio de comissão', () => {
  it('devolve o percentual do total já conciliado', () => {
    expect(Number(fracaoConciliada('500.00', '250.00'))).toBeCloseTo(50, 4)
    expect(Number(fracaoConciliada('300.00', '100.00'))).toBeCloseTo(33.3333, 3)
    expect(Number(fracaoConciliada('100.00', '100.00'))).toBeCloseTo(100, 4)
  })

  it('total zero não divide por zero', () => {
    expect(fracaoConciliada('0.00', '0.00')).toBe('0')
  })
})
