import { comparaData } from './datas'
import { compara, paraCentavos, somar, subtrair } from './dinheiro'
import { erro } from './erros'

/**
 * Regras puras do dinheiro que sai.
 *
 * ── A distinção que este arquivo existe para não deixar borrar ──────────────
 * Uma despesa tem **duas datas que respondem perguntas diferentes**, e tratá-las como
 * uma só é o erro clássico do módulo financeiro:
 *
 *   • `competencia` — a que mês a despesa PERTENCE. O aluguel de julho é de julho,
 *     mesmo que a fatura chegue em junho e o pagamento saia em agosto.
 *   • `pago_em` (em `pagamento_despesa`) — quando o dinheiro SAIU do banco.
 *
 * Nada aqui soma as duas. `situacaoDaDespesa` olha vencimento e pagamentos; a
 * competência não entra, porque uma despesa de julho paga em agosto não está
 * "atrasada" por isso — está paga.
 */

// ── Saldo e situação ─────────────────────────────────────────────────────────

/** Uma despesa, do ponto de vista das regras. Sem id, sem tenant: é aritmética. */
export interface DespesaParaSaldo {
  readonly valor: string
  /** Pagamentos NÃO estornados. Estornado não abate nada. */
  readonly pagos: readonly string[]
}

/**
 * Quanto ainda falta pagar.
 *
 * Nunca negativo: o banco impede a soma passar do valor (trigger na `0034`), e se
 * passasse, devolver negativo aqui esconderia o problema atrás de um número
 * plausível. Estoura, porque saldo negativo em conta a pagar é dado corrompido, não
 * um caso de borda.
 */
export function saldoDaDespesa(d: DespesaParaSaldo): string {
  const pago = d.pagos.length === 0 ? '0.00' : somar(...d.pagos)
  if (compara(pago, d.valor) > 0) {
    erro(
      'PAGO_ACIMA_DO_VALOR',
      `Pagamentos (${pago}) somam mais que a despesa (${d.valor}) — dado inconsistente.`,
      { valor: d.valor, pago },
    )
  }
  return subtrair(d.valor, pago)
}

export type SituacaoDespesa = 'cancelada' | 'paga' | 'parcial' | 'vencida' | 'aberta'

export interface DespesaParaSituacao extends DespesaParaSaldo {
  readonly vencimento: string
  readonly cancelada: boolean
}

/**
 * A situação, na ordem em que as perguntas importam.
 *
 * `cancelada` vem primeiro porque cancelada e vencida ao mesmo tempo não é "vencida":
 * ninguém precisa correr atrás de uma conta que não existe mais. E `paga` vem antes de
 * `vencida` pelo mesmo motivo — paga com atraso é paga; o atraso já aconteceu e não é
 * mais uma pendência.
 */
export function situacaoDaDespesa(d: DespesaParaSituacao, hojeIso: string): SituacaoDespesa {
  if (d.cancelada) return 'cancelada'

  const saldo = saldoDaDespesa(d)
  if (paraCentavos(saldo) === 0) return 'paga'

  const algumPagamento = d.pagos.length > 0
  if (comparaData(d.vencimento, hojeIso) < 0) return 'vencida'
  return algumPagamento ? 'parcial' : 'aberta'
}

// ── Competência e recorrência ────────────────────────────────────────────────

/** A competência de um mês é sempre o dia 1. Um lugar só que sabe disso. */
export function competenciaDoMes(ano: number, mes: number): string {
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2200) {
    erro('ANO_INVALIDO', `Ano fora da faixa aceitável: ${ano}.`, { ano })
  }
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
    erro('MES_INVALIDO', `Mês inválido: ${mes}.`, { mes })
  }
  return `${ano}-${String(mes).padStart(2, '0')}-01`
}

/** A competência a que uma data pertence. `2026-07-19` → `2026-07-01`. */
export function competenciaDaData(iso: string): string {
  const [ano, mes] = iso.split('-')
  if (!ano || !mes) erro('DATA_INVALIDA', `Data inválida: "${iso}".`, { iso })
  return `${ano}-${mes}-01`
}

/** O mês seguinte, em competência. */
export function competenciaSeguinte(competencia: string): string {
  const [a, m] = competencia.split('-').map(Number) as [number, number]
  return m === 12 ? competenciaDoMes(a + 1, 1) : competenciaDoMes(a, m + 1)
}

export interface RegraRecorrente {
  readonly inicioEm: string
  readonly fimEm: string | null
  readonly diaVencimento: number
  readonly ativo: boolean
}

/**
 * O vencimento de uma competência, dado o dia da regra.
 *
 * O dia é limitado a 28 por CHECK no banco, então não existe o caso "dia 31 em
 * fevereiro" — e é por isso que ele é limitado lá em vez de tratado aqui. Uma regra
 * "dia 31" que escorrega para 28 em fevereiro e 30 em abril é uma regra que se
 * comporta diferente em meses diferentes sem avisar ninguém.
 */
export function vencimentoNaCompetencia(competencia: string, diaVencimento: number): string {
  if (!Number.isInteger(diaVencimento) || diaVencimento < 1 || diaVencimento > 28) {
    erro('DIA_INVALIDO', `Dia de vencimento fora de 1..28: ${diaVencimento}.`, { diaVencimento })
  }
  return `${competencia.slice(0, 7)}-${String(diaVencimento).padStart(2, '0')}`
}

/**
 * Quais competências uma regra deveria ter materializado até `ateIso`, inclusive.
 *
 * **Não decide o que já existe** — quem chama subtrai o que está no banco. Separar as
 * duas coisas é o que torna o gerador idempotente sem que esta função precise saber o
 * que é um `INSERT`: ela é aritmética de calendário e tem teste de unidade; a
 * idempotência é o índice único `(recorrente_id, competencia)`.
 *
 * Regra inativa devolve lista vazia, e regra que ainda não começou também — não é
 * caso de borda, é o normal de uma regra cadastrada hoje para começar mês que vem.
 */
export function competenciasDevidas(
  regra: RegraRecorrente,
  ateIso: string,
  limite = 240,
): readonly string[] {
  if (!regra.ativo) return []

  const primeira = competenciaDaData(regra.inicioEm)
  const ultimaPossivel = competenciaDaData(ateIso)
  const fim = regra.fimEm ? competenciaDaData(regra.fimEm) : null

  const devidas: string[] = []
  let atual = primeira
  while (comparaData(atual, ultimaPossivel) <= 0) {
    if (fim && comparaData(atual, fim) > 0) break
    devidas.push(atual)
    /**
     * O limite existe para uma regra com `inicio_em` digitado errado (1926 em vez de
     * 2026) não devolver mil competências e o gerador não inserir mil despesas antes
     * de alguém notar. 240 é vinte anos — mais que qualquer contrato de aluguel de
     * consultório, e um teto que só é atingido por erro de digitação.
     */
    if (devidas.length >= limite) {
      erro(
        'RECORRENCIA_LONGA_DEMAIS',
        `A regra pediria ${limite}+ competências (início ${regra.inicioEm}). ` +
          'Confira a data de início antes de materializar.',
        { inicioEm: regra.inicioEm, limite },
      )
    }
    atual = competenciaSeguinte(atual)
  }
  return devidas
}
