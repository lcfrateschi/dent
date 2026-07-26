import { auth } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { type Acao, type Perfil, type Recurso, pode } from './politicas'

/** Erro de autorização. A UI traduz em 403; o middleware, em redirecionamento. */
export class SemPermissao extends Error {
  constructor(
    readonly recurso: Recurso,
    readonly acao: Acao,
    readonly perfil: Perfil,
  ) {
    super(`Perfil "${perfil}" não pode "${acao}" em "${recurso}".`)
    this.name = 'SemPermissao'
  }
}

export class SemSessao extends Error {
  constructor() {
    super('Sessão não encontrada ou expirada.')
    this.name = 'SemSessao'
  }
}

export interface Ator {
  readonly usuarioId: string
  readonly nome: string
  readonly email: string
  readonly perfil: Perfil
  readonly profissionalId: string | null
}

/**
 * Ator da requisição, ou `null`.
 *
 * Nunca leia a sessão direto nas páginas — passe por aqui, para que o tipo
 * `Ator` seja o único formato que o resto do código conhece.
 */
export async function atorAtual(): Promise<Ator | null> {
  const sessao = await auth()
  const u = sessao?.user
  if (!u?.id || !u.perfil) return null

  return {
    usuarioId: u.id,
    nome: u.name ?? '',
    email: u.email ?? '',
    perfil: u.perfil,
    profissionalId: u.profissionalId ?? null,
  }
}

/** Ator obrigatório. Lança `SemSessao` se não houver. */
export async function exigirAtor(): Promise<Ator> {
  const ator = await atorAtual()
  if (!ator) throw new SemSessao()
  return ator
}

/**
 * Porta de entrada de toda server action e page de staff:
 * exige sessão E permissão, devolvendo o ator para a auditoria.
 *
 * Chamar isto no início de cada action é a diferença entre RBAC de verdade e
 * RBAC decorativo — esconder o botão no menu não protege a rota.
 */
export async function exigirPermissao(recurso: Recurso, acao: Acao): Promise<Ator> {
  const ator = await exigirAtor()
  if (!pode(ator.perfil, recurso, acao)) {
    throw new SemPermissao(recurso, acao, ator.perfil)
  }
  return ator
}

/** Versão sem exceção, para decidir se um botão aparece. */
export async function atorPode(recurso: Recurso, acao: Acao): Promise<boolean> {
  const ator = await atorAtual()
  return ator ? pode(ator.perfil, recurso, acao) : false
}

/**
 * Guarda para PÁGINAS. Nega redirecionando para uma tela de 403 legível, em vez
 * de lançar e virar erro 500.
 *
 * A diferença em relação a `exigirPermissao` é só de apresentação: em server
 * action a exceção é traduzida em mensagem no formulário; em página, o usuário
 * precisa de uma tela que explique o que aconteceu.
 */
export async function exigirPermissaoPagina(recurso: Recurso, acao: Acao): Promise<Ator> {
  const ator = await atorAtual()
  if (!ator) redirect('/entrar')

  if (!pode(ator.perfil, recurso, acao)) {
    const params = new URLSearchParams({ recurso, acao })
    redirect(`/sem-permissao?${params.toString()}`)
  }
  return ator
}
