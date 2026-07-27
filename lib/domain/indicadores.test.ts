import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  calcularComparecimento,
  calcularEfeitoConfirmacao,
  calcularOcupacao,
  calcularVariacao,
  formatarMinutos,
  formatarPercentual,
  formatarTaxa,
  ticketMedio,
  tomDaVariacao,
  variacaoDeDinheiro,
  conversaoDeOrcamento,
  recuperacaoDaFila,
} from './indicadores'

describe('ocupação', () => {
  it('separa reservada de realizada', () => {
    // O caso que motiva as duas medidas: agenda cheia, muita falta.
    const o = calcularOcupacao({
      minutosDisponiveis: 1000,
      minutosReservados: 900,
      minutosRealizados: 700,
      minutosPerdidosPorFalta: 200,
    })
    expect(o.reservada).toBe(90)
    expect(o.realizada).toBe(70)
    expect(o.perdida).toBe(20)
  })

  it('agenda vazia dá taxa INDEFINIDA, não zero', () => {
    // Clínica fechada no período não tem ocupação 0% — não tem ocupação.
    const o = calcularOcupacao({
      minutosDisponiveis: 0,
      minutosReservados: 0,
      minutosRealizados: 0,
      minutosPerdidosPorFalta: 0,
    })
    expect(o.reservada).toBeNull()
    expect(o.realizada).toBeNull()
    expect(formatarTaxa(o.reservada)).toBe('—')
  })

  it('arredonda para uma casa', () => {
    const o = calcularOcupacao({
      minutosDisponiveis: 3,
      minutosReservados: 1,
      minutosRealizados: 1,
      minutosPerdidosPorFalta: 0,
    })
    expect(o.reservada).toBe(33.3)
  })

  it('permite passar de 100% — encaixe existe', () => {
    // Encaixe e atraso fazem a agenda estourar o horário previsto. Truncar em
    // 100% esconderia exatamente o que o gestor precisa ver.
    const o = calcularOcupacao({
      minutosDisponiveis: 480,
      minutosReservados: 540,
      minutosRealizados: 540,
      minutosPerdidosPorFalta: 0,
    })
    expect(o.reservada).toBe(112.5)
  })

  it('recusa minuto negativo', () => {
    expect(() =>
      calcularOcupacao({
        minutosDisponiveis: 100,
        minutosReservados: -1,
        minutosRealizados: 0,
        minutosPerdidosPorFalta: 0,
      }),
    ).toThrowError(ErroDominio)
  })
})

describe('comparecimento', () => {
  it('a taxa de falta NÃO inclui cancelado na base', () => {
    // Quem avisou liberou o horário. 20 concluídos + 5 faltas = base 25.
    const c = calcularComparecimento({ concluidos: 20, faltas: 5, cancelados: 50, futuros: 0 })
    expect(c.taxaDeFalta).toBe(20)
    // Se cancelado entrasse na base, daria 6,7% e o mês pareceria ótimo.
    expect(c.taxaDeFalta).not.toBe(arredondado(5 / 75))
  })

  it('futuro não entra em nenhuma taxa', () => {
    // Agendamento de amanhã não é falta nem comparecimento.
    const semFuturo = calcularComparecimento({ concluidos: 10, faltas: 2, cancelados: 1, futuros: 0 })
    const comFuturo = calcularComparecimento({ concluidos: 10, faltas: 2, cancelados: 1, futuros: 40 })
    expect(comFuturo.taxaDeFalta).toBe(semFuturo.taxaDeFalta)
  })

  it('cancelamento tem taxa própria, sobre tudo que foi marcado', () => {
    const c = calcularComparecimento({ concluidos: 10, faltas: 2, cancelados: 8, futuros: 0 })
    expect(c.marcados).toBe(20)
    expect(c.taxaDeCancelamento).toBe(40)
  })

  it('período sem nada dá taxas indefinidas', () => {
    const c = calcularComparecimento({ concluidos: 0, faltas: 0, cancelados: 0, futuros: 0 })
    expect(c.taxaDeFalta).toBeNull()
    expect(c.taxaDeCancelamento).toBeNull()
  })

  it('só futuros: nenhuma taxa de falta, mas cancelamento é 0', () => {
    const c = calcularComparecimento({ concluidos: 0, faltas: 0, cancelados: 0, futuros: 12 })
    expect(c.taxaDeFalta).toBeNull()
    expect(c.taxaDeCancelamento).toBe(0)
  })

  it('recusa contagem fracionária ou negativa', () => {
    expect(() =>
      calcularComparecimento({ concluidos: 1.5, faltas: 0, cancelados: 0, futuros: 0 }),
    ).toThrowError(ErroDominio)
    expect(() =>
      calcularComparecimento({ concluidos: 0, faltas: -1, cancelados: 0, futuros: 0 }),
    ).toThrowError(ErroDominio)
  })
})

function arredondado(fracao: number): number {
  return Math.round(fracao * 1000) / 10
}

describe('efeito da confirmação por WhatsApp', () => {
  it('compara falta com e sem confirmação', () => {
    const e = calcularEfeitoConfirmacao({
      confirmadosQueVieram: 90,
      confirmadosQueFaltaram: 10,
      naoConfirmadosQueVieram: 70,
      naoConfirmadosQueFaltaram: 30,
    })
    expect(e.faltaComConfirmacao).toBe(10)
    expect(e.faltaSemConfirmacao).toBe(30)
    expect(e.diferencaEmPontos).toBe(20)
  })

  it('NÃO conclui nada com amostra pequena', () => {
    // "Confirmar reduz a falta em 50 pontos" com 2 casos é invenção.
    const e = calcularEfeitoConfirmacao({
      confirmadosQueVieram: 2,
      confirmadosQueFaltaram: 0,
      naoConfirmadosQueVieram: 1,
      naoConfirmadosQueFaltaram: 1,
    })
    expect(e.faltaComConfirmacao).toBe(0)
    expect(e.faltaSemConfirmacao).toBe(50)
    expect(e.diferencaEmPontos).toBeNull()
  })

  it('um lado vazio não gera comparação', () => {
    const e = calcularEfeitoConfirmacao({
      confirmadosQueVieram: 50,
      confirmadosQueFaltaram: 5,
      naoConfirmadosQueVieram: 0,
      naoConfirmadosQueFaltaram: 0,
    })
    expect(e.faltaSemConfirmacao).toBeNull()
    expect(e.diferencaEmPontos).toBeNull()
  })

  it('diferença negativa aparece — confirmar pode não ajudar', () => {
    // Se o número disser que não ajuda, o painel tem de dizer também.
    const e = calcularEfeitoConfirmacao({
      confirmadosQueVieram: 80,
      confirmadosQueFaltaram: 20,
      naoConfirmadosQueVieram: 90,
      naoConfirmadosQueFaltaram: 10,
    })
    expect(e.diferencaEmPontos).toBe(-10)
  })
})

describe('variação entre períodos', () => {
  it('calcula subida e queda', () => {
    expect(calcularVariacao(110, 100)).toMatchObject({ percentual: 10, direcao: 'subiu', rotulo: '+10%' })
    expect(calcularVariacao(80, 100)).toMatchObject({ percentual: -20, direcao: 'caiu', rotulo: '-20%' })
  })

  it('BASE ZERO não é +100% nem +Infinity', () => {
    const v = calcularVariacao(5000, 0)
    expect(v.percentual).toBeNull()
    expect(v.direcao).toBe('do_nada')
    expect(v.rotulo).toBe('do zero')
    expect(v.rotulo).not.toContain('Infinity')
    expect(v.rotulo).not.toContain('NaN')
  })

  it('zero para zero é igual, não indefinido', () => {
    expect(calcularVariacao(0, 0)).toMatchObject({ direcao: 'igual', rotulo: '—' })
  })

  it('queda a zero é -100%', () => {
    expect(calcularVariacao(0, 100)).toMatchObject({ percentual: -100, direcao: 'caiu' })
  })

  it('usa o módulo da base — base negativa não inverte o sinal', () => {
    // Base negativa aparece em saldo. Sem `Math.abs`, uma melhora viraria queda.
    expect(calcularVariacao(-50, -100).direcao).toBe('subiu')
  })

  it('recusa valores não finitos', () => {
    expect(() => calcularVariacao(Number.NaN, 1)).toThrowError(ErroDominio)
    expect(() => calcularVariacao(1, Number.POSITIVE_INFINITY)).toThrowError(ErroDominio)
  })

  it('dinheiro compara em centavos, sem erro de float', () => {
    // 0.1 + 0.2 em float não é 0.3; em centavos é.
    expect(variacaoDeDinheiro('1200.00', '1000.00').percentual).toBe(20)
    expect(variacaoDeDinheiro('0.30', '0.10').percentual).toBe(200)
    expect(variacaoDeDinheiro('100.00', '0.00').direcao).toBe('do_nada')
  })
})

describe('sentido da variação', () => {
  it('faturamento subindo é bom; falta subindo é ruim', () => {
    const subiu = calcularVariacao(110, 100)
    expect(tomDaVariacao(subiu, 'maior_melhor')).toBe('bom')
    expect(tomDaVariacao(subiu, 'menor_melhor')).toBe('ruim')
  })

  it('queda inverte junto', () => {
    const caiu = calcularVariacao(90, 100)
    expect(tomDaVariacao(caiu, 'maior_melhor')).toBe('ruim')
    expect(tomDaVariacao(caiu, 'menor_melhor')).toBe('bom')
  })

  it('sem variação é neutro', () => {
    expect(tomDaVariacao(calcularVariacao(100, 100), 'maior_melhor')).toBe('neutro')
    expect(tomDaVariacao(calcularVariacao(0, 0), 'menor_melhor')).toBe('neutro')
  })

  it('"do zero" segue o sentido do indicador', () => {
    const doZero = calcularVariacao(10, 0)
    expect(tomDaVariacao(doZero, 'maior_melhor')).toBe('bom')
    // Falta que apareceu do nada é ruim.
    expect(tomDaVariacao(doZero, 'menor_melhor')).toBe('ruim')
  })
})

describe('ticket médio', () => {
  it('divide por paciente distinto', () => {
    expect(ticketMedio(300_000, 10)).toBe(30_000)
  })

  it('sem paciente é indefinido, não zero', () => {
    expect(ticketMedio(0, 0)).toBeNull()
    expect(ticketMedio(1000, 0)).toBeNull()
  })

  it('arredonda para centavo inteiro', () => {
    expect(ticketMedio(1000, 3)).toBe(333)
  })

  it('recusa divisor inválido', () => {
    expect(() => ticketMedio(100, -1)).toThrowError(ErroDominio)
    expect(() => ticketMedio(100, 1.5)).toThrowError(ErroDominio)
  })
})

describe('formatação', () => {
  it('percentual com vírgula e sem casa inútil', () => {
    expect(formatarPercentual(12)).toBe('12%')
    expect(formatarPercentual(12.5)).toBe('12,5%')
    expect(formatarPercentual(-8.3)).toBe('-8,3%')
    expect(formatarPercentual(0)).toBe('0%')
  })

  it('taxa indefinida é travessão, nunca 0%', () => {
    expect(formatarTaxa(null)).toBe('—')
    expect(formatarTaxa(0)).toBe('0%')
  })

  it('minutos em horas legíveis', () => {
    expect(formatarMinutos(45)).toBe('45min')
    expect(formatarMinutos(60)).toBe('1h')
    expect(formatarMinutos(135)).toBe('2h15')
    expect(formatarMinutos(605)).toBe('10h05')
    expect(formatarMinutos(0)).toBe('0min')
    expect(formatarMinutos(-1)).toBe('—')
    expect(formatarMinutos(Number.NaN)).toBe('—')
  })
})

describe('conversão de orçamento (Fase 18)', () => {
  it('calcula as duas medidas', () => {
    const c = conversaoDeOrcamento({
      enviados: 10,
      aprovados: 4,
      recusados: 2,
      expirados: 2,
      emAberto: 2,
    })
    expect(c.taxa).toBe(40) // 4 de 10 enviados
    expect(c.taxaDecidida).toBe(50) // 4 de 8 decididos
  })

  it('EXPIRADO conta como não-conversão', () => {
    // A tentação é tirar o expirado da base ("não recusou, só não respondeu") — e
    // é o que tornaria o indicador inútil, porque orçamento que morre de silêncio
    // é o modo de perda mais comum e o único que a fila existe para atacar.
    const semResposta = conversaoDeOrcamento({
      enviados: 10,
      aprovados: 0,
      recusados: 0,
      expirados: 10,
      emAberto: 0,
    })
    expect(semResposta.taxa).toBe(0)
    expect(semResposta.taxaDecidida).toBe(0)
  })

  it('sem orçamento enviado, a taxa é null e não zero', () => {
    const vazio = conversaoDeOrcamento({
      enviados: 0,
      aprovados: 0,
      recusados: 0,
      expirados: 0,
      emAberto: 0,
    })
    expect(vazio.taxa).toBeNull()
    expect(vazio.taxaDecidida).toBeNull()
    expect(formatarTaxa(vazio.taxa)).toBe('—')
  })

  it('tudo em aberto: taxa baixa, decidida indefinida', () => {
    // Mês em que ninguém decidiu ainda. `taxa` = 0% é verdade e enganosa; o que a
    // clínica precisa ler é "—" na decidida, não um julgamento.
    const c = conversaoDeOrcamento({
      enviados: 5,
      aprovados: 0,
      recusados: 0,
      expirados: 0,
      emAberto: 5,
    })
    expect(c.taxa).toBe(0)
    expect(c.taxaDecidida).toBeNull()
  })
})

describe('recuperação da fila (Fase 18)', () => {
  it('separa resolvida de dispensada', () => {
    const r = recuperacaoDaFila({ criadas: 10, resolvidas: 3, dispensadas: 2, pendentes: 5 })
    expect(r.taxa).toBe(30)
    expect(r.taxaTrabalhada).toBe(60) // 3 de 5 trabalhadas
  })

  it('dispensar não conta como fracasso da recepção', () => {
    // Fila inteira dispensada não é 0% de esforço: é 0% de retorno com 100% de
    // trabalho feito. Um indicador que pune dispensar produz clínica que insiste.
    const r = recuperacaoDaFila({ criadas: 4, resolvidas: 0, dispensadas: 4, pendentes: 0 })
    expect(r.taxa).toBe(0)
    expect(r.taxaTrabalhada).toBe(0)
    expect(r.dispensadas).toBe(4)
  })

  it('fila vazia é null, não zero', () => {
    const r = recuperacaoDaFila({ criadas: 0, resolvidas: 0, dispensadas: 0, pendentes: 0 })
    expect(r.taxa).toBeNull()
    expect(r.taxaTrabalhada).toBeNull()
  })

  it('nada trabalhado ainda: taxaTrabalhada é null', () => {
    const r = recuperacaoDaFila({ criadas: 6, resolvidas: 0, dispensadas: 0, pendentes: 6 })
    expect(r.taxa).toBe(0)
    expect(r.taxaTrabalhada).toBeNull()
  })
})
