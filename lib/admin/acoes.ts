'use server'

import { exigirAtor, exigirPermissao } from '@/lib/authz/sessao'
import { revalidatePath } from 'next/cache'
import {
  type DadosDaClinica,
  type ResultadoConfig,
  desativarCadeiraComAtor,
  reativarCadeiraComAtor,
  salvarCadeiraComAtor,
  salvarClinicaComAtor,
  salvarHorarioComAtor,
} from './clinica'
import type { HorarioFuncionamento } from '@/lib/domain/horario'
import {
  type DadosDoUsuario,
  type ResultadoAdmin,
  criarUsuarioComAtor,
  desativarUsuarioComAtor,
  reativarUsuarioComAtor,
  resetarMfaComAtor,
  resetarSenhaComAtor,
  salvarUsuarioComAtor,
  trocarPropriaSenhaComAtor,
} from './usuarios'

/**
 * Ações da administração. Camada fina: **autoriza e delega**.
 *
 * O recurso é `usuario` para gente e `configuracao` para a clínica — os dois só
 * do admin, pela matriz de `lib/authz/politicas.ts`. Um dentista que descubra o
 * nome desta action recebe `SemPermissao`, porque a checagem é aqui e não na tela.
 *
 * **A exceção é `trocarPropriaSenha`**, que exige apenas sessão: quem tem senha
 * temporária ainda não passou pela guarda do middleware e precisa poder trocá-la.
 * Exigir permissão de `usuario` ali trancaria a recepção fora do sistema no
 * primeiro acesso — a trava sem porta de saída, de novo.
 */

export type { ResultadoAdmin } from './usuarios'
export type { ResultadoConfig } from './clinica'

export async function criarUsuario(dados: DadosDoUsuario): Promise<ResultadoAdmin> {
  const ator = await exigirPermissao('usuario', 'criar')
  const r = await criarUsuarioComAtor(ator, dados)
  if (r.ok) revalidatePath('/usuarios')
  return r
}

export async function salvarUsuario(id: string, dados: DadosDoUsuario): Promise<ResultadoAdmin> {
  const ator = await exigirPermissao('usuario', 'editar')
  const r = await salvarUsuarioComAtor(ator, id, dados)
  if (r.ok) revalidatePath('/usuarios')
  return r
}

export async function desativarUsuario(id: string): Promise<ResultadoAdmin> {
  const ator = await exigirPermissao('usuario', 'excluir')
  const r = await desativarUsuarioComAtor(ator, id)
  if (r.ok) revalidatePath('/usuarios')
  return r
}

export async function reativarUsuario(id: string): Promise<ResultadoAdmin> {
  const ator = await exigirPermissao('usuario', 'editar')
  const r = await reativarUsuarioComAtor(ator, id)
  if (r.ok) revalidatePath('/usuarios')
  return r
}

export async function resetarSenha(id: string): Promise<ResultadoAdmin> {
  const ator = await exigirPermissao('usuario', 'editar')
  const r = await resetarSenhaComAtor(ator, id)
  if (r.ok) revalidatePath('/usuarios')
  return r
}

export async function resetarMfa(id: string): Promise<ResultadoAdmin> {
  const ator = await exigirPermissao('usuario', 'editar')
  const r = await resetarMfaComAtor(ator, id)
  if (r.ok) revalidatePath('/usuarios')
  return r
}

/**
 * Troca da própria senha. **Só exige sessão**, e é deliberado — ver o comentário
 * do topo. A identidade vem da sessão, nunca de um parâmetro: aceitar um
 * `usuarioId` aqui seria permitir trocar a senha de outra pessoa.
 */
export async function trocarPropriaSenha(atual: string, nova: string): Promise<ResultadoAdmin> {
  const ator = await exigirAtor()
  return trocarPropriaSenhaComAtor(ator, atual, nova)
}

export async function salvarClinica(dados: DadosDaClinica): Promise<ResultadoConfig> {
  const ator = await exigirPermissao('configuracao', 'editar')
  const r = await salvarClinicaComAtor(ator, dados)
  if (r.ok) {
    revalidatePath('/configuracoes')
    // O cabeçalho da clínica sai nos impressos e no orçamento.
    revalidatePath('/orcamentos')
  }
  return r
}

/** Horário e passo da agenda. Separado para não tocar na identificação. */
export async function salvarHorario(
  horario: HorarioFuncionamento,
  passoAgendaMinutos: number,
): Promise<ResultadoConfig> {
  const ator = await exigirPermissao('configuracao', 'editar')
  const r = await salvarHorarioComAtor(ator, horario, passoAgendaMinutos)
  if (r.ok) {
    revalidatePath('/configuracoes')
    revalidatePath('/agenda')
  }
  return r
}

export async function salvarCadeira(
  dados: { readonly nome: string; readonly ordem?: number },
  id?: string,
): Promise<ResultadoConfig> {
  const ator = await exigirPermissao('configuracao', 'editar')
  const r = await salvarCadeiraComAtor(ator, dados, id)
  if (r.ok) {
    revalidatePath('/configuracoes')
    revalidatePath('/agenda')
  }
  return r
}

export async function desativarCadeira(id: string): Promise<ResultadoConfig> {
  const ator = await exigirPermissao('configuracao', 'editar')
  const r = await desativarCadeiraComAtor(ator, id)
  if (r.ok) {
    revalidatePath('/configuracoes')
    revalidatePath('/agenda')
  }
  return r
}

export async function reativarCadeira(id: string): Promise<ResultadoConfig> {
  const ator = await exigirPermissao('configuracao', 'editar')
  const r = await reativarCadeiraComAtor(ator, id)
  if (r.ok) {
    revalidatePath('/configuracoes')
    revalidatePath('/agenda')
  }
  return r
}
