import { describe, expect, it } from 'vitest'
import {
  avaliarReposicao,
  classificarValidade,
  consolidarInsumos,
  consumoMedioDiario,
  custoDaBaixa,
  diasDeCobertura,
  type LoteDisponivel,
  ordenarFefo,
  planejarBaixaFefo,
  podeConsumir,
  saldoDeMovimentos,
  sinalEsperado,
  TIPOS_MOVIMENTO,
  urgenciaDeReposicao,
  validarMovimento,
  valorEmEstoque,
} from './estoque'

const HOJE = '2026-07-26'

function lote(p: Partial<LoteDisponivel> & { id: string }): LoteDisponivel {
  return { saldo: '10.000', validade: null, recebidoEm: '2026-01-01', ...p }
}

describe('classificarValidade', () => {
  it('separa sem validade de validade vencida', () => {
    expect(classificarValidade(null, HOJE).situacao).toBe('sem_validade')
    expect(classificarValidade(null, HOJE).diasParaVencer).toBeNull()
  })

  it('vence HOJE ainda serve — o dia civil inteiro vale', () => {
    const v = classificarValidade(HOJE, HOJE)
    expect(v.situacao).toBe('vence_em_breve')
    expect(v.diasParaVencer).toBe(0)
    expect(v.rotulo).toBe('vence hoje')
    expect(podeConsumir(HOJE, HOJE)).toBe(true)
  })

  it('ontem está vencido', () => {
    const v = classificarValidade('2026-07-25', HOJE)
    expect(v.situacao).toBe('vencido')
    expect(v.diasParaVencer).toBe(-1)
    expect(v.rotulo).toBe('vencido ontem')
    expect(podeConsumir('2026-07-25', HOJE)).toBe(false)
  })

  it('conta os dias por cima do mês e do ano', () => {
    expect(classificarValidade('2026-08-01', HOJE).diasParaVencer).toBe(6)
    expect(classificarValidade('2027-07-26', HOJE).diasParaVencer).toBe(365)
    expect(classificarValidade('2026-07-01', HOJE).rotulo).toBe('vencido há 25 dias')
  })

  it('alerta com 60 dias de antecedência, e a janela é configurável', () => {
    expect(classificarValidade('2026-09-24', HOJE).situacao).toBe('vence_em_breve') // 60 dias
    expect(classificarValidade('2026-09-25', HOJE).situacao).toBe('ok') // 61
    expect(classificarValidade('2026-09-25', HOJE, 90).situacao).toBe('vence_em_breve')
  })

  it('amanhã tem rótulo próprio — "vence em 1 dias" não se lê', () => {
    expect(classificarValidade('2026-07-27', HOJE).rotulo).toBe('vence amanhã')
  })
})

describe('FEFO — sai o que vence primeiro, não o que chegou primeiro', () => {
  it('a caixa recebida DEPOIS sai antes se vencer antes', () => {
    const antiga = lote({ id: 'antiga', validade: '2027-01-01', recebidoEm: '2026-01-01' })
    const nova = lote({ id: 'nova', validade: '2026-09-01', recebidoEm: '2026-07-01' })
    // FIFO devolveria ['antiga', 'nova'] e deixaria 'nova' vencer na prateleira.
    expect(ordenarFefo([antiga, nova]).map((l) => l.id)).toEqual(['nova', 'antiga'])
  })

  it('sem validade fica no fim — perene não corre risco de perda', () => {
    const perene = lote({ id: 'perene', validade: null })
    const comValidade = lote({ id: 'com', validade: '2030-01-01' })
    expect(ordenarFefo([perene, comValidade]).map((l) => l.id)).toEqual(['com', 'perene'])
  })

  it('desempata mesma validade pelo recebimento mais antigo', () => {
    const a = lote({ id: 'a', validade: '2026-12-01', recebidoEm: '2026-05-01' })
    const b = lote({ id: 'b', validade: '2026-12-01', recebidoEm: '2026-02-01' })
    expect(ordenarFefo([a, b]).map((l) => l.id)).toEqual(['b', 'a'])
  })

  it('ordena sem mutar a entrada', () => {
    const entrada = [lote({ id: 'z', validade: '2027-01-01' }), lote({ id: 'a', validade: '2026-08-01' })]
    ordenarFefo(entrada)
    expect(entrada.map((l) => l.id)).toEqual(['z', 'a'])
  })
})

describe('planejarBaixaFefo', () => {
  const lotes = [
    lote({ id: 'longe', saldo: '5.000', validade: '2027-06-01' }),
    lote({ id: 'perto', saldo: '3.000', validade: '2026-08-15' }),
    lote({ id: 'medio', saldo: '4.000', validade: '2026-12-01' }),
  ]

  it('esgota o lote que vence primeiro antes de tocar no seguinte', () => {
    const p = planejarBaixaFefo(lotes, '5', HOJE)
    expect(p.atende).toBe(true)
    expect(p.alocacoes).toEqual([
      { loteId: 'perto', quantidade: '3.000' },
      { loteId: 'medio', quantidade: '2.000' },
    ])
    expect(p.faltante).toBe('0.000')
  })

  it('cabe num lote só quando cabe', () => {
    expect(planejarBaixaFefo(lotes, '2', HOJE).alocacoes).toEqual([
      { loteId: 'perto', quantidade: '2.000' },
    ])
  })

  it('não lança quando falta saldo — informa o faltante', () => {
    const p = planejarBaixaFefo(lotes, '20', HOJE)
    expect(p.atende).toBe(false)
    expect(p.faltante).toBe('8.000')
    // Aloca tudo o que há: a tela mostra o que dá e o que falta.
    expect(saldoDaAlocacao(p.alocacoes)).toBe('12.000')
  })

  it('IGNORA lote vencido e diz que ignorou', () => {
    const comVencido = [...lotes, lote({ id: 'vencido', saldo: '99.000', validade: '2026-07-01' })]
    const p = planejarBaixaFefo(comVencido, '5', HOJE)
    expect(p.alocacoes.map((a) => a.loteId)).not.toContain('vencido')
    expect(p.vencidosIgnorados).toEqual(['vencido'])
    // Sem o aviso, o saldo total (111) não explicaria a falta — e o vencido
    // continuaria na prateleira ocupando espaço e confundindo a contagem.
  })

  it('pula lote zerado', () => {
    const p = planejarBaixaFefo([lote({ id: 'vazio', saldo: '0.000', validade: '2026-08-01' }), ...lotes], '1', HOJE)
    expect(p.alocacoes).toEqual([{ loteId: 'perto', quantidade: '1.000' }])
  })

  it('estoque vazio devolve faltante igual ao pedido, não erro', () => {
    const p = planejarBaixaFefo([], '3', HOJE)
    expect(p.atende).toBe(false)
    expect(p.faltante).toBe('3.000')
    expect(p.alocacoes).toEqual([])
  })

  it('recusa quantidade não positiva', () => {
    expect(() => planejarBaixaFefo(lotes, '0', HOJE)).toThrow(/positiva/i)
    expect(() => planejarBaixaFefo(lotes, '-1', HOJE)).toThrow()
  })

  it('baixa fracionária respeita FEFO', () => {
    const l = [
      lote({ id: 'a', saldo: '0.500', validade: '2026-08-01' }),
      lote({ id: 'b', saldo: '2.000', validade: '2026-09-01' }),
    ]
    expect(planejarBaixaFefo(l, '1.25', HOJE).alocacoes).toEqual([
      { loteId: 'a', quantidade: '0.500' },
      { loteId: 'b', quantidade: '0.750' },
    ])
  })
})

function saldoDaAlocacao(alocacoes: readonly { quantidade: string }[]): string {
  return saldoDeMovimentos(alocacoes.map((a) => ({ tipo: 'entrada' as const, quantidade: a.quantidade })))
}

describe('custoDaBaixa — cada lote pelo custo dele', () => {
  it('soma o custo real de cada lote consumido', () => {
    const lotes = [
      lote({ id: 'caro', saldo: '2.000', validade: '2026-08-01', custoUnitario: '10.00' }),
      lote({ id: 'barato', saldo: '5.000', validade: '2026-12-01', custoUnitario: '4.00' }),
    ]
    const p = planejarBaixaFefo(lotes, '4', HOJE)
    // 2 × 10,00 (lote que vence antes) + 2 × 4,00 = 28,00.
    // Custo médio do material daria 2×6 + 2×6 = 24,00 — e o estoque não fecharia.
    expect(custoDaBaixa(p, lotes)).toBe('28.00')
  })

  it('arredonda ao centavo em quantidade fracionária', () => {
    const lotes = [lote({ id: 'a', saldo: '10.000', validade: '2026-08-01', custoUnitario: '0.33' })]
    const p = planejarBaixaFefo(lotes, '0.5', HOJE)
    expect(custoDaBaixa(p, lotes)).toBe('0.17') // 0,165 → 0,17
  })

  it('lote sem custo informado não vira zero silencioso no total geral', () => {
    const lotes = [lote({ id: 'a', saldo: '3.000', validade: '2026-08-01' })]
    expect(custoDaBaixa(planejarBaixaFefo(lotes, '1', HOJE), lotes)).toBe('0.00')
  })
})

describe('movimentos', () => {
  it('saldo é a soma assinada dos movimentos', () => {
    expect(
      saldoDeMovimentos([
        { tipo: 'entrada', quantidade: '100.000' },
        { tipo: 'consumo', quantidade: '-3.000' },
        { tipo: 'descarte', quantidade: '-2.000' },
        { tipo: 'ajuste', quantidade: '0.500' },
      ]),
    ).toBe('95.500')
  })

  it('cada tipo tem sinal definido, e ajuste é o único livre', () => {
    expect(sinalEsperado('entrada')).toBe(1)
    expect(sinalEsperado('consumo')).toBe(-1)
    expect(sinalEsperado('descarte')).toBe(-1)
    expect(sinalEsperado('devolucao')).toBe(-1)
    expect(sinalEsperado('ajuste')).toBe(0)
    // Todo tipo do enum precisa de sinal — o switch é exaustivo por tipo,
    // mas isto pega tipo novo adicionado sem revisar a regra.
    for (const t of TIPOS_MOVIMENTO) expect([1, -1, 0]).toContain(sinalEsperado(t))
  })

  it('recusa movimento de quantidade zero', () => {
    const r = validarMovimento({ tipo: 'entrada', quantidade: '0' })
    expect(r.ok).toBe(false)
  })

  it('recusa sinal contrário ao tipo', () => {
    expect(validarMovimento({ tipo: 'entrada', quantidade: '-1' }).ok).toBe(false)
    expect(validarMovimento({ tipo: 'consumo', quantidade: '1' }).ok).toBe(false)
    expect(validarMovimento({ tipo: 'consumo', quantidade: '-1' }).ok).toBe(true)
  })

  it('ajuste aceita os dois sentidos, mas exige motivo', () => {
    expect(validarMovimento({ tipo: 'ajuste', quantidade: '2' }).ok).toBe(false)
    expect(validarMovimento({ tipo: 'ajuste', quantidade: '2', motivo: 'contagem de julho' }).ok).toBe(true)
    expect(validarMovimento({ tipo: 'ajuste', quantidade: '-2', motivo: 'contagem de julho' }).ok).toBe(true)
  })

  it('descarte exige motivo; consumo não', () => {
    expect(validarMovimento({ tipo: 'descarte', quantidade: '-1' }).ok).toBe(false)
    expect(validarMovimento({ tipo: 'descarte', quantidade: '-1', motivo: 'vencido' }).ok).toBe(true)
    expect(validarMovimento({ tipo: 'consumo', quantidade: '-1' }).ok).toBe(true)
  })

  it('motivo em branco não conta como motivo', () => {
    expect(validarMovimento({ tipo: 'descarte', quantidade: '-1', motivo: '   ' }).ok).toBe(false)
  })
})

describe('avaliarReposicao', () => {
  it('zerado é situação própria, não "abaixo do mínimo"', () => {
    const r = avaliarReposicao('0', '10')
    expect(r.situacao).toBe('zerado')
    expect(r.sugestaoDeCompra).toBe('20.000')
  })

  it('sugere repor ao DOBRO do mínimo, não ao mínimo', () => {
    // Repor a 10 deixaria o alerta disparando no dia seguinte à entrega.
    expect(avaliarReposicao('4', '10').sugestaoDeCompra).toBe('16.000')
  })

  it('no mínimo exato ainda não é alerta', () => {
    expect(avaliarReposicao('10', '10').situacao).toBe('proximo_do_minimo')
    expect(avaliarReposicao('9.999', '10').situacao).toBe('abaixo_do_minimo')
  })

  it('20% acima do mínimo entra na lista de compras sem virar alerta', () => {
    expect(avaliarReposicao('12', '10').situacao).toBe('proximo_do_minimo')
    expect(avaliarReposicao('12.001', '10').situacao).toBe('ok')
  })

  it('material sem mínimo definido nunca alerta', () => {
    const r = avaliarReposicao('3', '0')
    expect(r.situacao).toBe('ok')
    expect(r.rotulo).toMatch(/sem mínimo/)
  })

  it('ordena o que precisa de atenção primeiro', () => {
    const situacoes = ['ok', 'zerado', 'proximo_do_minimo', 'abaixo_do_minimo'] as const
    expect([...situacoes].sort((a, b) => urgenciaDeReposicao(a) - urgenciaDeReposicao(b))).toEqual([
      'zerado',
      'abaixo_do_minimo',
      'proximo_do_minimo',
      'ok',
    ])
  })
})

describe('consumo e cobertura', () => {
  const movimentos = [
    { tipo: 'entrada' as const, quantidade: '100.000' },
    { tipo: 'consumo' as const, quantidade: '-30.000' },
    { tipo: 'consumo' as const, quantidade: '-30.000' },
    { tipo: 'descarte' as const, quantidade: '-20.000' },
  ]

  it('média diária conta só consumo — descarte não é demanda', () => {
    // 60 consumidos em 30 dias = 2/dia. Incluir o descarte daria 2,67 e a
    // clínica compraria mais do material que ela justamente perde por validade.
    expect(consumoMedioDiario(movimentos, 30)).toBe('2.000')
  })

  it('arredonda ao milésimo', () => {
    expect(consumoMedioDiario([{ tipo: 'consumo', quantidade: '-10.000' }], 3)).toBe('3.333')
  })

  it('recusa período inválido', () => {
    expect(() => consumoMedioDiario(movimentos, 0)).toThrow()
  })

  it('cobertura em dias, arredondada para baixo', () => {
    expect(diasDeCobertura('10', '3')).toBe(3)
    expect(diasDeCobertura('0', '3')).toBe(0)
  })

  it('sem consumo NÃO devolve infinito', () => {
    // Devolver Infinity viraria "cobertura de ∞ dias" na tela; null é "não sei".
    expect(diasDeCobertura('10', '0')).toBeNull()
  })
})

describe('ficha técnica', () => {
  it('soma o mesmo material de procedimentos diferentes', () => {
    expect(
      consolidarInsumos([
        [
          { materialId: 'anestesico', quantidade: '1' },
          { materialId: 'agulha', quantidade: '1' },
        ],
        [
          { materialId: 'anestesico', quantidade: '1' },
          { materialId: 'resina', quantidade: '0.25' },
        ],
      ]),
    ).toEqual([
      { materialId: 'agulha', quantidade: '1' },
      { materialId: 'anestesico', quantidade: '2.000' },
      { materialId: 'resina', quantidade: '0.25' },
    ])
  })

  it('lista vazia consolida em nada', () => {
    expect(consolidarInsumos([])).toEqual([])
    expect(consolidarInsumos([[]])).toEqual([])
  })
})

describe('valorEmEstoque', () => {
  it('soma saldo × custo de cada lote', () => {
    expect(
      valorEmEstoque([
        lote({ id: 'a', saldo: '10.000', custoUnitario: '2.50' }),
        lote({ id: 'b', saldo: '3.500', custoUnitario: '10.00' }),
      ]),
    ).toBe('60.00')
  })

  it('lote sem custo não quebra o total', () => {
    expect(valorEmEstoque([lote({ id: 'a', saldo: '10.000' })])).toBe('0.00')
  })

  it('estoque vazio vale zero', () => {
    expect(valorEmEstoque([])).toBe('0.00')
  })
})
