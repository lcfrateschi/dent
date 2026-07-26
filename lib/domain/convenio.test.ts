import { describe, expect, it } from 'vitest'
import {
  type PrecoNegociado,
  atrasoDoRepasse,
  avaliarElegibilidade,
  conciliarRepasse,
  orientacaoDeGlosa,
  precoVigenteEm,
  previsaoDeRepasse,
  ratearCobertura,
} from './convenio'
import { somar } from './dinheiro'
import { ErroDominio } from './erros'

function preco(p: Partial<PrecoNegociado> = {}): PrecoNegociado {
  return {
    convenioId: 'c1',
    procedimentoId: 'p1',
    valor: '100.00',
    coberturaPct: '100',
    carenciaDias: 0,
    vigenciaInicio: '2026-01-01',
    vigenciaFim: null,
    ...p,
  }
}

describe('preço vigente na data', () => {
  const tabela2025 = preco({ valor: '80.00', vigenciaInicio: '2025-01-01', vigenciaFim: '2025-12-31' })
  const tabela2026 = preco({ valor: '100.00', vigenciaInicio: '2026-01-01' })

  it('usa o preço da DATA DA EXECUÇÃO, não o mais recente', () => {
    // O erro caro: faturar em março um procedimento de dezembro com o preço novo.
    expect(precoVigenteEm([tabela2025, tabela2026], '2025-06-15')?.valor).toBe('80.00')
    expect(precoVigenteEm([tabela2025, tabela2026], '2026-06-15')?.valor).toBe('100.00')
  })

  it('respeita os limites da vigência, inclusive nas pontas', () => {
    expect(precoVigenteEm([tabela2025], '2025-01-01')?.valor).toBe('80.00')
    expect(precoVigenteEm([tabela2025], '2025-12-31')?.valor).toBe('80.00')
    expect(precoVigenteEm([tabela2025], '2024-12-31')).toBeNull()
    expect(precoVigenteEm([tabela2025], '2026-01-01')).toBeNull()
  })

  it('vigência sem fim vale para frente', () => {
    expect(precoVigenteEm([tabela2026], '2030-01-01')?.valor).toBe('100.00')
  })

  it('entre dois preços que se sobrepõem, vence o de início mais recente', () => {
    const antigo = preco({ valor: '90.00', vigenciaInicio: '2026-01-01' })
    const novo = preco({ valor: '110.00', vigenciaInicio: '2026-06-01' })
    expect(precoVigenteEm([antigo, novo], '2026-07-01')?.valor).toBe('110.00')
    // Antes do novo entrar, o antigo continua valendo.
    expect(precoVigenteEm([antigo, novo], '2026-05-31')?.valor).toBe('90.00')
  })

  it('sem tabela para a data devolve null — não o preço mais próximo', () => {
    // Devolver "o mais próximo" faria a clínica faturar um valor que não foi
    // negociado para aquele período.
    expect(precoVigenteEm([], '2026-01-01')).toBeNull()
    expect(precoVigenteEm([tabela2026], '2025-06-01')).toBeNull()
  })
})

describe('rateio entre operadora e paciente', () => {
  it('cobertura de 100% deixa o paciente sem coparticipação', () => {
    expect(ratearCobertura('100.00', '100')).toEqual({
      total: '100.00',
      convenio: '100.00',
      paciente: '0.00',
    })
  })

  it('cobertura de 0% é tudo do paciente', () => {
    expect(ratearCobertura('100.00', '0')).toEqual({
      total: '100.00',
      convenio: '0.00',
      paciente: '100.00',
    })
  })

  it('divide meio a meio', () => {
    expect(ratearCobertura('100.00', '50')).toEqual({
      total: '100.00',
      convenio: '50.00',
      paciente: '50.00',
    })
  })

  it('as duas partes somam EXATAMENTE o total, sempre', () => {
    // A invariante que impede glosa da guia inteira por um centavo.
    const valores = ['0.01', '0.03', '10.00', '33.33', '99.99', '100.01', '1234.56', '7.77']
    const percentuais = ['0', '1', '30', '33.33', '50', '66.67', '70', '99', '100']

    for (const valor of valores) {
      for (const pct of percentuais) {
        const r = ratearCobertura(valor, pct)
        expect(somar(r.convenio, r.paciente), `${valor} @ ${pct}%`).toBe(r.total)
      }
    }
  })

  it('a sobra do arredondamento vai para o PACIENTE, não para a operadora', () => {
    // Pedir um centavo a mais que a regra produz é motivo de glosa do item.
    // Cobrar um centavo a mais do paciente é arredondamento que ninguém discute.
    const r = ratearCobertura('0.01', '50')
    expect(r.convenio).toBe('0.00')
    expect(r.paciente).toBe('0.01')

    const r2 = ratearCobertura('100.00', '33.33')
    expect(r2.convenio).toBe('33.33')
    expect(r2.paciente).toBe('66.67')
  })

  it('valor zero não quebra', () => {
    expect(ratearCobertura('0.00', '70')).toEqual({
      total: '0.00',
      convenio: '0.00',
      paciente: '0.00',
    })
  })

  it('recusa percentual fora da faixa e valor negativo', () => {
    expect(() => ratearCobertura('100.00', '101')).toThrowError(ErroDominio)
    expect(() => ratearCobertura('100.00', '-1')).toThrowError(ErroDominio)
    expect(() => ratearCobertura('100.00', 'abc')).toThrowError(ErroDominio)
    expect(() => ratearCobertura('-100.00', '50')).toThrowError(ErroDominio)
  })
})

describe('elegibilidade', () => {
  const carteirinha = {
    numeroCarteirinha: '123456',
    ativo: true,
    adesaoEm: '2025-01-01',
    validade: '2027-12-31',
  }

  it('elegível quando tudo confere', () => {
    const r = avaliarElegibilidade({ carteirinha, preco: preco(), dataIso: '2026-07-01' })
    expect(r.elegivel).toBe(true)
    expect(r.motivo).toBeNull()
  })

  it('sem carteirinha não é convênio', () => {
    const r = avaliarElegibilidade({ carteirinha: null, preco: preco(), dataIso: '2026-07-01' })
    expect(r).toMatchObject({ elegivel: false, motivo: 'sem_carteirinha' })
    expect(r.explicacao).toBeTruthy()
  })

  it('carteirinha inativa e vencida têm motivos distintos', () => {
    expect(
      avaliarElegibilidade({
        carteirinha: { ...carteirinha, ativo: false },
        preco: preco(),
        dataIso: '2026-07-01',
      }).motivo,
    ).toBe('carteirinha_inativa')

    const vencida = avaliarElegibilidade({
      carteirinha: { ...carteirinha, validade: '2026-06-30' },
      preco: preco(),
      dataIso: '2026-07-01',
    })
    expect(vencida.motivo).toBe('carteirinha_vencida')
    // A explicação traz a data, porque a recepção vai dizer isso ao paciente.
    expect(vencida.explicacao).toContain('30/06/2026')
  })

  it('vence NO dia ainda vale', () => {
    expect(
      avaliarElegibilidade({
        carteirinha: { ...carteirinha, validade: '2026-07-01' },
        preco: preco(),
        dataIso: '2026-07-01',
      }).elegivel,
    ).toBe(true)
  })

  it('validade nula é carteirinha sem prazo', () => {
    expect(
      avaliarElegibilidade({
        carteirinha: { ...carteirinha, validade: null },
        preco: preco(),
        dataIso: '2030-01-01',
      }).elegivel,
    ).toBe(true)
  })

  it('procedimento fora da tabela é particular, e a explicação diz isso', () => {
    const r = avaliarElegibilidade({ carteirinha, preco: null, dataIso: '2026-07-01' })
    expect(r.motivo).toBe('sem_preco_negociado')
    expect(r.explicacao).toContain('particular')
  })

  it('CARÊNCIA conta da adesão do paciente', () => {
    const comCarencia = preco({ carenciaDias: 180 })
    const adesao = { ...carteirinha, adesaoEm: '2026-01-01' }

    // 180 dias de 01/01/2026 = 30/06/2026.
    const dentro = avaliarElegibilidade({
      carteirinha: adesao,
      preco: comCarencia,
      dataIso: '2026-06-29',
    })
    expect(dentro.motivo).toBe('dentro_da_carencia')
    expect(dentro.carenciaTerminaEm).toBe('2026-06-30')
    expect(dentro.explicacao).toContain('30/06/2026')

    expect(
      avaliarElegibilidade({ carteirinha: adesao, preco: comCarencia, dataIso: '2026-06-30' })
        .elegivel,
    ).toBe(true)
  })

  it('carência sem data de adesão NÃO é assumida como cumprida', () => {
    // Assumir que passou seria faturar às cegas algo que volta glosado.
    const r = avaliarElegibilidade({
      carteirinha: { ...carteirinha, adesaoEm: null },
      preco: preco({ carenciaDias: 90 }),
      dataIso: '2026-07-01',
    })
    expect(r.elegivel).toBe(false)
    expect(r.motivo).toBe('dentro_da_carencia')
    expect(r.explicacao).toContain('adesão')
  })

  it('sem carência, a data de adesão não importa', () => {
    expect(
      avaliarElegibilidade({
        carteirinha: { ...carteirinha, adesaoEm: null },
        preco: preco({ carenciaDias: 0 }),
        dataIso: '2026-07-01',
      }).elegivel,
    ).toBe(true)
  })

  it('a ordem de checagem coloca o problema mais concreto primeiro', () => {
    // Carteirinha vencida E sem preço: o que a recepção resolve é a carteirinha.
    const r = avaliarElegibilidade({
      carteirinha: { ...carteirinha, validade: '2020-01-01' },
      preco: null,
      dataIso: '2026-07-01',
    })
    expect(r.motivo).toBe('carteirinha_vencida')
  })
})

describe('orientação de glosa', () => {
  it('erro de envio e falta de documento valem recurso', () => {
    expect(orientacaoDeGlosa('erro_de_envio').recorrer).toBe(true)
    expect(orientacaoDeGlosa('falta_documento').recorrer).toBe(true)
    expect(orientacaoDeGlosa('valor').recorrer).toBe(true)
  })

  it('não coberto e prazo perdido NÃO valem recurso', () => {
    // Recorrer de tudo é o comportamento errado: recurso custa tempo e tem prazo.
    expect(orientacaoDeGlosa('nao_coberto').recorrer).toBe(false)
    expect(orientacaoDeGlosa('prazo').recorrer).toBe(false)
    expect(orientacaoDeGlosa('elegibilidade').recorrer).toBe(false)
  })

  it('a orientação de "não coberto" lembra de avisar o paciente', () => {
    expect(orientacaoDeGlosa('nao_coberto').orientacao).toContain('paciente')
  })

  it('toda classe tem orientação escrita', () => {
    const classes = [
      'erro_de_envio',
      'nao_coberto',
      'elegibilidade',
      'valor',
      'falta_documento',
      'prazo',
      'outro',
    ] as const
    for (const c of classes) {
      expect(orientacaoDeGlosa(c).orientacao.length, c).toBeGreaterThan(20)
    }
  })
})

describe('conciliação do repasse', () => {
  it('confere item a item, não pelo total', () => {
    const r = conciliarRepasse([
      { id: '1', valorApresentado: '100.00', valorPago: '100.00' },
      { id: '2', valorApresentado: '80.00', valorPago: '60.00' },
      { id: '3', valorApresentado: '50.00', valorPago: '0.00' },
    ])
    expect(r.totalApresentado).toBe('230.00')
    expect(r.totalPago).toBe('160.00')
    expect(r.totalGlosado).toBe('70.00')
    expect(r.itensPagosIntegralmente).toBe(1)
    expect(r.itensGlosadosParcialmente).toBe(1)
    expect(r.itensGlosadosTotalmente).toBe(1)
  })

  it('DOIS erros que se cancelam no total ainda aparecem por item', () => {
    // O motivo de conciliar item a item: a soma fecha e há dois problemas.
    const r = conciliarRepasse([
      { id: '1', valorApresentado: '100.00', valorPago: '120.00' },
      { id: '2', valorApresentado: '100.00', valorPago: '80.00' },
    ])
    expect(r.totalApresentado).toBe('200.00')
    expect(r.totalPago).toBe('200.00')
    expect(r.totalGlosado).toBe('0.00')
    // Mas os itens contam a verdade: um pago além, outro glosado em parte.
    expect(r.itensPagosIntegralmente).toBe(1)
    expect(r.itensGlosadosParcialmente).toBe(1)
  })

  it('item sem retorno conta como glosa e é contado à parte', () => {
    const r = conciliarRepasse([
      { id: '1', valorApresentado: '100.00', valorPago: null },
      { id: '2', valorApresentado: '50.00', valorPago: '50.00' },
    ])
    expect(r.itensSemRetorno).toBe(1)
    expect(r.totalGlosado).toBe('100.00')
  })

  it('repasse vazio não quebra', () => {
    const r = conciliarRepasse([])
    expect(r.totalApresentado).toBe('0.00')
    expect(r.totalGlosado).toBe('0.00')
  })

  it('glosa nunca fica negativa', () => {
    // Operadora pagou mais que o apresentado: é sobra, não glosa negativa.
    const r = conciliarRepasse([{ id: '1', valorApresentado: '100.00', valorPago: '150.00' }])
    expect(r.totalGlosado).toBe('0.00')
  })
})

describe('prazo de repasse', () => {
  it('conta do ENVIO, não da execução', () => {
    // O contrato fala do protocolo. Guia executada em janeiro e enviada em março
    // vence em abril.
    expect(previsaoDeRepasse('2026-03-10', 30)).toBe('2026-04-09')
  })

  it('atravessa a virada de mês e de ano', () => {
    expect(previsaoDeRepasse('2026-12-20', 30)).toBe('2027-01-19')
    expect(previsaoDeRepasse('2026-01-31', 30)).toBe('2026-03-02')
  })

  it('prazo zero é no mesmo dia', () => {
    expect(previsaoDeRepasse('2026-03-10', 0)).toBe('2026-03-10')
  })

  it('recusa prazo inválido', () => {
    expect(() => previsaoDeRepasse('2026-03-10', -1)).toThrowError(ErroDominio)
    expect(() => previsaoDeRepasse('2026-03-10', 1.5)).toThrowError(ErroDominio)
  })

  it('atraso é zero dentro do prazo', () => {
    expect(atrasoDoRepasse('2026-04-09', '2026-04-01')).toBe(0)
    expect(atrasoDoRepasse('2026-04-09', '2026-04-09')).toBe(0)
  })

  it('conta os dias depois do vencimento', () => {
    expect(atrasoDoRepasse('2026-04-09', '2026-04-10')).toBe(1)
    expect(atrasoDoRepasse('2026-04-09', '2026-05-09')).toBe(30)
  })
})
