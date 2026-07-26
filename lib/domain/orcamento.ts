import { addDias, comparaData } from './datas'
import { compara, deCentavos, multiplicar, paraCentavos, somar, subtrair } from './dinheiro'
import { erro } from './erros'

/**
 * Regras do orçamento.
 *
 * ── O orçamento é um documento CONGELADO ────────────────────────────────────
 * Não é uma view do plano de tratamento. Quando o paciente recebe um orçamento,
 * aquele papel passa a valer por si: se o plano mudar depois, ou se a tabela de
 * preços subir, o documento enviado **não muda** — gera-se outro.
 *
 * É por isso que `orcamento_item` copia descrição e valor em vez de só
 * referenciar `item_plano`. E é por isso que há trigger no banco impedindo
 * alteração depois de enviado (drizzle/0004_orcamento_congelado.sql): documento
 * comercial que muda depois de entregue é problema jurídico, não bug de tela.
 */

export type StatusOrcamento = 'rascunho' | 'enviado' | 'aprovado' | 'recusado' | 'expirado'

/**
 * rascunho → enviado → aprovado | recusado | expirado
 *
 * `aprovado` e `recusado` são terminais: a decisão do paciente sobre AQUELE
 * documento não se desfaz. Mudou de ideia? Gera-se um novo orçamento.
 * `expirado` também é terminal — reaproveitar um orçamento vencido esconderia
 * que o preço mudou.
 */
const TRANSICOES: Readonly<Record<StatusOrcamento, readonly StatusOrcamento[]>> = {
  rascunho: ['enviado'],
  enviado: ['aprovado', 'recusado', 'expirado'],
  aprovado: [],
  recusado: [],
  expirado: [],
}

/** Só rascunho pode ser editado ou excluído. */
export function ehEditavel(status: StatusOrcamento): boolean {
  return status === 'rascunho'
}

export function podeTransicionar(de: StatusOrcamento, para: StatusOrcamento): boolean {
  return TRANSICOES[de].includes(para)
}

export function exigirTransicao(de: StatusOrcamento, para: StatusOrcamento): void {
  if (!podeTransicionar(de, para)) {
    const possiveis = TRANSICOES[de]
    erro(
      'ORCAMENTO_TRANSICAO_INVALIDA',
      possiveis.length === 0
        ? `Orçamento em "${de}" é estado final. Gere um novo orçamento.`
        : `Não é possível ir de "${de}" para "${para}". Possíveis: ${possiveis.join(', ')}.`,
      { de, para, possiveis },
    )
  }
}

// ── Validade ─────────────────────────────────────────────────────────────────

/** Prazo padrão. Tabela de preço de consultório muda; 30 dias é o costume. */
export const DIAS_VALIDADE_PADRAO = 30

export function validadeSugerida(emissaoIso: string, dias = DIAS_VALIDADE_PADRAO): string {
  if (!Number.isInteger(dias) || dias < 1 || dias > 365) {
    erro('VALIDADE_INVALIDA', `Validade deve ser de 1 a 365 dias, recebido ${dias}.`, { dias })
  }
  return addDias(emissaoIso, dias)
}

/**
 * Se o orçamento venceu **na data de referência**.
 *
 * Derivado, não guardado: um campo booleano de "expirado" ficaria errado à
 * meia-noite e exigiria um cron para consertar. O status `expirado` no banco
 * existe só para registrar que alguém encerrou o documento explicitamente.
 */
export function estaVencido(validadeAteIso: string, hojeIso: string): boolean {
  return comparaData(validadeAteIso, hojeIso) < 0
}

export function diasParaVencer(validadeAteIso: string, hojeIso: string): number {
  const [ano1, mes1, dia1] = validadeAteIso.split('-').map(Number)
  const [ano2, mes2, dia2] = hojeIso.split('-').map(Number)
  const ms =
    Date.UTC(ano1!, mes1! - 1, dia1!) - Date.UTC(ano2!, mes2! - 1, dia2!)
  return Math.round(ms / 86_400_000)
}

/** Status que a tela deve mostrar, considerando o vencimento. */
export function statusApresentado(
  status: StatusOrcamento,
  validadeAteIso: string,
  hojeIso: string,
): StatusOrcamento {
  // Só o enviado "vence": aprovado e recusado já foram decididos.
  if (status === 'enviado' && estaVencido(validadeAteIso, hojeIso)) return 'expirado'
  return status
}

// ── Totais ───────────────────────────────────────────────────────────────────

export interface LinhaOrcamento {
  readonly descricao: string
  readonly quantidade: number
  readonly valorUnitario: string
}

export interface Totais {
  readonly valorBruto: string
  readonly desconto: string
  readonly valorTotal: string
}

/**
 * Soma as linhas. Aritmética em centavos, como todo dinheiro no projeto.
 *
 * O resultado tem que casar com o CHECK `orcamento_total_coerente`
 * (`valor_total = valor_bruto - desconto`) e com o trigger que exige
 * `valor_bruto = soma dos itens`.
 */
export function calcularBruto(linhas: readonly LinhaOrcamento[]): string {
  if (linhas.length === 0) return '0.00'
  return somar(...linhas.map((l) => multiplicar(l.valorUnitario, l.quantidade)))
}

export type Desconto =
  | { readonly tipo: 'valor'; readonly valor: string }
  | { readonly tipo: 'percentual'; readonly pct: string }

/**
 * Aplica o desconto.
 *
 * Percentual é convertido em valor **na emissão** e só o valor é guardado: um
 * desconto de "10%" recalculado depois mudaria o documento congelado se alguém
 * ajustasse uma linha.
 */
export function calcularTotais(
  linhas: readonly LinhaOrcamento[],
  desconto: Desconto = { tipo: 'valor', valor: '0.00' },
): Totais {
  const valorBruto = calcularBruto(linhas)

  let valorDesconto: string
  if (desconto.tipo === 'valor') {
    valorDesconto = deCentavos(paraCentavos(desconto.valor))
  } else {
    const pct = Number(desconto.pct)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      erro('DESCONTO_PERCENTUAL_INVALIDO', `Desconto deve estar entre 0 e 100%, recebido "${desconto.pct}".`, {
        desconto,
      })
    }
    valorDesconto = deCentavos(Math.round((paraCentavos(valorBruto) * pct) / 100))
  }

  if (paraCentavos(valorDesconto) < 0) {
    erro('DESCONTO_NEGATIVO', 'O desconto não pode ser negativo.', { desconto })
  }
  // Desconto maior que o bruto daria total negativo, que o CHECK do banco recusa.
  if (compara(valorDesconto, valorBruto) > 0) {
    erro(
      'DESCONTO_MAIOR_QUE_TOTAL',
      `Desconto de ${valorDesconto} é maior que o valor bruto de ${valorBruto}.`,
      { valorBruto, valorDesconto },
    )
  }

  return {
    valorBruto,
    desconto: valorDesconto,
    valorTotal: subtrair(valorBruto, valorDesconto),
  }
}

/** Confere a coerência antes de tentar persistir — mesma regra do banco. */
export function totaisConferem(t: Totais, linhas: readonly LinhaOrcamento[]): boolean {
  return (
    compara(t.valorBruto, calcularBruto(linhas)) === 0 &&
    compara(t.valorTotal, subtrair(t.valorBruto, t.desconto)) === 0
  )
}

// ── Preço por cobertura ──────────────────────────────────────────────────────

export interface PrecoParticular {
  readonly cobertura: 'particular'
  readonly valorTabela: string
}

export interface PrecoConvenio {
  readonly cobertura: 'convenio'
  readonly valorConvenio: string
  /** 0–100. O que o convênio paga. */
  readonly coberturaPct: string
}

/**
 * Quanto **o paciente** paga por uma linha.
 *
 * Distinção que gera confusão: `item_plano.valor` é o valor cheio do
 * procedimento; o orçamento mostra ao paciente o que ELE desembolsa. No
 * particular são iguais; no convênio, o paciente paga só a coparticipação.
 *
 * Um orçamento que mostrasse o valor cheio de um item de convênio assustaria o
 * paciente sem motivo — e um que mostrasse zero esconderia a coparticipação.
 */
export function valorParaOPaciente(preco: PrecoParticular | PrecoConvenio): string {
  if (preco.cobertura === 'particular') return preco.valorTabela

  const pct = Number(preco.coberturaPct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    erro('COBERTURA_INVALIDA', `Cobertura deve estar entre 0 e 100, recebido "${preco.coberturaPct}".`, {
      preco,
    })
  }
  const coberto = deCentavos(Math.round((paraCentavos(preco.valorConvenio) * pct) / 100))
  return subtrair(preco.valorConvenio, coberto)
}

export const ROTULO_STATUS_ORCAMENTO: Readonly<Record<StatusOrcamento, string>> = {
  rascunho: 'Rascunho',
  enviado: 'Enviado',
  aprovado: 'Aprovado',
  recusado: 'Recusado',
  expirado: 'Expirado',
}
