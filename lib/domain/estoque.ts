import { comparaData } from './datas'
import { deCentavos, paraCentavos, somar } from './dinheiro'
import { erro } from './erros'
import { diasEntre } from './periodo'
import { comparaQtd, deMilesimos, paraMilesimos, somarQtd } from './quantidade'

/**
 * Regras de estoque: saldo, validade, FEFO e ponto de reposição.
 *
 * Duas coisas neste arquivo existem porque a intuição erra:
 *
 * 1. **FEFO, não FIFO.** Sai primeiro o lote que **vence** primeiro, não o que
 *    chegou primeiro. Parecem a mesma coisa e não são: uma compra de reposição
 *    frequentemente traz validade mais curta que a caixa que ainda está na
 *    prateleira (fornecedor escoando estoque). Consumir por ordem de chegada
 *    deixa o lote curto vencer com saldo — perda que ninguém vê acontecer.
 *
 * 2. **Vencimento é dia civil no fuso da clínica.** Um lote com validade
 *    31/07 ainda serve às 22h de 31/07 em São Paulo — que já é 01/08 em UTC.
 *    Comparar instantes descartaria material bom, ou pior, aprovaria material
 *    vencido no outro sentido. Por isso toda função daqui recebe `hoje` como
 *    `YYYY-MM-DD` já resolvido pelo fuso (`diaLocalIso`), e nunca chama `Date`.
 */

// ── Validade ──────────────────────────────────────────────────────────────────

export type SituacaoValidade = 'sem_validade' | 'vencido' | 'vence_em_breve' | 'ok'

export interface AvaliacaoValidade {
  readonly situacao: SituacaoValidade
  /** Dias até vencer. Negativo se já venceu; null se o material não tem validade. */
  readonly diasParaVencer: number | null
  readonly rotulo: string
}

/** Antecedência padrão do alerta. 60 dias é o prazo típico de reposição do fornecedor. */
export const DIAS_ALERTA_VALIDADE = 60

/**
 * Classifica a validade de um lote.
 *
 * `validade` null = material sem validade (instrumental, equipamento). Não é o
 * mesmo que validade desconhecida: quem não sabe a validade não deve registrar
 * o lote como perene.
 */
export function classificarValidade(
  validade: string | null,
  hoje: string,
  diasAlerta: number = DIAS_ALERTA_VALIDADE,
): AvaliacaoValidade {
  if (validade === null) {
    return { situacao: 'sem_validade', diasParaVencer: null, rotulo: 'sem validade' }
  }

  // `diasEntre` conta as duas pontas; aqui interessa a diferença.
  const dias = diasEntre(hoje, validade) - 1

  if (comparaData(validade, hoje) < 0) {
    return {
      situacao: 'vencido',
      diasParaVencer: dias,
      rotulo: dias === -1 ? 'vencido ontem' : `vencido há ${-dias} dias`,
    }
  }
  if (dias <= diasAlerta) {
    return {
      situacao: 'vence_em_breve',
      diasParaVencer: dias,
      rotulo: dias === 0 ? 'vence hoje' : dias === 1 ? 'vence amanhã' : `vence em ${dias} dias`,
    }
  }
  return { situacao: 'ok', diasParaVencer: dias, rotulo: `vence em ${dias} dias` }
}

/** Um lote vencido só pode ser descartado — nunca consumido em paciente. */
export function podeConsumir(validade: string | null, hoje: string): boolean {
  return classificarValidade(validade, hoje).situacao !== 'vencido'
}

// ── FEFO ──────────────────────────────────────────────────────────────────────

export interface LoteDisponivel {
  readonly id: string
  readonly saldo: string
  readonly validade: string | null
  /** Desempate entre lotes de mesma validade: o mais antigo na casa sai primeiro. */
  readonly recebidoEm: string
  readonly custoUnitario?: string
}

export interface Alocacao {
  readonly loteId: string
  readonly quantidade: string
}

export interface PlanoDeBaixa {
  readonly alocacoes: readonly Alocacao[]
  /** O que não deu para alocar. "0.000" quando o estoque cobriu tudo. */
  readonly faltante: string
  readonly atende: boolean
  /** Lotes ignorados por estarem vencidos — a tela avisa em vez de sumir com eles. */
  readonly vencidosIgnorados: readonly string[]
}

/**
 * Ordena por FEFO: validade mais próxima primeiro, sem-validade no fim,
 * desempate pelo recebimento mais antigo.
 *
 * Sem-validade vai no fim de propósito: material perene não corre risco de
 * perda, então gastar antes o que pode vencer é sempre a escolha certa.
 */
export function ordenarFefo(lotes: readonly LoteDisponivel[]): readonly LoteDisponivel[] {
  return [...lotes].sort((a, b) => {
    if (a.validade === null && b.validade === null) {
      return a.recebidoEm.localeCompare(b.recebidoEm)
    }
    if (a.validade === null) return 1
    if (b.validade === null) return -1
    const porValidade = comparaData(a.validade, b.validade)
    if (porValidade !== 0) return porValidade
    return a.recebidoEm.localeCompare(b.recebidoEm)
  })
}

/**
 * Monta o plano de baixa de uma quantidade, respeitando FEFO.
 *
 * Não persiste nada e não lança por falta de saldo: devolve `faltante` para a
 * tela poder dizer "faltam 3 tubetes" antes de o dentista começar. Um erro aqui
 * viraria exceção no meio do atendimento.
 */
export function planejarBaixaFefo(
  lotes: readonly LoteDisponivel[],
  quantidade: string,
  hoje: string,
): PlanoDeBaixa {
  const pedido = paraMilesimos(quantidade)
  if (pedido <= 0) {
    erro('QUANTIDADE_NAO_POSITIVA', `Baixa exige quantidade positiva, recebido "${quantidade}".`, {
      quantidade,
    })
  }

  const vencidos = lotes.filter((l) => !podeConsumir(l.validade, hoje) && paraMilesimos(l.saldo) > 0)
  const usaveis = ordenarFefo(
    lotes.filter((l) => podeConsumir(l.validade, hoje) && paraMilesimos(l.saldo) > 0),
  )

  const alocacoes: Alocacao[] = []
  let restante = pedido

  for (const lote of usaveis) {
    if (restante <= 0) break
    const disponivel = paraMilesimos(lote.saldo)
    const usar = Math.min(disponivel, restante)
    alocacoes.push({ loteId: lote.id, quantidade: deMilesimos(usar) })
    restante -= usar
  }

  return {
    alocacoes,
    faltante: deMilesimos(Math.max(0, restante)),
    atende: restante <= 0,
    vencidosIgnorados: vencidos.map((l) => l.id),
  }
}

/** Custo do consumo pelo custo REAL de cada lote — não por média do material. */
export function custoDaBaixa(
  plano: PlanoDeBaixa,
  lotes: readonly LoteDisponivel[],
): string {
  const porId = new Map(lotes.map((l) => [l.id, l]))
  let centavos = 0
  for (const a of plano.alocacoes) {
    const custo = porId.get(a.loteId)?.custoUnitario
    if (custo === undefined) continue
    // Milésimos × centavos / 1000, arredondado ao centavo.
    centavos += Math.round((paraMilesimos(a.quantidade) * paraCentavos(custo)) / 1000)
  }
  return deCentavos(centavos)
}

// ── Saldo ─────────────────────────────────────────────────────────────────────

/**
 * Tipos de movimento. O sinal da quantidade é ditado pelo tipo — ver
 * `sinalEsperado`. Guardar quantidade assinada (em vez de quantidade positiva
 * + direção) faz do saldo uma soma trivial, que é como um livro-caixa fecha.
 */
export const TIPOS_MOVIMENTO = [
  'entrada',
  'consumo',
  'descarte',
  'devolucao',
  'ajuste',
] as const
export type TipoMovimento = (typeof TIPOS_MOVIMENTO)[number]

export const ROTULO_MOVIMENTO: Record<TipoMovimento, string> = {
  entrada: 'Entrada',
  consumo: 'Consumo',
  descarte: 'Descarte',
  devolucao: 'Devolução ao fornecedor',
  ajuste: 'Ajuste de inventário',
}

/** +1 sempre positivo, −1 sempre negativo, 0 = qualquer um menos zero (ajuste). */
export function sinalEsperado(tipo: TipoMovimento): 1 | -1 | 0 {
  switch (tipo) {
    case 'entrada':
      return 1
    case 'consumo':
    case 'descarte':
    case 'devolucao':
      return -1
    case 'ajuste':
      return 0
  }
}

export interface Movimento {
  readonly tipo: TipoMovimento
  readonly quantidade: string
}

/** Saldo é soma dos movimentos. Nunca um número digitado. */
export function saldoDeMovimentos(movimentos: readonly Movimento[]): string {
  return somarQtd(...movimentos.map((m) => m.quantidade))
}

/**
 * Valida um movimento antes de gravar.
 *
 * O motivo é obrigatório em ajuste e descarte, e não é burocracia: "sobrou 3 na
 * contagem" e "quebrou o frasco" são fatos diferentes, e sem o motivo a
 * diferença some — depois ninguém sabe se o estoque some por perda ou por erro
 * de lançamento.
 */
export function validarMovimento(m: {
  readonly tipo: TipoMovimento
  readonly quantidade: string
  readonly motivo?: string | null
}): { readonly ok: true } | { readonly ok: false; readonly mensagem: string } {
  const q = paraMilesimos(m.quantidade)
  if (q === 0) return { ok: false, mensagem: 'Movimento de quantidade zero não é movimento.' }

  const esperado = sinalEsperado(m.tipo)
  if (esperado === 1 && q < 0) {
    return { ok: false, mensagem: 'Entrada tem quantidade positiva.' }
  }
  if (esperado === -1 && q > 0) {
    return {
      ok: false,
      mensagem: `${ROTULO_MOVIMENTO[m.tipo]} tem quantidade negativa — é saída de estoque.`,
    }
  }
  if ((m.tipo === 'ajuste' || m.tipo === 'descarte') && !m.motivo?.trim()) {
    return {
      ok: false,
      mensagem: `${ROTULO_MOVIMENTO[m.tipo]} exige motivo: sem ele, perda e erro de lançamento ficam indistinguíveis.`,
    }
  }
  return { ok: true }
}

// ── Reposição ─────────────────────────────────────────────────────────────────

export type SituacaoReposicao = 'zerado' | 'abaixo_do_minimo' | 'proximo_do_minimo' | 'ok'

export interface AvaliacaoReposicao {
  readonly situacao: SituacaoReposicao
  readonly saldo: string
  readonly minimo: string
  /** Quanto comprar para voltar ao nível de referência. "0.000" se não precisa. */
  readonly sugestaoDeCompra: string
  readonly rotulo: string
}

/**
 * Avalia o saldo contra o mínimo.
 *
 * A sugestão de compra repõe até **duas vezes o mínimo**, não até o mínimo:
 * comprar exatamente o mínimo deixa o material em alerta no dia seguinte à
 * entrega, e o alerta que dispara sempre é o alerta que ninguém lê.
 */
export function avaliarReposicao(saldo: string, minimo: string): AvaliacaoReposicao {
  const s = paraMilesimos(saldo)
  const m = paraMilesimos(minimo)

  const alvo = m * 2
  const sugestao = s < m ? deMilesimos(Math.max(0, alvo - s)) : '0.000'

  if (s <= 0) {
    return {
      situacao: 'zerado',
      saldo,
      minimo,
      sugestaoDeCompra: m > 0 ? deMilesimos(alvo) : '0.000',
      rotulo: 'zerado',
    }
  }
  if (m <= 0) {
    return { situacao: 'ok', saldo, minimo, sugestaoDeCompra: '0.000', rotulo: 'sem mínimo definido' }
  }
  if (s < m) {
    return { situacao: 'abaixo_do_minimo', saldo, minimo, sugestaoDeCompra: sugestao, rotulo: 'abaixo do mínimo' }
  }
  // Dentro de 20% acima do mínimo: ainda não é alerta, mas entra na lista de compras.
  if (s <= Math.ceil(m * 1.2)) {
    return { situacao: 'proximo_do_minimo', saldo, minimo, sugestaoDeCompra: '0.000', rotulo: 'perto do mínimo' }
  }
  return { situacao: 'ok', saldo, minimo, sugestaoDeCompra: '0.000', rotulo: 'ok' }
}

/**
 * Consumo médio por dia no período, contando só saídas de consumo.
 *
 * Descarte fica fora: material que venceu na prateleira não é demanda, e
 * incluí-lo faria a clínica comprar mais do mesmo material que já perde por
 * validade.
 */
export function consumoMedioDiario(
  movimentos: readonly Movimento[],
  dias: number,
): string {
  if (!Number.isInteger(dias) || dias < 1) {
    erro('PERIODO_INVALIDO', `Período em dias deve ser inteiro >= 1, recebido ${dias}.`, { dias })
  }
  const consumido = movimentos
    .filter((m) => m.tipo === 'consumo')
    .reduce((acc, m) => acc + Math.abs(paraMilesimos(m.quantidade)), 0)
  return deMilesimos(Math.round(consumido / dias))
}

/**
 * Dias que o saldo cobre no ritmo atual. `null` quando não há consumo no
 * período — sem histórico não se projeta nada, e devolver Infinity aqui viraria
 * "cobertura de ∞ dias" na tela.
 */
export function diasDeCobertura(saldo: string, consumoDiario: string): number | null {
  const c = paraMilesimos(consumoDiario)
  if (c <= 0) return null
  return Math.floor(paraMilesimos(saldo) / c)
}

// ── Ficha técnica ─────────────────────────────────────────────────────────────

export interface InsumoDoProcedimento {
  readonly materialId: string
  readonly quantidade: string
}

/**
 * Consolida os insumos de vários procedimentos executados no mesmo atendimento.
 *
 * Duas restaurações no mesmo dente usam um anestésico, não dois — mas a
 * consolidação aqui é por material e **soma**, porque o caso geral (dois dentes,
 * duas sessões de anestesia) é o oposto. Quem confirma a baixa ajusta na tela;
 * o sistema propõe o total e não decide sozinho o que o dentista fez.
 */
export function consolidarInsumos(
  fichas: readonly (readonly InsumoDoProcedimento[])[],
): readonly InsumoDoProcedimento[] {
  const total = new Map<string, string>()
  for (const ficha of fichas) {
    for (const item of ficha) {
      const atual = total.get(item.materialId)
      total.set(item.materialId, atual === undefined ? item.quantidade : somarQtd(atual, item.quantidade))
    }
  }
  return [...total.entries()]
    .map(([materialId, quantidade]) => ({ materialId, quantidade }))
    .sort((a, b) => a.materialId.localeCompare(b.materialId))
}

/** Valor total imobilizado: soma de saldo × custo de cada lote. */
export function valorEmEstoque(lotes: readonly LoteDisponivel[]): string {
  return lotes.reduce((acc, l) => {
    if (l.custoUnitario === undefined) return acc
    return somar(acc, deCentavos(Math.round((paraMilesimos(l.saldo) * paraCentavos(l.custoUnitario)) / 1000)))
  }, '0.00')
}

/** Ordena o que precisa de atenção primeiro: zerado, abaixo, vencendo. */
export function urgenciaDeReposicao(a: SituacaoReposicao): number {
  return { zerado: 0, abaixo_do_minimo: 1, proximo_do_minimo: 2, ok: 3 }[a]
}

export { comparaQtd }
