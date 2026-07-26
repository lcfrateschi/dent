import { paraCentavos } from './dinheiro'
import { erro } from './erros'

/**
 * Indicadores do painel.
 *
 * Este arquivo existe por um motivo específico: **um painel erra pior que uma
 * tela de cadastro**. Um campo errado alguém corrige; um número errado vira
 * decisão — contratar, demitir, mudar preço. As três armadilhas que ele fecha:
 *
 * 1. **Produção e caixa não se somam.** O que foi executado e o que entrou no
 *    caixa são grandezas diferentes, e um painel que as junta num "faturamento"
 *    responde a pergunta errada. Aqui elas são campos distintos e nunca há uma
 *    função que devolva a soma dos dois.
 *
 * 2. **Falta não é cancelamento.** Quem avisou que não vem liberou o horário;
 *    quem não apareceu queimou a cadeira. Misturar os dois esconde os dois: a
 *    taxa fica alta e ninguém sabe se o problema é o lembrete ou a agenda.
 *
 * 3. **Divisão por zero.** Mês sem atendimento tem taxa *indefinida*, não zero, e
 *    variação sobre base zero não é "+∞%" nem "+100%". Quando não há base, o
 *    resultado é `null` e a tela escreve "—". Um painel que mostra 0% onde não
 *    sabe é um painel que mente com cara de precisão.
 */

// ── Ocupação ─────────────────────────────────────────────────────────────────

export interface EntradaOcupacao {
  /** Minutos de agenda que a clínica tinha disponíveis no período. */
  readonly minutosDisponiveis: number
  /** Minutos reservados por agendamentos que não foram cancelados. */
  readonly minutosReservados: number
  /** Minutos de atendimento que realmente aconteceram (concluído). */
  readonly minutosRealizados: number
  /** Minutos perdidos por falta — reservados e não realizados. */
  readonly minutosPerdidosPorFalta: number
}

export interface Ocupacao {
  /** Quanto da agenda estava reservado. `null` sem horas disponíveis. */
  readonly reservada: number | null
  /** Quanto da agenda virou atendimento. */
  readonly realizada: number | null
  /** Quanto da agenda foi reservado e perdido por falta. */
  readonly perdida: number | null
  readonly minutosDisponiveis: number
  readonly minutosReservados: number
  readonly minutosRealizados: number
  readonly minutosPerdidosPorFalta: number
}

/**
 * Ocupação da agenda, em duas medidas.
 *
 * **Reservada e realizada são perguntas diferentes.** 90% reservada com 20% de
 * falta é um problema de confirmação; 65% reservada sem falta é um problema de
 * captação. Um número só faria os dois casos parecerem iguais, e a ação para cada
 * um é oposta.
 */
export function calcularOcupacao(e: EntradaOcupacao): Ocupacao {
  for (const [nome, valor] of Object.entries(e)) {
    if (!Number.isFinite(valor) || valor < 0) {
      erro('MINUTOS_INVALIDOS', `${nome} inválido: ${valor}.`, { [nome]: valor })
    }
  }

  const base = e.minutosDisponiveis
  const taxa = (minutos: number): number | null =>
    base === 0 ? null : Math.round((minutos / base) * 1000) / 10

  return {
    reservada: taxa(e.minutosReservados),
    realizada: taxa(e.minutosRealizados),
    perdida: taxa(e.minutosPerdidosPorFalta),
    minutosDisponiveis: e.minutosDisponiveis,
    minutosReservados: e.minutosReservados,
    minutosRealizados: e.minutosRealizados,
    minutosPerdidosPorFalta: e.minutosPerdidosPorFalta,
  }
}

// ── Comparecimento ───────────────────────────────────────────────────────────

export interface EntradaComparecimento {
  readonly concluidos: number
  readonly faltas: number
  readonly cancelados: number
  /** Agendados cujo horário ainda não chegou. Ficam FORA das taxas. */
  readonly futuros: number
}

export interface Comparecimento {
  /**
   * Faltas sobre o que era para acontecer (concluído + falta).
   *
   * Cancelado **não** entra na base: quem avisou liberou o horário, e é outro
   * fenômeno. Contar junto faria um mês com muitos cancelamentos avisados parecer
   * um mês de faltas.
   */
  readonly taxaDeFalta: number | null
  /** Cancelamentos sobre tudo que foi marcado para o período. */
  readonly taxaDeCancelamento: number | null
  readonly concluidos: number
  readonly faltas: number
  readonly cancelados: number
  readonly futuros: number
  /** Total marcado no período, incluindo o que ainda vai acontecer. */
  readonly marcados: number
}

export function calcularComparecimento(e: EntradaComparecimento): Comparecimento {
  for (const [nome, valor] of Object.entries(e)) {
    if (!Number.isInteger(valor) || valor < 0) {
      erro('CONTAGEM_INVALIDA', `${nome} inválido: ${valor}.`, { [nome]: valor })
    }
  }

  const baseFalta = e.concluidos + e.faltas
  const marcados = e.concluidos + e.faltas + e.cancelados + e.futuros

  return {
    taxaDeFalta: baseFalta === 0 ? null : arredondar((e.faltas / baseFalta) * 100),
    taxaDeCancelamento: marcados === 0 ? null : arredondar((e.cancelados / marcados) * 100),
    concluidos: e.concluidos,
    faltas: e.faltas,
    cancelados: e.cancelados,
    futuros: e.futuros,
    marcados,
  }
}

/**
 * Efeito da confirmação sobre a falta.
 *
 * A pergunta que a Fase 9 permite responder: **quem confirmou falta menos?** Se a
 * diferença for pequena, o lembrete está custando trabalho sem entregar resultado
 * — e vale saber disso em vez de supor.
 */
export interface EntradaEfeitoConfirmacao {
  readonly confirmadosQueVieram: number
  readonly confirmadosQueFaltaram: number
  readonly naoConfirmadosQueVieram: number
  readonly naoConfirmadosQueFaltaram: number
}

export interface EfeitoConfirmacao {
  readonly faltaComConfirmacao: number | null
  readonly faltaSemConfirmacao: number | null
  /**
   * Diferença em pontos percentuais. Positiva = confirmar reduz falta.
   * `null` quando um dos dois lados não tem caso suficiente para comparar.
   */
  readonly diferencaEmPontos: number | null
  readonly baseConfirmados: number
  readonly baseNaoConfirmados: number
}

/** Abaixo disto a diferença é ruído, não sinal. */
const MINIMO_PARA_COMPARAR = 10

export function calcularEfeitoConfirmacao(e: EntradaEfeitoConfirmacao): EfeitoConfirmacao {
  const baseConfirmados = e.confirmadosQueVieram + e.confirmadosQueFaltaram
  const baseNaoConfirmados = e.naoConfirmadosQueVieram + e.naoConfirmadosQueFaltaram

  const comConfirmacao =
    baseConfirmados === 0 ? null : arredondar((e.confirmadosQueFaltaram / baseConfirmados) * 100)
  const semConfirmacao =
    baseNaoConfirmados === 0
      ? null
      : arredondar((e.naoConfirmadosQueFaltaram / baseNaoConfirmados) * 100)

  // Só compara com amostra que sustente a comparação. Dizer "confirmar reduz a
  // falta em 40 pontos" com 3 casos é inventar.
  const comparavel =
    comConfirmacao !== null &&
    semConfirmacao !== null &&
    baseConfirmados >= MINIMO_PARA_COMPARAR &&
    baseNaoConfirmados >= MINIMO_PARA_COMPARAR

  return {
    faltaComConfirmacao: comConfirmacao,
    faltaSemConfirmacao: semConfirmacao,
    diferencaEmPontos: comparavel ? arredondar(semConfirmacao! - comConfirmacao!) : null,
    baseConfirmados,
    baseNaoConfirmados,
  }
}

// ── Variação entre períodos ──────────────────────────────────────────────────

export type Direcao = 'subiu' | 'caiu' | 'igual' | 'sem_base' | 'do_nada'

export interface Variacao {
  /** Percentual de variação. `null` quando não há base para comparar. */
  readonly percentual: number | null
  readonly direcao: Direcao
  /** Texto pronto para a tela: '+12,5%', '—', 'do zero'. */
  readonly rotulo: string
}

/**
 * Variação entre dois valores.
 *
 * O caso que importa é a base zero. `(10 - 0) / 0` é infinito, e um painel que
 * mostra "+Infinity%" ou "+100%" ali está errado das duas formas: a primeira é
 * lixo visível, a segunda é lixo invisível. Base zero com valor positivo é
 * **"do zero"** — informação verdadeira e útil, sem número inventado.
 */
export function calcularVariacao(atual: number, anterior: number): Variacao {
  if (!Number.isFinite(atual) || !Number.isFinite(anterior)) {
    erro('VARIACAO_INVALIDA', 'Valores não finitos na variação.', { atual, anterior })
  }

  if (anterior === 0) {
    if (atual === 0) return { percentual: null, direcao: 'igual', rotulo: '—' }
    return { percentual: null, direcao: 'do_nada', rotulo: atual > 0 ? 'do zero' : '—' }
  }

  const pct = arredondar(((atual - anterior) / Math.abs(anterior)) * 100)
  if (pct === 0) return { percentual: 0, direcao: 'igual', rotulo: '0%' }

  return {
    percentual: pct,
    direcao: pct > 0 ? 'subiu' : 'caiu',
    rotulo: `${pct > 0 ? '+' : ''}${formatarPercentual(pct)}`,
  }
}

/** Variação de dinheiro, comparando em centavos inteiros. */
export function variacaoDeDinheiro(atual: string, anterior: string): Variacao {
  return calcularVariacao(paraCentavos(atual), paraCentavos(anterior))
}

/**
 * Se uma variação é boa ou ruim depende do indicador.
 *
 * Faturamento subindo é bom; taxa de falta subindo é ruim. Sem isto a tela
 * pintaria de verde uma falta em alta.
 */
export type Sentido = 'maior_melhor' | 'menor_melhor'

export function tomDaVariacao(v: Variacao, sentido: Sentido): 'bom' | 'ruim' | 'neutro' {
  if (v.direcao === 'igual' || v.direcao === 'sem_base') return 'neutro'
  const subindo = v.direcao === 'subiu' || v.direcao === 'do_nada'
  if (sentido === 'maior_melhor') return subindo ? 'bom' : 'ruim'
  return subindo ? 'ruim' : 'bom'
}

// ── Ticket médio ─────────────────────────────────────────────────────────────

/**
 * Valor médio por paciente atendido.
 *
 * O divisor é **paciente distinto**, não número de atendimentos: um paciente que
 * veio seis vezes para um canal não é seis pacientes, e usar atendimentos faria o
 * ticket cair quanto mais sessões o tratamento tem — o contrário do que a clínica
 * entende por ticket.
 */
export function ticketMedio(totalCentavos: number, pacientesDistintos: number): number | null {
  if (!Number.isInteger(pacientesDistintos) || pacientesDistintos < 0) {
    erro('CONTAGEM_INVALIDA', `Número de pacientes inválido: ${pacientesDistintos}.`)
  }
  if (pacientesDistintos === 0) return null
  return Math.round(totalCentavos / pacientesDistintos)
}

// ── Formatação ───────────────────────────────────────────────────────────────

function arredondar(n: number): number {
  return Math.round(n * 10) / 10
}

/** 12.5 → '12,5%'; 12 → '12%'. Vírgula decimal, e sem casa inútil. */
export function formatarPercentual(n: number): string {
  const abs = Math.abs(n)
  const texto = Number.isInteger(abs) ? String(abs) : abs.toFixed(1).replace('.', ',')
  return `${n < 0 ? '-' : ''}${texto}%`
}

/** Taxa que pode ser indefinida. `null` vira '—', nunca '0%'. */
export function formatarTaxa(n: number | null): string {
  return n === null ? '—' : formatarPercentual(n)
}

/** 135 → '2h15'; 60 → '1h'; 45 → '45min'. */
export function formatarMinutos(minutos: number): string {
  if (!Number.isFinite(minutos) || minutos < 0) return '—'
  const total = Math.round(minutos)
  const horas = Math.floor(total / 60)
  const resto = total % 60
  if (horas === 0) return `${resto}min`
  if (resto === 0) return `${horas}h`
  return `${horas}h${String(resto).padStart(2, '0')}`
}
