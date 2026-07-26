import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  DIAS_VALIDADE_PADRAO,
  type LinhaOrcamento,
  type StatusOrcamento,
  calcularBruto,
  calcularTotais,
  diasParaVencer,
  ehEditavel,
  estaVencido,
  exigirTransicao,
  podeTransicionar,
  statusApresentado,
  totaisConferem,
  validadeSugerida,
  valorParaOPaciente,
} from './orcamento'

const TODOS: StatusOrcamento[] = ['rascunho', 'enviado', 'aprovado', 'recusado', 'expirado']

const linha = (valorUnitario: string, quantidade = 1): LinhaOrcamento => ({
  descricao: 'Procedimento',
  quantidade,
  valorUnitario,
})

describe('máquina de estados', () => {
  it('percorre o caminho normal', () => {
    expect(podeTransicionar('rascunho', 'enviado')).toBe(true)
    expect(podeTransicionar('enviado', 'aprovado')).toBe(true)
    expect(podeTransicionar('enviado', 'recusado')).toBe(true)
    expect(podeTransicionar('enviado', 'expirado')).toBe(true)
  })

  it('não deixa aprovar sem enviar — o paciente precisa ter recebido', () => {
    expect(podeTransicionar('rascunho', 'aprovado')).toBe(false)
    expect(podeTransicionar('rascunho', 'recusado')).toBe(false)
  })

  it('trata aprovado, recusado e expirado como terminais', () => {
    for (const terminal of ['aprovado', 'recusado', 'expirado'] as const) {
      for (const destino of TODOS) {
        expect(podeTransicionar(terminal, destino), `${terminal} → ${destino}`).toBe(false)
      }
    }
  })

  it('não deixa desfazer envio — documento entregue não volta a rascunho', () => {
    expect(podeTransicionar('enviado', 'rascunho')).toBe(false)
  })

  it('a mensagem de estado final orienta a gerar outro orçamento', () => {
    try {
      exigirTransicao('aprovado', 'enviado')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('ORCAMENTO_TRANSICAO_INVALIDA')
      expect((e as Error).message).toMatch(/Gere um novo orçamento/)
    }
  })

  it('só rascunho é editável', () => {
    expect(ehEditavel('rascunho')).toBe(true)
    for (const s of ['enviado', 'aprovado', 'recusado', 'expirado'] as const) {
      expect(ehEditavel(s), s).toBe(false)
    }
  })
})

describe('validade', () => {
  it('sugere 30 dias por padrão', () => {
    expect(DIAS_VALIDADE_PADRAO).toBe(30)
    expect(validadeSugerida('2026-09-01')).toBe('2026-10-01')
  })

  it('aceita prazo customizado e atravessa o mês', () => {
    expect(validadeSugerida('2026-09-01', 15)).toBe('2026-09-16')
    expect(validadeSugerida('2026-12-20', 30)).toBe('2027-01-19')
  })

  it('rejeita prazo absurdo', () => {
    for (const dias of [0, -5, 366, 1.5]) {
      expect(() => validadeSugerida('2026-09-01', dias), String(dias)).toThrowError(ErroDominio)
    }
  })

  it('detecta vencimento, e o último dia ainda vale', () => {
    expect(estaVencido('2026-10-01', '2026-09-30')).toBe(false)
    // Vence NO dia 01: o documento é válido até o fim dele.
    expect(estaVencido('2026-10-01', '2026-10-01')).toBe(false)
    expect(estaVencido('2026-10-01', '2026-10-02')).toBe(true)
  })

  it('conta os dias restantes, negativo quando já venceu', () => {
    expect(diasParaVencer('2026-10-01', '2026-09-24')).toBe(7)
    expect(diasParaVencer('2026-10-01', '2026-10-01')).toBe(0)
    expect(diasParaVencer('2026-10-01', '2026-10-06')).toBe(-5)
  })
})

describe('status apresentado', () => {
  it('mostra enviado vencido como expirado, sem gravar nada', () => {
    expect(statusApresentado('enviado', '2026-10-01', '2026-10-05')).toBe('expirado')
    expect(statusApresentado('enviado', '2026-10-01', '2026-09-20')).toBe('enviado')
  })

  it('NÃO expira o que já foi decidido', () => {
    // Aprovado em setembro continua aprovado em dezembro.
    expect(statusApresentado('aprovado', '2026-10-01', '2026-12-01')).toBe('aprovado')
    expect(statusApresentado('recusado', '2026-10-01', '2026-12-01')).toBe('recusado')
  })

  it('não expira rascunho — ainda não foi entregue a ninguém', () => {
    expect(statusApresentado('rascunho', '2026-10-01', '2026-12-01')).toBe('rascunho')
  })
})

describe('totais', () => {
  it('soma linhas com quantidade', () => {
    expect(calcularBruto([linha('230.00'), linha('300.00')])).toBe('530.00')
    expect(calcularBruto([linha('230.00', 3)])).toBe('690.00')
  })

  it('devolve zero para orçamento vazio', () => {
    expect(calcularBruto([])).toBe('0.00')
  })

  it('não perde centavo em soma longa', () => {
    // 0.01 somado 100 vezes deve dar exatamente 1.00.
    const linhas = Array.from({ length: 100 }, () => linha('0.01'))
    expect(calcularBruto(linhas)).toBe('1.00')
  })

  it('aplica desconto em valor', () => {
    const t = calcularTotais([linha('1000.00')], { tipo: 'valor', valor: '150.00' })
    expect(t).toEqual({ valorBruto: '1000.00', desconto: '150.00', valorTotal: '850.00' })
  })

  it('converte percentual em valor, arredondando ao centavo', () => {
    const t = calcularTotais([linha('1000.00')], { tipo: 'percentual', pct: '10' })
    expect(t.desconto).toBe('100.00')
    expect(t.valorTotal).toBe('900.00')

    // 7,5% de 333.33 = 24.99975 → 25.00
    const t2 = calcularTotais([linha('333.33')], { tipo: 'percentual', pct: '7.5' })
    expect(t2.desconto).toBe('25.00')
    expect(t2.valorTotal).toBe('308.33')
  })

  it('sem desconto o total é o bruto', () => {
    const t = calcularTotais([linha('230.00'), linha('300.00')])
    expect(t).toEqual({ valorBruto: '530.00', desconto: '0.00', valorTotal: '530.00' })
  })

  it('aceita desconto de 100%', () => {
    const t = calcularTotais([linha('500.00')], { tipo: 'percentual', pct: '100' })
    expect(t).toEqual({ valorBruto: '500.00', desconto: '500.00', valorTotal: '0.00' })
  })

  it('recusa desconto maior que o bruto — o CHECK do banco exige total >= 0', () => {
    try {
      calcularTotais([linha('100.00')], { tipo: 'valor', valor: '150.00' })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('DESCONTO_MAIOR_QUE_TOTAL')
    }
  })

  it('recusa desconto negativo e percentual fora da faixa', () => {
    expect(() => calcularTotais([linha('100.00')], { tipo: 'valor', valor: '-10.00' })).toThrowError(
      ErroDominio,
    )
    for (const pct of ['-1', '101', 'abc']) {
      expect(
        () => calcularTotais([linha('100.00')], { tipo: 'percentual', pct }),
        pct,
      ).toThrowError(ErroDominio)
    }
  })

  it('totaisConferem valida a mesma regra do banco', () => {
    const linhas = [linha('230.00'), linha('300.00', 2)]
    const t = calcularTotais(linhas, { tipo: 'valor', valor: '30.00' })
    expect(totaisConferem(t, linhas)).toBe(true)
    // Bruto adulterado é recusado.
    expect(totaisConferem({ ...t, valorBruto: '999.00' }, linhas)).toBe(false)
    // Total incoerente com bruto menos desconto é recusado.
    expect(totaisConferem({ ...t, valorTotal: '1.00' }, linhas)).toBe(false)
  })
})

describe('valor que o paciente paga', () => {
  it('no particular é o valor de tabela', () => {
    expect(valorParaOPaciente({ cobertura: 'particular', valorTabela: '350.00' })).toBe('350.00')
  })

  it('no convênio com cobertura integral o paciente não paga nada', () => {
    expect(
      valorParaOPaciente({ cobertura: 'convenio', valorConvenio: '120.00', coberturaPct: '100' }),
    ).toBe('0.00')
  })

  it('no convênio com coparticipação o paciente paga a fatia não coberta', () => {
    // 70% coberto de 200.00 → paciente paga 60.00.
    expect(
      valorParaOPaciente({ cobertura: 'convenio', valorConvenio: '200.00', coberturaPct: '70' }),
    ).toBe('60.00')
  })

  it('cobertura zero: o paciente paga tudo, mas o item segue sendo de convênio', () => {
    expect(
      valorParaOPaciente({ cobertura: 'convenio', valorConvenio: '80.00', coberturaPct: '0' }),
    ).toBe('80.00')
  })

  it('arredonda a coparticipação ao centavo', () => {
    // 33.33% de 10.00 coberto = 3.33 → paciente paga 6.67.
    expect(
      valorParaOPaciente({ cobertura: 'convenio', valorConvenio: '10.00', coberturaPct: '33.33' }),
    ).toBe('6.67')
  })

  it('rejeita cobertura fora da faixa', () => {
    for (const pct of ['-1', '101', 'x']) {
      expect(
        () => valorParaOPaciente({ cobertura: 'convenio', valorConvenio: '100.00', coberturaPct: pct }),
        pct,
      ).toThrowError(ErroDominio)
    }
  })

  it('um orçamento misto soma particular e coparticipação corretamente', () => {
    // Cenário real: restauração particular + limpeza coberta 80% pelo convênio.
    const linhas: LinhaOrcamento[] = [
      { descricao: 'Restauração', quantidade: 1, valorUnitario: valorParaOPaciente({ cobertura: 'particular', valorTabela: '300.00' }) },
      { descricao: 'Profilaxia', quantidade: 1, valorUnitario: valorParaOPaciente({ cobertura: 'convenio', valorConvenio: '100.00', coberturaPct: '80' }) },
    ]
    expect(calcularBruto(linhas)).toBe('320.00')
  })
})
