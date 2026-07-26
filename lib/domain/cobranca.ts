import { comparaData } from './datas'
import { compara, deCentavos, paraCentavos, somar, subtrair } from './dinheiro'
import { erro } from './erros'

/**
 * Situação de parcela e agregados de cobrança.
 *
 * ── A situação é DERIVADA, não guardada como verdade ────────────────────────
 * `vencida` depende de "hoje": um booleano gravado estaria errado toda
 * meia-noite e exigiria um cron para consertar. `paga` e `parcial` dependem da
 * soma dos pagamentos, que muda a cada baixa.
 *
 * A coluna `parcela.status` existe como **cache mantido pelo banco** (trigger em
 * drizzle/0007), não como fonte da verdade — e nem ela sabe de `vencida`, porque
 * o banco não deveria precisar de um job para envelhecer linha.
 *
 * Mesma decisão de `statusApresentado` no orçamento.
 */

export type SituacaoParcela = 'aberta' | 'parcial' | 'paga' | 'vencida' | 'cancelada'

export interface PagamentoDaParcela {
  readonly valor: string
  /** Estornado não conta como recebido, mas continua no histórico. */
  readonly estornadoEm: Date | null
  readonly conciliado: boolean
}

export interface ParcelaParaSituacao {
  readonly valor: string
  readonly vencimento: string
  readonly status: SituacaoParcela
  readonly pagamentos: readonly PagamentoDaParcela[]
}

/** Soma dos pagamentos não estornados. */
export function totalPago(pagamentos: readonly PagamentoDaParcela[]): string {
  const validos = pagamentos.filter((p) => p.estornadoEm === null)
  return validos.length === 0 ? '0.00' : somar(...validos.map((p) => p.valor))
}

/**
 * Só o que foi CONCILIADO conta para comissão.
 *
 * Cheque devolvido e PIX não identificado aparecem como pagamento antes de o
 * dinheiro existir de fato. Comissão sobre valor não conciliado é adiantamento —
 * justamente o que a clínica quis evitar ao escolher a base "valor recebido".
 */
export function totalConciliado(pagamentos: readonly PagamentoDaParcela[]): string {
  const validos = pagamentos.filter((p) => p.estornadoEm === null && p.conciliado)
  return validos.length === 0 ? '0.00' : somar(...validos.map((p) => p.valor))
}

export function saldoDaParcela(p: ParcelaParaSituacao): string {
  return subtrair(p.valor, totalPago(p.pagamentos))
}

/**
 * Situação da parcela na data de referência.
 *
 * Ordem de precedência, e ela importa:
 *   1. `cancelada` — decisão explícita, ignora pagamento e vencimento
 *   2. `paga` — quitada, mesmo que tenha vencido antes de pagar
 *   3. `vencida` — passou do dia e ainda há saldo
 *   4. `parcial` — recebeu algo, ainda no prazo
 *   5. `aberta`
 *
 * `paga` vence `vencida` de propósito: quem pagou com atraso não é inadimplente
 * hoje, e listar assim faria a recepção cobrar quem já quitou.
 */
export function situacaoDaParcela(p: ParcelaParaSituacao, hojeIso: string): SituacaoParcela {
  if (p.status === 'cancelada') return 'cancelada'

  const pago = totalPago(p.pagamentos)
  if (compara(pago, p.valor) >= 0) return 'paga'

  // Vence NO dia: o último dia ainda está em aberto, não vencido.
  if (comparaData(p.vencimento, hojeIso) < 0) return 'vencida'

  return compara(pago, '0.00') > 0 ? 'parcial' : 'aberta'
}

/** Dias de atraso. Zero quando não está vencida. */
export function diasDeAtraso(p: ParcelaParaSituacao, hojeIso: string): number {
  if (situacaoDaParcela(p, hojeIso) !== 'vencida') return 0
  const [a1, m1, d1] = p.vencimento.split('-').map(Number)
  const [a2, m2, d2] = hojeIso.split('-').map(Number)
  return Math.round(
    (Date.UTC(a2!, m2! - 1, d2!) - Date.UTC(a1!, m1! - 1, d1!)) / 86_400_000,
  )
}

// ── Agregados da cobrança ────────────────────────────────────────────────────

export interface ResumoCobranca {
  readonly total: string
  readonly pago: string
  readonly conciliado: string
  readonly aReceber: string
  readonly emAtraso: string
  readonly parcelas: number
  readonly parcelasPagas: number
  readonly parcelasVencidas: number
  readonly quitada: boolean
}

/**
 * Consolida a cobrança.
 *
 * `emAtraso` é o saldo só das parcelas vencidas — distinto de `aReceber`, que é
 * tudo que falta. Confundir os dois faz o painel mostrar a clínica inteira como
 * inadimplente no primeiro dia útil.
 */
export function resumirCobranca(
  parcelas: readonly ParcelaParaSituacao[],
  hojeIso: string,
): ResumoCobranca {
  const ativas = parcelas.filter((p) => p.status !== 'cancelada')

  const total = ativas.length === 0 ? '0.00' : somar(...ativas.map((p) => p.valor))
  const pago = ativas.length === 0 ? '0.00' : somar(...ativas.map((p) => totalPago(p.pagamentos)))
  const conciliado =
    ativas.length === 0 ? '0.00' : somar(...ativas.map((p) => totalConciliado(p.pagamentos)))

  const vencidas = ativas.filter((p) => situacaoDaParcela(p, hojeIso) === 'vencida')
  const emAtraso =
    vencidas.length === 0 ? '0.00' : somar(...vencidas.map((p) => saldoDaParcela(p)))

  const pagas = ativas.filter((p) => situacaoDaParcela(p, hojeIso) === 'paga').length

  return {
    total,
    pago,
    conciliado,
    aReceber: subtrair(total, pago),
    emAtraso,
    parcelas: ativas.length,
    parcelasPagas: pagas,
    parcelasVencidas: vencidas.length,
    quitada: ativas.length > 0 && pagas === ativas.length,
  }
}

/**
 * Quanto ainda cabe numa parcela.
 *
 * Espelha o trigger `pagamento_nao_excede_parcela`: a aplicação recusa antes com
 * mensagem boa, e o banco recusa de todo jeito se duas baixas simultâneas
 * passarem pela checagem.
 */
export function exigirPagamentoCabe(p: ParcelaParaSituacao, valor: string): void {
  if (paraCentavos(valor) <= 0) {
    erro('PAGAMENTO_NAO_POSITIVO', 'O valor do pagamento precisa ser maior que zero.', { valor })
  }
  if (p.status === 'cancelada') {
    erro('PARCELA_CANCELADA', 'Não é possível receber numa parcela cancelada.')
  }

  const saldo = saldoDaParcela(p)
  if (compara(saldo, '0.00') <= 0) {
    erro('PARCELA_QUITADA', 'Esta parcela já está quitada.')
  }
  if (compara(valor, saldo) > 0) {
    erro(
      'PAGAMENTO_EXCEDE_SALDO',
      `O valor de ${valor} excede o saldo da parcela, que é ${saldo}.`,
      { valor, saldo },
    )
  }
}

export const ROTULO_SITUACAO: Readonly<Record<SituacaoParcela, string>> = {
  aberta: 'Aberta',
  parcial: 'Parcial',
  paga: 'Paga',
  vencida: 'Vencida',
  cancelada: 'Cancelada',
}

/**
 * Fração do total já recebida e conciliada, como percentual em texto.
 * É o multiplicador do rateio de comissão — ver `lib/domain/comissao.ts`.
 */
export function fracaoConciliada(total: string, conciliado: string): string {
  const t = paraCentavos(total)
  if (t <= 0) return '0'
  return ((paraCentavos(conciliado) * 100) / t).toFixed(6)
}

export { deCentavos, paraCentavos }
