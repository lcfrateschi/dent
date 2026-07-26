import { compara, deCentavos, paraCentavos, somar } from './dinheiro'
import { erro } from './erros'

/**
 * Comissão do profissional.
 *
 * ── A base é o valor RECEBIDO, decidido pela clínica ────────────────────────
 * A comissão entra na base quando o dinheiro é **conciliado**, não quando o
 * procedimento é executado. Comissão paga sobre execução é adiantamento: o
 * paciente atrasa três meses e a clínica já pagou.
 *
 * ── O problema que este módulo resolve ──────────────────────────────────────
 * Uma cobrança nasce de um orçamento que pode ter itens executados por
 * profissionais DIFERENTES. O paciente paga em parcelas. Quando entram R$ 100 de
 * uma cobrança de R$ 500, quanto é de cada profissional?
 *
 * Resposta: **rateio proporcional ao valor executado por cada um**. Quem executou
 * 60% do valor da cobrança recebe comissão sobre 60% do que entrou.
 *
 * A alternativa — pagar por ordem de execução até esgotar o recebido — faria o
 * primeiro profissional receber tudo e o segundo nada, o que é arbitrário e
 * gera briga. Rateio proporcional é o único critério que não depende da ordem.
 *
 * ── A soma dos rateios FECHA com o recebido ─────────────────────────────────
 * Aritmética em centavos e sobra na primeira fatia, como em
 * `lib/domain/parcelamento.ts`. Um centavo perdido por cobrança some no relatório
 * do mês e ninguém acha de onde veio.
 */

export type BaseComissao = 'valor_executado' | 'valor_recebido'

export interface ExecucaoParaComissao {
  readonly profissionalId: string
  readonly profissionalNome: string
  /** Percentual de comissão do profissional, 0–100. */
  readonly comissaoPct: string
  /** Valor do item executado por ele nesta cobrança. */
  readonly valorExecutado: string
}

export interface RateioComissao {
  readonly profissionalId: string
  readonly profissionalNome: string
  readonly comissaoPct: string
  /** Valor executado por ele na cobrança. */
  readonly valorExecutado: string
  /** Fatia do recebido atribuída a ele. A soma destes é o recebido total. */
  readonly baseDeCalculo: string
  /** `baseDeCalculo` × `comissaoPct`. É o que a clínica deve a ele. */
  readonly comissao: string
}

/**
 * Rateia o valor recebido entre os profissionais e calcula a comissão de cada um.
 *
 * `recebido` deve ser o total **conciliado** da cobrança. Passar o valor apenas
 * "pago" antecipa comissão sobre dinheiro que pode voltar.
 */
export function ratearComissao({
  execucoes,
  recebido,
}: {
  execucoes: readonly ExecucaoParaComissao[]
  recebido: string
}): readonly RateioComissao[] {
  if (execucoes.length === 0) return []

  const recebidoCentavos = paraCentavos(recebido)
  if (recebidoCentavos < 0) {
    erro('RECEBIDO_NEGATIVO', `Valor recebido não pode ser negativo: ${recebido}.`, { recebido })
  }

  // Agrupa por profissional: o mesmo dentista pode ter vários itens na cobrança.
  const porProfissional = new Map<string, ExecucaoParaComissao & { total: number }>()
  for (const e of execucoes) {
    const atual = porProfissional.get(e.profissionalId)
    const valor = paraCentavos(e.valorExecutado)
    if (valor < 0) {
      erro('EXECUTADO_NEGATIVO', `Valor executado não pode ser negativo: ${e.valorExecutado}.`, { e })
    }
    if (atual) atual.total += valor
    else porProfissional.set(e.profissionalId, { ...e, total: valor })
  }

  const grupos = [...porProfissional.values()]
    // Ordem estável: maior executado primeiro, e a sobra do arredondamento cai
    // nele. Empate desfeito pelo id, para o resultado não depender da consulta.
    .sort((a, b) => b.total - a.total || a.profissionalId.localeCompare(b.profissionalId))

  const totalExecutado = grupos.reduce((acc, g) => acc + g.total, 0)

  // Nada executado: não há como ratear, e ninguém tem direito a nada.
  if (totalExecutado === 0) {
    return grupos.map((g) => ({
      profissionalId: g.profissionalId,
      profissionalNome: g.profissionalNome,
      comissaoPct: g.comissaoPct,
      valorExecutado: deCentavos(g.total),
      baseDeCalculo: '0.00',
      comissao: '0.00',
    }))
  }

  // Rateio proporcional com fechamento exato: a sobra vai na primeira fatia.
  const bases: number[] = grupos.map((g) =>
    Math.floor((recebidoCentavos * g.total) / totalExecutado),
  )
  const distribuido = bases.reduce((a, b) => a + b, 0)
  if (bases.length > 0) bases[0] = bases[0]! + (recebidoCentavos - distribuido)

  return grupos.map((g, i) => {
    const base = bases[i]!
    const pct = Number(g.comissaoPct)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      erro(
        'COMISSAO_PCT_INVALIDO',
        `Percentual de comissão deve estar entre 0 e 100, recebido "${g.comissaoPct}".`,
        { profissionalId: g.profissionalId, comissaoPct: g.comissaoPct },
      )
    }
    return {
      profissionalId: g.profissionalId,
      profissionalNome: g.profissionalNome,
      comissaoPct: g.comissaoPct,
      valorExecutado: deCentavos(g.total),
      baseDeCalculo: deCentavos(base),
      // Arredonda ao centavo na comissão de cada um. A soma das comissões NÃO
      // precisa fechar com nada — cada uma é um percentual independente.
      comissao: deCentavos(Math.round((base * pct) / 100)),
    }
  })
}

/** Confere a invariante: a soma das bases é exatamente o recebido. */
export function rateioFecha(rateios: readonly RateioComissao[], recebido: string): boolean {
  if (rateios.length === 0) return paraCentavos(recebido) === 0
  return compara(somar(...rateios.map((r) => r.baseDeCalculo)), recebido) === 0
}

export function totalDeComissao(rateios: readonly RateioComissao[]): string {
  return rateios.length === 0 ? '0.00' : somar(...rateios.map((r) => r.comissao))
}

// ── Consolidação por período ─────────────────────────────────────────────────

export interface ComissaoDoProfissional {
  readonly profissionalId: string
  readonly profissionalNome: string
  readonly comissaoPct: string
  readonly baseDeCalculo: string
  readonly comissao: string
  readonly cobrancas: number
}

/**
 * Soma os rateios de várias cobranças num período, por profissional.
 * É o que o relatório do mês mostra e o que a clínica paga.
 */
export function consolidarPorProfissional(
  rateiosPorCobranca: readonly (readonly RateioComissao[])[],
): readonly ComissaoDoProfissional[] {
  const mapa = new Map<string, ComissaoDoProfissional & { _bases: string[]; _com: string[] }>()

  for (const rateios of rateiosPorCobranca) {
    for (const r of rateios) {
      const atual = mapa.get(r.profissionalId)
      if (atual) {
        atual._bases.push(r.baseDeCalculo)
        atual._com.push(r.comissao)
        mapa.set(r.profissionalId, { ...atual, cobrancas: atual.cobrancas + 1 })
      } else {
        mapa.set(r.profissionalId, {
          profissionalId: r.profissionalId,
          profissionalNome: r.profissionalNome,
          comissaoPct: r.comissaoPct,
          baseDeCalculo: '0.00',
          comissao: '0.00',
          cobrancas: 1,
          _bases: [r.baseDeCalculo],
          _com: [r.comissao],
        })
      }
    }
  }

  return [...mapa.values()]
    .map(({ _bases, _com, ...resto }) => ({
      ...resto,
      baseDeCalculo: somar(..._bases),
      comissao: somar(..._com),
    }))
    .sort((a, b) => paraCentavos(b.comissao) - paraCentavos(a.comissao))
}

export const ROTULO_BASE: Readonly<Record<BaseComissao, string>> = {
  valor_executado: 'sobre valor executado',
  valor_recebido: 'sobre valor recebido',
}

/** Explicação apresentável da base, para a tela não deixar dúvida. */
export function explicarBase(base: BaseComissao): string {
  return base === 'valor_recebido'
    ? 'A comissão entra na base quando o pagamento é conciliado. Procedimento executado e não pago ainda não gera comissão.'
    : 'A comissão entra na base quando o procedimento é executado, independentemente de o paciente ter pago.'
}
