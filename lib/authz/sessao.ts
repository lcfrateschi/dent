import { auth } from '@/lib/auth/config'
import { definirClinicaDoContexto } from '@/lib/tenant/contexto'
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
  /**
   * A clínica deste usuário — o tenant da requisição.
   *
   * Vem do token, que a recebeu no login a partir da linha do `usuario`. **Nunca
   * de parâmetro, nunca da URL.** É a mesma regra que `lib/portal/consultas.ts`
   * aplica a `pacienteId`: id que vem de fora é id que quem ataca escolhe.
   *
   * Quase nenhuma consulta precisa lê-lo explicitamente — `atorAtual()` o põe no
   * contexto assíncrono e `lib/db/index.ts` o aplica em toda conexão. Ele está
   * aqui para os casos em que o tenant precisa ser dito em voz alta (auditoria,
   * exportação) e para o `comClinica()` de quem sai do fluxo da requisição.
   */
  readonly clinicaId: string
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
  /**
   * Sem `clinicaId`, **não há sessão**.
   *
   * O caso concreto é o token emitido antes da Fase 17: ele tem id, perfil e MFA,
   * e não tem tenant. A alternativa — completar com "a" clínica — transformaria
   * uma credencial antiga em passe para uma clínica que ela nunca nomeou. Aqui ela
   * simplesmente deixa de valer, e a pessoa entra de novo. Sessão de staff dura 8
   * horas; o incômodo é de um dia, uma vez.
   */
  if (!u?.id || !u.perfil || !u.clinicaId) return null

  const ator: Ator = {
    usuarioId: u.id,
    nome: u.name ?? '',
    email: u.email ?? '',
    perfil: u.perfil,
    profissionalId: u.profissionalId ?? null,
    clinicaId: u.clinicaId,
  }

  /**
   * O tenant entra no contexto assíncrono AQUI, e é o que faz as centenas de
   * consultas do staff acertarem a clínica sem mencioná-la.
   *
   * Este é o ponto certo porque `atorAtual()` roda no começo de todo fluxo de
   * staff — é o que `exigirAtor`, `exigirPermissao` e `exigirPermissaoPagina`
   * chamam antes de qualquer coisa. Não existe caminho de staff que leia dado sem
   * passar por aqui; se existisse, seria um furo de autorização antes de ser um
   * furo de tenant.
   */
  definirClinicaDoContexto(ator.clinicaId)
  return ator
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
