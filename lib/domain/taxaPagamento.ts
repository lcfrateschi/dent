import { comparaData } from './datas'
import { deCentavos, paraCentavos, somar, subtrair } from './dinheiro'
import { erro } from './erros'

/**
 * A taxa do meio de pagamento (MDR), e o valor que de fato chega na conta.
 *
 * ── Por que isto não é um detalhe contábil ──────────────────────────────────
 * O paciente paga R$ 100 no crédito e caem R$ 97,51. Os R$ 2,49 não são um
 * arredondamento: são a diferença entre o que o sistema diz que a clínica recebeu e o
 * que o extrato mostra. Sem isso, a conciliação nunca fecha e alguém conclui que o
 * extrato está errado.
 *
 * ── E por que ela toca a FOLHA DE PAGAMENTO ─────────────────────────────────
 * A comissão é sobre **valor recebido** (`clinica.base_comissao`, decisão fechada).
 * Recebido bruto (100) ou líquido (97,51)? A diferença sai do bolso de alguém, e a
 * resposta não é técnica — é contrato de trabalho. Este módulo calcula os dois e
 * **não escolhe**: quem escolhe é `clinica.comissao_sobre_liquido`, que nasce `false`
 * (bruto) para não mudar em silêncio a folha de quem já está em operação.
 *
 * ── A taxa aplicada é a VIGENTE NA DATA DO PAGAMENTO ────────────────────────
 * Nunca a de hoje. MDR é renegociado, e recalcular março com o contrato de setembro
 * reescreveria o histórico de quanto a clínica recebeu. É a mesma regra do preço de
 * convênio, pelo mesmo motivo, e há EXCLUDE constraint no banco impedindo duas
 * vigências no mesmo dia — com duas, o líquido dependeria da ordem da consulta.
 */

export interface TaxaVigente {
  readonly meio: string
  readonly percentual: string
  readonly valorFixo: string
  readonly vigenciaInicio: string
  readonly vigenciaFim: string | null
}

/**
 * A taxa que vale para `dataIso`, ou `null` quando não há nenhuma cadastrada.
 *
 * `null` significa **taxa zero conhecida**, não "erro": dinheiro em espécie não tem
 * MDR, e uma clínica que ainda não cadastrou a taxa do crédito recebe o bruto no
 * relatório — o que é o comportamento anterior, e é honesto. O que não pode acontecer
 * é inventar uma taxa média.
 *
 * Quando há mais de uma vigente (não deveria — EXCLUDE constraint), devolve a de
 * início mais recente, igual a `precoVigenteEm`.
 */
export function taxaVigenteEm(
  taxas: readonly TaxaVigente[],
  meio: string,
  dataIso: string,
): TaxaVigente | null {
  const validas = taxas.filter(
    (t) =>
      t.meio === meio &&
      comparaData(t.vigenciaInicio, dataIso) <= 0 &&
      (t.vigenciaFim === null || comparaData(dataIso, t.vigenciaFim) <= 0),
  )
  if (validas.length === 0) return null
  return validas.reduce((melhor, atual) =>
    comparaData(atual.vigenciaInicio, melhor.vigenciaInicio) > 0 ? atual : melhor,
  )
}

export interface Liquido {
  /** O que o paciente pagou. */
  readonly bruto: string
  /** Quanto o meio de pagamento retém. */
  readonly taxa: string
  /** O que chega na conta. */
  readonly liquido: string
}

/**
 * Quebra um pagamento em bruto, taxa e líquido.
 *
 * A aritmética é em centavos inteiros (`lib/domain/dinheiro.ts`) porque
 * `100 * 0.0249` em ponto flutuante é `2.4899999999999998`, e um centavo de diferença
 * por transação vira o mês que não fecha.
 *
 * **A taxa nunca passa do bruto.** Uma tarifa fixa de R$ 5 sobre um pagamento de R$ 3
 * produziria líquido negativo — que não existe: o adquirente não cobra mais do que
 * liquidou nessa transação. O caso é raro e o resultado errado seria plausível
 * (líquido negativo somando no caixa), então é travado aqui em vez de tratado depois.
 */
export function quebrarLiquido(bruto: string, taxa: TaxaVigente | null): Liquido {
  const brutoCent = paraCentavos(bruto)
  if (brutoCent <= 0) {
    erro('BRUTO_INVALIDO', `Valor bruto precisa ser positivo: ${bruto}.`, { bruto })
  }
  if (!taxa) return { bruto, taxa: '0.00', liquido: bruto }

  const pctCent = Math.round((brutoCent * Number(taxa.percentual)) / 100)
  const total = somar(deCentavos(pctCent), taxa.valorFixo)
  const totalCent = paraCentavos(total)

  if (totalCent > brutoCent) {
    erro(
      'TAXA_ACIMA_DO_BRUTO',
      `A taxa (${total}) passaria do valor pago (${bruto}) — confira o cadastro de ${taxa.meio}.`,
      { bruto, taxa: total, meio: taxa.meio },
    )
  }
  return { bruto, taxa: total, liquido: subtrair(bruto, total) }
}

/**
 * A base da comissão de um pagamento, conforme a escolha da clínica.
 *
 * Existe para que a escolha apareça **uma vez**, num lugar com nome, em vez de um
 * `if` repetido em cada consulta que apura folha. Se amanhã a clínica trocar, muda um
 * valor no banco — não seis consultas.
 */
export function baseDeComissaoDoPagamento(l: Liquido, sobreLiquido: boolean): string {
  return sobreLiquido ? l.liquido : l.bruto
}
