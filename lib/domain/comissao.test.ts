import { describe, expect, it } from 'vitest'
import {
  type ExecucaoParaComissao,
  consolidarPorProfissional,
  explicarBase,
  rateioFecha,
  ratearComissao,
  totalDeComissao,
} from './comissao'
import { somar } from './dinheiro'
import { ErroDominio } from './erros'

const ana = (valor: string, pct = '40'): ExecucaoParaComissao => ({
  profissionalId: 'prof-ana',
  profissionalNome: 'Dra. Ana',
  comissaoPct: pct,
  valorExecutado: valor,
})

const bruno = (valor: string, pct = '30'): ExecucaoParaComissao => ({
  profissionalId: 'prof-bruno',
  profissionalNome: 'Dr. Bruno',
  comissaoPct: pct,
  valorExecutado: valor,
})

describe('um profissional só', () => {
  it('a base é o recebido inteiro', () => {
    const r = ratearComissao({ execucoes: [ana('500.00')], recebido: '100.00' })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ baseDeCalculo: '100.00', comissao: '40.00' })
  })

  it('recebido zero gera comissão zero, sem erro', () => {
    const r = ratearComissao({ execucoes: [ana('500.00')], recebido: '0.00' })
    expect(r[0]).toMatchObject({ baseDeCalculo: '0.00', comissao: '0.00' })
  })

  it('quitação total dá comissão sobre o valor inteiro', () => {
    const r = ratearComissao({ execucoes: [ana('500.00')], recebido: '500.00' })
    expect(r[0]!.comissao).toBe('200.00')
  })
})

describe('rateio entre profissionais — o problema central', () => {
  it('divide na proporção do valor executado, não em partes iguais', () => {
    // Ana executou 400 (80%), Bruno 100 (20%). Entraram 250.
    const r = ratearComissao({
      execucoes: [ana('400.00'), bruno('100.00')],
      recebido: '250.00',
    })
    const porId = new Map(r.map((x) => [x.profissionalId, x]))
    expect(porId.get('prof-ana')!.baseDeCalculo).toBe('200.00') // 80% de 250
    expect(porId.get('prof-bruno')!.baseDeCalculo).toBe('50.00') // 20% de 250
    // Comissões: 40% de 200 e 30% de 50.
    expect(porId.get('prof-ana')!.comissao).toBe('80.00')
    expect(porId.get('prof-bruno')!.comissao).toBe('15.00')
  })

  it('a soma das bases é EXATAMENTE o recebido, mesmo com divisão infinita', () => {
    // 100 / 3 não fecha em centavos; a sobra tem que ir para alguém.
    const casos: [string, ExecucaoParaComissao[]][] = [
      ['100.00', [ana('100.00'), bruno('100.00'), { ...bruno('100.00'), profissionalId: 'p3', profissionalNome: 'C' }]],
      ['0.10', [ana('1.00'), bruno('2.00')]],
      ['1000.00', [ana('333.33'), bruno('666.67')]],
      ['0.03', [ana('1.00'), bruno('1.00'), { ...ana('1.00'), profissionalId: 'p3', profissionalNome: 'C' }]],
      ['87654.21', [ana('12345.67'), bruno('7654.33')]],
    ]
    for (const [recebido, execucoes] of casos) {
      const r = ratearComissao({ execucoes, recebido })
      expect(somar(...r.map((x) => x.baseDeCalculo)), `recebido ${recebido}`).toBe(recebido)
      expect(rateioFecha(r, recebido), `recebido ${recebido}`).toBe(true)
    }
  })

  it('põe a sobra do arredondamento em quem executou mais', () => {
    // 10.00 entre 1/3 e 2/3: 3.33 e 6.66 somam 9.99; falta 1 centavo.
    const r = ratearComissao({
      execucoes: [ana('100.00'), bruno('200.00')],
      recebido: '10.00',
    })
    const porId = new Map(r.map((x) => [x.profissionalId, x]))
    // Bruno executou mais, leva a sobra.
    expect(porId.get('prof-bruno')!.baseDeCalculo).toBe('6.67')
    expect(porId.get('prof-ana')!.baseDeCalculo).toBe('3.33')
  })

  it('não depende da ORDEM das execuções na entrada', () => {
    const execucoes = [ana('400.00'), bruno('100.00')]
    const chave = (r: readonly { profissionalId: string; baseDeCalculo: string }[]) =>
      [...r].sort((a, b) => a.profissionalId.localeCompare(b.profissionalId))
        .map((x) => `${x.profissionalId}:${x.baseDeCalculo}`).join(',')
    expect(chave(ratearComissao({ execucoes, recebido: '250.00' }))).toBe(
      chave(ratearComissao({ execucoes: [...execucoes].reverse(), recebido: '250.00' })),
    )
  })

  it('agrupa vários itens do MESMO profissional', () => {
    // Ana fez dois procedimentos; conta como um só rateio.
    const r = ratearComissao({
      execucoes: [ana('200.00'), ana('200.00'), bruno('100.00')],
      recebido: '500.00',
    })
    expect(r).toHaveLength(2)
    const porId = new Map(r.map((x) => [x.profissionalId, x]))
    expect(porId.get('prof-ana')!.valorExecutado).toBe('400.00')
    expect(porId.get('prof-ana')!.baseDeCalculo).toBe('400.00')
    expect(porId.get('prof-bruno')!.baseDeCalculo).toBe('100.00')
  })

  it('respeita percentuais diferentes por profissional', () => {
    const r = ratearComissao({
      execucoes: [ana('500.00', '50'), bruno('500.00', '20')],
      recebido: '1000.00',
    })
    const porId = new Map(r.map((x) => [x.profissionalId, x]))
    expect(porId.get('prof-ana')!.comissao).toBe('250.00') // 50% de 500
    expect(porId.get('prof-bruno')!.comissao).toBe('100.00') // 20% de 500
  })

  it('comissão zero é válida — profissional sócio, por exemplo', () => {
    const r = ratearComissao({ execucoes: [ana('500.00', '0')], recebido: '500.00' })
    expect(r[0]).toMatchObject({ baseDeCalculo: '500.00', comissao: '0.00' })
  })
})

describe('a base é o RECEBIDO, não o executado', () => {
  it('procedimento executado e não pago não gera comissão', () => {
    const r = ratearComissao({ execucoes: [ana('1000.00')], recebido: '0.00' })
    expect(r[0]!.comissao).toBe('0.00')
    expect(r[0]!.valorExecutado).toBe('1000.00')
  })

  it('pagamento parcial gera comissão parcial', () => {
    // Metade recebida → metade da comissão.
    const r = ratearComissao({ execucoes: [ana('1000.00')], recebido: '500.00' })
    expect(r[0]!.comissao).toBe('200.00') // 40% de 500, não de 1000
  })

  it('explica a base escolhida em texto apresentável', () => {
    expect(explicarBase('valor_recebido')).toMatch(/conciliado/)
    expect(explicarBase('valor_recebido')).toMatch(/não pago ainda não gera/)
    expect(explicarBase('valor_executado')).toMatch(/independentemente/)
  })
})

describe('casos de borda', () => {
  it('nenhuma execução devolve lista vazia', () => {
    expect(ratearComissao({ execucoes: [], recebido: '100.00' })).toEqual([])
    expect(rateioFecha([], '0.00')).toBe(true)
    expect(rateioFecha([], '100.00')).toBe(false)
  })

  it('total executado zero não rateia nada, mas lista os profissionais', () => {
    const r = ratearComissao({ execucoes: [ana('0.00'), bruno('0.00')], recebido: '100.00' })
    expect(r).toHaveLength(2)
    for (const x of r) expect(x.baseDeCalculo).toBe('0.00')
  })

  it('recusa recebido negativo e executado negativo', () => {
    expect(() => ratearComissao({ execucoes: [ana('100.00')], recebido: '-10.00' })).toThrowError(
      ErroDominio,
    )
    expect(() => ratearComissao({ execucoes: [ana('-10.00')], recebido: '100.00' })).toThrowError(
      ErroDominio,
    )
  })

  it('recusa percentual fora da faixa', () => {
    for (const pct of ['-1', '101', 'abc']) {
      expect(
        () => ratearComissao({ execucoes: [ana('100.00', pct)], recebido: '100.00' }),
        pct,
      ).toThrowError(ErroDominio)
    }
  })

  it('soma o total de comissão a pagar', () => {
    const r = ratearComissao({
      execucoes: [ana('400.00', '40'), bruno('100.00', '30')],
      recebido: '500.00',
    })
    expect(totalDeComissao(r)).toBe('190.00') // 160 + 30
    expect(totalDeComissao([])).toBe('0.00')
  })
})

describe('consolidação do mês', () => {
  it('soma várias cobranças por profissional', () => {
    const c1 = ratearComissao({ execucoes: [ana('500.00')], recebido: '500.00' })
    const c2 = ratearComissao({ execucoes: [ana('300.00'), bruno('200.00')], recebido: '500.00' })

    const total = consolidarPorProfissional([c1, c2])
    const porId = new Map(total.map((x) => [x.profissionalId, x]))

    // Ana: 500 + 300 de base → 40% = 200 + 120 = 320
    expect(porId.get('prof-ana')!.baseDeCalculo).toBe('800.00')
    expect(porId.get('prof-ana')!.comissao).toBe('320.00')
    expect(porId.get('prof-ana')!.cobrancas).toBe(2)

    // Bruno: 200 de base → 30% = 60
    expect(porId.get('prof-bruno')!.baseDeCalculo).toBe('200.00')
    expect(porId.get('prof-bruno')!.comissao).toBe('60.00')
    expect(porId.get('prof-bruno')!.cobrancas).toBe(1)
  })

  it('ordena por comissão, do maior para o menor', () => {
    const total = consolidarPorProfissional([
      ratearComissao({ execucoes: [ana('100.00', '10'), bruno('900.00', '50')], recebido: '1000.00' }),
    ])
    expect(total[0]!.profissionalId).toBe('prof-bruno')
  })

  it('período sem nada devolve lista vazia', () => {
    expect(consolidarPorProfissional([])).toEqual([])
    expect(consolidarPorProfissional([[], []])).toEqual([])
  })

  it('não perde centavo ao consolidar muitas cobranças', () => {
    // 30 cobranças de 0.01 rateadas entre dois: a soma tem que ser exata.
    const rateios = Array.from({ length: 30 }, () =>
      ratearComissao({ execucoes: [ana('1.00'), bruno('1.00')], recebido: '0.01' }),
    )
    const total = consolidarPorProfissional(rateios)
    expect(somar(...total.map((t) => t.baseDeCalculo))).toBe('0.30')
  })
})
