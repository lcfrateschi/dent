'use server'

import { exigirPermissao } from '@/lib/authz/sessao'
import { revalidatePath } from 'next/cache'
import {
  type AjusteDeInventario,
  type BaixaDeMaterial,
  type DadosDoMaterial,
  type EntradaDeMaterial,
  type ResultadoEstoque,
  ajustarInventarioComAtor,
  darBaixaComAtor,
  definirMinimoComAtor,
  descartarLoteComAtor,
  registrarEntradaComAtor,
  salvarMaterialComAtor,
} from './movimentar'
import {
  type ItemDaFicha,
  type ResultadoFicha,
  alternarMaterialComAtor,
  salvarFichaTecnicaComAtor,
} from './cadastro'
import {
  type ItemConfirmado,
  type PropostaDeBaixa,
  type ResultadoBaixa,
  confirmarBaixaComAtor,
  proporBaixaComAtor,
} from './baixaDaExecucao'

/**
 * Ações do estoque. Camada fina: **autoriza e delega**.
 *
 * A permissão é `estoque`, e a divisão de ações não é decorativa:
 *   - `criar`  → lançar movimento (entrada pela recepção, consumo pelo dentista)
 *   - `editar` → contagem de inventário e mínimo (recepção)
 *   - `excluir`→ cadastro de material (admin) — e nem isso apaga movimento algum,
 *                que é append-only no banco
 */

export type { ResultadoEstoque } from './movimentar'

export async function registrarEntrada(entrada: EntradaDeMaterial): Promise<ResultadoEstoque> {
  const ator = await exigirPermissao('estoque', 'criar')
  const r = await registrarEntradaComAtor(ator, entrada)
  if (r.ok) revalidatePath('/estoque')
  return r
}

export async function darBaixa(baixa: BaixaDeMaterial): Promise<ResultadoEstoque> {
  const ator = await exigirPermissao('estoque', 'criar')
  const r = await darBaixaComAtor(ator, baixa)
  if (r.ok) revalidatePath('/estoque')
  return r
}

export async function ajustarInventario(ajuste: AjusteDeInventario): Promise<ResultadoEstoque> {
  const ator = await exigirPermissao('estoque', 'editar')
  const r = await ajustarInventarioComAtor(ator, ajuste)
  if (r.ok) revalidatePath('/estoque')
  return r
}

export async function descartarLote(loteId: string, motivo: string): Promise<ResultadoEstoque> {
  // Descarte é baixa: quem pode lançar movimento pode descartar, com motivo.
  const ator = await exigirPermissao('estoque', 'criar')
  const r = await descartarLoteComAtor(ator, loteId, motivo)
  if (r.ok) revalidatePath('/estoque')
  return r
}

export async function salvarMaterial(
  dados: DadosDoMaterial,
  id?: string,
): Promise<ResultadoEstoque> {
  const ator = await exigirPermissao('estoque', 'excluir')
  const r = await salvarMaterialComAtor(ator, dados, id)
  if (r.ok) revalidatePath('/estoque')
  return r
}

export async function definirMinimo(
  materialId: string,
  quantidadeMinima: string,
): Promise<ResultadoEstoque> {
  const ator = await exigirPermissao('estoque', 'editar')
  const r = await definirMinimoComAtor(ator, materialId, quantidadeMinima)
  if (r.ok) revalidatePath('/estoque')
  return r
}

/**
 * Ficha técnica de um procedimento.
 *
 * A permissão é `estoque: excluir` — a mesma do cadastro de material, e por isso
 * só do admin. Ficha técnica errada gera baixa errada em todo atendimento
 * daquele procedimento, e o erro se multiplica calado.
 */
export async function salvarFichaTecnica(
  procedimentoId: string,
  itens: readonly ItemDaFicha[],
): Promise<ResultadoFicha> {
  const ator = await exigirPermissao('estoque', 'excluir')
  const r = await salvarFichaTecnicaComAtor(ator, procedimentoId, itens)
  if (r.ok) revalidatePath('/estoque/fichas')
  return r
}

export async function alternarMaterial(materialId: string, ativo: boolean): Promise<ResultadoFicha> {
  const ator = await exigirPermissao('estoque', 'excluir')
  const r = await alternarMaterialComAtor(ator, materialId, ativo)
  if (r.ok) revalidatePath('/estoque')
  return r
}

// ── Baixa a partir da execução ────────────────────────────────────────────────

export type { PropostaDeBaixa, ResultadoBaixa } from './baixaDaExecucao'

/**
 * Proposta de consumo de uma execução.
 *
 * `estoque: criar` — a mesma permissão da baixa manual, e é quem executou o
 * procedimento que confirma. Ler a proposta já mostra nome de material e lote,
 * mas não dado clínico além do procedimento que a própria pessoa acabou de
 * registrar.
 */
export async function proporBaixaDaExecucao(execucaoId: string): Promise<PropostaDeBaixa | null> {
  const ator = await exigirPermissao('estoque', 'criar')
  return proporBaixaComAtor(ator, execucaoId)
}

export async function confirmarBaixaDaExecucao(
  execucaoId: string,
  itens: readonly ItemConfirmado[],
): Promise<ResultadoBaixa> {
  const ator = await exigirPermissao('estoque', 'criar')
  const r = await confirmarBaixaComAtor(ator, execucaoId, itens)
  if (r.ok) revalidatePath('/estoque')
  return r
}
