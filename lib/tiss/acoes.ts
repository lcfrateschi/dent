'use server'

import { exigirPermissao } from '@/lib/authz/sessao'
import type { ClasseGlosa } from '@/lib/domain/convenio'
import { revalidatePath } from 'next/cache'
import {
  type ResultadoTiss,
  cancelarGuiaComAtor,
  conciliarComAtor,
  enviarGuiaComAtor,
  fecharRepasseComAtor,
  montarGuiaComAtor,
  recorrerComAtor,
  registrarRepasseComAtor,
  registrarRetornoComAtor,
  responderRecursoComAtor,
} from './montar'

/**
 * Ações do faturamento por convênio.
 *
 * Camada fina: **autoriza e delega**. A lógica do ciclo da guia — validação,
 * transação, derivação da situação — mora em `montar.ts`, que é código comum e
 * verificável fora de uma requisição.
 *
 * A permissão é `convenio`, não `cobranca`: são dinheiros diferentes. Quem fatura
 * convênio lida com operadora, prazo e glosa; quem cobra particular lida com o
 * paciente. A matriz do RBAC já separava os dois desde a Fase 3.
 */

export type { ResultadoTiss } from './montar'

/** Monta uma guia com os procedimentos escolhidos. */
export async function montarGuia(entrada: {
  readonly itemPlanoIds: readonly string[]
  readonly profissionalId: string
  readonly observacao?: string
}): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'criar')
  const r = await montarGuiaComAtor(ator, entrada)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Envia a guia à operadora. Depois disto o apresentado é imutável. */
export async function enviarGuia(guiaId: string, numeroLote: string): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await enviarGuiaComAtor(ator, guiaId, numeroLote)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Registra quanto a operadora pagou por um item; a glosa é a diferença. */
export async function registrarRetornoDeItem(entrada: {
  readonly itemGuiaId: string
  readonly valorPago: string
  readonly classeGlosa?: ClasseGlosa
  readonly motivoGlosa?: string
  readonly codigoOperadora?: string
}): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await registrarRetornoComAtor(ator, entrada)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Recorre de uma glosa. */
export async function recorrerDaGlosa(
  glosaId: string,
  argumento: string,
): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await recorrerComAtor(ator, glosaId, argumento)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Registra a resposta da operadora ao recurso. */
export async function responderRecurso(
  recursoId: string,
  deferido: boolean,
  motivo: string,
): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await responderRecursoComAtor(ator, recursoId, deferido, motivo)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Registra um repasse recebido da operadora. */
export async function registrarRepasse(entrada: {
  readonly convenioId: string
  readonly valorTotal: string
  readonly recebidoEm: string
  readonly demonstrativo?: string
}): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'criar')
  const r = await registrarRepasseComAtor(ator, entrada)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Concilia o repasse item a item. */
export async function conciliarRepasse(
  repasseId: string,
  atribuicoes: readonly { readonly itemGuiaId: string; readonly valor: string }[],
): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await conciliarComAtor(ator, repasseId, atribuicoes)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Fecha o repasse: a conferência acabou. */
export async function fecharRepasse(repasseId: string): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await fecharRepasseComAtor(ator, repasseId)
  if (r.ok) revalidatePath('/convenios')
  return r
}

/** Cancela guia em rascunho, devolvendo os itens à fila. */
export async function cancelarGuia(guiaId: string, motivo: string): Promise<ResultadoTiss> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await cancelarGuiaComAtor(ator, guiaId, motivo)
  if (r.ok) revalidatePath('/convenios')
  return r
}
