import { addMeses } from './datas'
import { paraCentavos, ratear, somar } from './dinheiro'
import { erro } from './erros'

export interface ParcelaGerada {
  readonly numero: number
  readonly vencimento: string
  readonly valor: string
}

export interface OpcoesParcelamento {
  /** Total da cobrança, "1234.56". */
  readonly total: string
  readonly quantidade: number
  /** Vencimento da primeira parcela, "YYYY-MM-DD". */
  readonly primeiroVencimento: string
  /** Intervalo entre parcelas em meses. 1 = mensal (padrão). */
  readonly intervaloMeses?: number
}

const MAX_PARCELAS = 60

/**
 * Gera as parcelas de uma cobrança.
 *
 * Invariante: a soma dos valores é EXATAMENTE o total — o mesmo que o trigger
 * `parcela_soma_confere` verifica no banco. A sobra do arredondamento vai na
 * primeira parcela.
 *
 * O vencimento é calculado sempre a partir do primeiro, nunca do anterior, para
 * que o clamp de fim de mês não acumule: 31/jan → 28/fev → 31/mar (e não 28/mar).
 */
export function gerarParcelas({
  total,
  quantidade,
  primeiroVencimento,
  intervaloMeses = 1,
}: OpcoesParcelamento): ParcelaGerada[] {
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > MAX_PARCELAS) {
    erro(
      'QUANTIDADE_PARCELAS_INVALIDA',
      `Quantidade de parcelas deve ser inteiro entre 1 e ${MAX_PARCELAS}, recebido ${quantidade}.`,
      { quantidade },
    )
  }
  if (!Number.isInteger(intervaloMeses) || intervaloMeses < 1) {
    erro('INTERVALO_INVALIDO', `Intervalo em meses deve ser inteiro >= 1, recebido ${intervaloMeses}.`, {
      intervaloMeses,
    })
  }

  const totalCentavos = paraCentavos(total)
  if (totalCentavos <= 0) {
    erro('TOTAL_INVALIDO', `Total da cobrança deve ser positivo, recebido ${total}.`, { total })
  }
  // Cada parcela tem CHECK valor > 0 no banco; não faz sentido gerar parcela de zero.
  if (totalCentavos < quantidade) {
    erro(
      'TOTAL_INSUFICIENTE',
      `Total ${total} não dá para ${quantidade} parcelas de ao menos um centavo.`,
      { total, quantidade },
    )
  }

  const valores = ratear(total, quantidade)

  return valores.map((valor, i) => ({
    numero: i + 1,
    vencimento: addMeses(primeiroVencimento, i * intervaloMeses),
    valor,
  }))
}

/** Confere a invariante do banco em memória, antes de tentar persistir. */
export function somaConfere(total: string, parcelas: readonly ParcelaGerada[]): boolean {
  if (parcelas.length === 0) return false
  return paraCentavos(somar(...parcelas.map((p) => p.valor))) === paraCentavos(total)
}
