'use server'

import { exigirPermissao } from '@/lib/authz/sessao'
import { revalidatePath } from 'next/cache'
import {
  type NovaDespesa,
  type PagamentoDeDespesa,
  type ResultadoDespesa,
  cancelarDespesaComAtor,
  estornarPagamentoDeDespesaComAtor,
  lancarDespesaComAtor,
  pagarDespesaComAtor,
} from './despesas'

/**
 * Ações do fechamento financeiro. Camada fina: **autoriza e delega.**
 *
 * ── Por que `excluir` para cancelar e estornar ──────────────────────────────
 * As duas desfazem um fato: a obrigação que não existia, o pagamento que não saiu. São
 * as únicas do módulo que o **admin não tem** — ele configura e lê, mas dinheiro que já
 * se moveu responde ao financeiro. Se admin pudesse estornar, uma saída de caixa
 * poderia desaparecer sem ninguém do financeiro saber.
 *
 * ── O que estas ações NÃO fazem ─────────────────────────────────────────────
 * Nenhuma decide regra. O limite "a soma dos pagamentos não passa do valor da despesa"
 * é trigger no banco (`pagamento_despesa_soma`, na `0034`); a situação e o saldo são
 * funções puras de `lib/domain/despesa.ts`. Aqui há permissão, delegação e
 * `revalidatePath`.
 *
 * ── Os três caminhos revalidados ────────────────────────────────────────────
 * Um lançamento muda as três telas de uma vez, e cada uma responde uma pergunta
 * diferente: `/caixa` (o que se moveu no banco), `/caixa/custos` (o que o mês custou) e
 * `/caixa/contas` (o que se deve). Revalidar só a que o usuário está vendo deixaria as
 * outras duas com número velho — e "o número muda quando eu recarrego" é o tipo de bug
 * que ninguém reporta e todos deixam de confiar.
 */

export type { ResultadoDespesa } from './despesas'

const CAMINHOS = ['/caixa', '/caixa/custos', '/caixa/contas'] as const

function revalidarCaixa(): void {
  for (const c of CAMINHOS) revalidatePath(c)
}

export async function lancarDespesa(entrada: NovaDespesa): Promise<ResultadoDespesa> {
  const ator = await exigirPermissao('despesa', 'criar')
  const r = await lancarDespesaComAtor(ator, entrada)
  if (r.ok) revalidarCaixa()
  return r
}

export async function pagarDespesa(entrada: PagamentoDeDespesa): Promise<ResultadoDespesa> {
  const ator = await exigirPermissao('despesa', 'editar')
  const r = await pagarDespesaComAtor(ator, entrada)
  if (r.ok) revalidarCaixa()
  return r
}

export async function cancelarDespesa(
  despesaId: string,
  motivo: string,
): Promise<ResultadoDespesa> {
  const ator = await exigirPermissao('despesa', 'excluir')
  const r = await cancelarDespesaComAtor(ator, despesaId, motivo)
  if (r.ok) revalidarCaixa()
  return r
}

export async function estornarPagamentoDeDespesa(
  pagamentoId: string,
  motivo: string,
): Promise<ResultadoDespesa> {
  const ator = await exigirPermissao('despesa', 'excluir')
  const r = await estornarPagamentoDeDespesaComAtor(ator, pagamentoId, motivo)
  if (r.ok) revalidarCaixa()
  return r
}
