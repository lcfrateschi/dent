'use server'

import { exigirPermissao } from '@/lib/authz/sessao'
import { revalidatePath } from 'next/cache'
import {
  type DadosDaCarteirinha,
  type DadosDoConvenio,
  type DadosDoPreco,
  type ResultadoCadastro,
  alternarCarteirinhaComAtor,
  alternarConvenioComAtor,
  apagarPrecoComAtor,
  fecharVigenciaComAtor,
  salvarCarteirinhaComAtor,
  salvarConvenioComAtor,
  salvarPrecoComAtor,
} from './cadastro'

/**
 * Ações do cadastro de convênio. Camada fina: **autoriza e delega**.
 *
 * `convenio: criar/editar` — admin e financeiro pela matriz do RBAC. A recepção
 * lê (precisa ver a carteirinha para agendar) mas não negocia tabela.
 *
 * A **carteirinha** é a exceção: ela é dado do paciente e quem cadastra é a
 * recepção, no momento em que o paciente chega com a carteira na mão. Por isso a
 * permissão dela é `paciente: editar`, não `convenio: editar`.
 */

export type { ResultadoCadastro } from './cadastro'

export async function salvarConvenio(
  dados: DadosDoConvenio,
  id?: string,
): Promise<ResultadoCadastro> {
  const ator = await exigirPermissao('convenio', id ? 'editar' : 'criar')
  const r = await salvarConvenioComAtor(ator, dados, id)
  if (r.ok) {
    revalidatePath('/convenios')
    revalidatePath('/convenios/cadastro')
  }
  return r
}

export async function alternarConvenio(id: string, ativo: boolean): Promise<ResultadoCadastro> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await alternarConvenioComAtor(ator, id, ativo)
  if (r.ok) revalidatePath('/convenios/cadastro')
  return r
}

export async function salvarPreco(dados: DadosDoPreco): Promise<ResultadoCadastro> {
  const ator = await exigirPermissao('convenio', 'criar')
  const r = await salvarPrecoComAtor(ator, dados)
  if (r.ok) revalidatePath(`/convenios/cadastro/${dados.convenioId}`)
  return r
}

export async function fecharVigencia(
  precoId: string,
  em: string,
  convenioId: string,
): Promise<ResultadoCadastro> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await fecharVigenciaComAtor(ator, precoId, em)
  if (r.ok) revalidatePath(`/convenios/cadastro/${convenioId}`)
  return r
}

export async function apagarPreco(precoId: string, convenioId: string): Promise<ResultadoCadastro> {
  const ator = await exigirPermissao('convenio', 'editar')
  const r = await apagarPrecoComAtor(ator, precoId)
  if (r.ok) revalidatePath(`/convenios/cadastro/${convenioId}`)
  return r
}

export async function salvarCarteirinha(
  dados: DadosDaCarteirinha,
  id?: string,
): Promise<ResultadoCadastro> {
  // Dado do paciente, cadastrado no balcão: a permissão é de paciente.
  const ator = await exigirPermissao('paciente', 'editar')
  const r = await salvarCarteirinhaComAtor(ator, dados, id)
  if (r.ok) revalidatePath(`/pacientes/${dados.pacienteId}`)
  return r
}

export async function alternarCarteirinha(
  id: string,
  ativo: boolean,
  pacienteId: string,
): Promise<ResultadoCadastro> {
  const ator = await exigirPermissao('paciente', 'editar')
  const r = await alternarCarteirinhaComAtor(ator, id, ativo)
  if (r.ok) revalidatePath(`/pacientes/${pacienteId}`)
  return r
}
