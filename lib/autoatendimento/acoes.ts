'use server'

import { exigirPermissao } from '@/lib/authz/sessao'
import { revalidatePath } from 'next/cache'
import { type ResultadoEspera, encerrarEsperaComAtor } from './fila'

/**
 * Ações da lista de espera. Camada fina: **autoriza e delega**.
 *
 * `relacionamento` + `editar` — a mesma permissão das filas da Fase 18, porque é a
 * mesma atividade (atender uma fila de contato) e o mesmo perfil. O argumento está
 * no topo de `fila.ts`.
 */

export type { ResultadoEspera } from './fila'

export async function encerrarEspera(entrada: {
  readonly id: string
  readonly situacao: 'atendida' | 'encerrada'
  readonly motivo?: string
}): Promise<ResultadoEspera> {
  const ator = await exigirPermissao('relacionamento', 'editar')
  const r = await encerrarEsperaComAtor(ator, entrada)
  if (r.ok) revalidatePath('/espera')
  return r
}
