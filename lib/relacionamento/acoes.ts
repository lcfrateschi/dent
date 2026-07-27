'use server'

import { exigirPermissao } from '@/lib/authz/sessao'
import { revalidatePath } from 'next/cache'
import {
  type ContatoRegistrado,
  type ResultadoTarefa,
  assumirTarefaComAtor,
  dispensarTarefaComAtor,
  registrarContatoComAtor,
  resolverTarefaComAtor,
} from './tarefas'

/**
 * Ações das filas de relacionamento. Camada fina: **autoriza e delega**.
 *
 * A permissão é `relacionamento`, e `editar` cobre todo o trabalho da fila
 * (assumir, registrar contato, resolver, dispensar) porque as quatro são a mesma
 * atividade: atender a fila. `criar` e `excluir` ficam para as REGRAS de retorno,
 * que são configuração e são do admin.
 */

export type { ResultadoTarefa } from './tarefas'

export async function assumirTarefa(tarefaId: string): Promise<ResultadoTarefa> {
  const ator = await exigirPermissao('relacionamento', 'editar')
  const r = await assumirTarefaComAtor(ator, tarefaId)
  if (r.ok) revalidatePath('/relacionamento')
  return r
}

export async function registrarContato(entrada: ContatoRegistrado): Promise<ResultadoTarefa> {
  const ator = await exigirPermissao('relacionamento', 'editar')
  const r = await registrarContatoComAtor(ator, entrada)
  if (r.ok) revalidatePath('/relacionamento')
  return r
}

export async function resolverTarefa(tarefaId: string): Promise<ResultadoTarefa> {
  const ator = await exigirPermissao('relacionamento', 'editar')
  const r = await resolverTarefaComAtor(ator, tarefaId)
  if (r.ok) revalidatePath('/relacionamento')
  return r
}

export async function dispensarTarefa(entrada: {
  readonly tarefaId: string
  readonly motivo: string
  readonly naoContatarAte?: string
  readonly naoContatarMotivo?: string
}): Promise<ResultadoTarefa> {
  const ator = await exigirPermissao('relacionamento', 'editar')
  const r = await dispensarTarefaComAtor(ator, entrada)
  if (r.ok) revalidatePath('/relacionamento')
  return r
}
