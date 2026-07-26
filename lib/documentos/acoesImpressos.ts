'use server'

import { exigirPermissao } from '@/lib/authz/sessao'
import type { Medicamento } from '@/lib/domain/impressos'
import { revalidatePath } from 'next/cache'
import { arquivarOrcamento, emitirAtestado, emitirReceita } from './emitir'

/**
 * Ações de emissão de impresso.
 *
 * A permissão exigida é `prontuario: assinar`, não `documento: criar` — e a
 * diferença é o ponto: qualquer um da recepção pode anexar uma radiografia que o
 * laboratório mandou, mas **atestado e receita são atos privativos do
 * cirurgião-dentista**. Quem emite responde pelo CRO impresso no papel.
 */

export type ResultadoImpresso =
  | { ok: true; documentoId: string; mensagem: string; avisos: readonly string[] }
  | { ok: false; mensagem: string }

export async function gerarAtestado(entrada: {
  readonly pacienteId: string
  readonly atendidoEm: string
  readonly diasAfastamento?: number
  readonly cid?: string
  readonly cidAutorizadoPeloPaciente?: boolean
  readonly observacao?: string
}): Promise<ResultadoImpresso> {
  const ator = await exigirPermissao('prontuario', 'assinar')

  const atendidoEm = new Date(entrada.atendidoEm)
  if (Number.isNaN(atendidoEm.getTime())) {
    return { ok: false, mensagem: 'Data de atendimento inválida.' }
  }

  const { resultado, avisos } = await emitirAtestado(ator, {
    pacienteId: entrada.pacienteId,
    atendidoEm,
    diasAfastamento: entrada.diasAfastamento,
    cid: entrada.cid,
    cidAutorizadoPeloPaciente: entrada.cidAutorizadoPeloPaciente,
    observacao: entrada.observacao,
  })

  if (!resultado.ok) return { ok: false, mensagem: resultado.mensagem }

  revalidatePath(`/pacientes/${entrada.pacienteId}/documentos`)
  return { ok: true, documentoId: resultado.id, mensagem: resultado.mensagem, avisos }
}

export async function gerarReceita(entrada: {
  readonly pacienteId: string
  readonly medicamentos: readonly Medicamento[]
  readonly orientacoes?: string
}): Promise<ResultadoImpresso> {
  const ator = await exigirPermissao('prontuario', 'assinar')

  const { resultado, avisos } = await emitirReceita(ator, entrada)
  if (!resultado.ok) return { ok: false, mensagem: resultado.mensagem }

  revalidatePath(`/pacientes/${entrada.pacienteId}/documentos`)
  return { ok: true, documentoId: resultado.id, mensagem: resultado.mensagem, avisos }
}

/**
 * Arquiva o PDF do orçamento.
 *
 * Aqui a permissão é de orçamento, não de prontuário: é documento comercial, e
 * quem emite orçamento é quem o arquiva.
 */
export async function gerarPdfDoOrcamento(orcamentoId: string): Promise<ResultadoImpresso> {
  const ator = await exigirPermissao('orcamento', 'criar')

  const { resultado } = await arquivarOrcamento(ator, orcamentoId)
  if (!resultado.ok) return { ok: false, mensagem: resultado.mensagem }

  revalidatePath(`/orcamentos/${orcamentoId}`)
  return { ok: true, documentoId: resultado.id, mensagem: 'PDF arquivado no prontuário.', avisos: [] }
}
