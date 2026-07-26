'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { gerarConvite } from '@/lib/auth/convite'
import { exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { paciente, pacienteConta } from '@/lib/db/schema'
import { revogarSessoes } from '@/lib/portal/sessao'
import { eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

/**
 * Liberação de acesso ao portal, feita pela clínica.
 *
 * Fica em `lib/pacientes/` e não em `lib/portal/` de propósito: quem executa é o
 * **staff**, com `exigirPermissao`. `lib/portal/` é o realm do paciente, e uma
 * função de staff morando lá seria o primeiro passo para alguém reusar código de
 * um realm no outro.
 *
 * O convite em claro **existe uma vez só**, no retorno desta função. Depois disso
 * só o hash fica no banco: nem o administrador consegue recuperá-lo, e a única saída
 * é gerar outro. É o comportamento certo — convite recuperável é senha
 * compartilhada.
 */

export type ResultadoAcesso =
  | { ok: true; mensagem: string; convite?: string; expiraEm?: string }
  | { ok: false; mensagem: string }

/**
 * Cria a conta do portal e o primeiro convite.
 *
 * Idempotente no sentido útil: se a conta já existe, não duplica — gera um convite
 * novo, que é o que a recepção quer quando o paciente perdeu o código.
 */
export async function liberarAcessoAoPortal(
  pacienteId: string,
  email: string,
): Promise<ResultadoAcesso> {
  const ator = await exigirPermissao('paciente', 'editar')

  const limpo = email.trim().toLowerCase()
  // Validação simples de propósito: o e-mail aqui é identificador de login, não
  // canal de entrega (o sistema não envia e-mail). Rejeitar formato estranho basta.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(limpo)) {
    return { ok: false, mensagem: 'E-mail inválido.' }
  }

  const [p] = await db
    .select({ id: paciente.id, nome: paciente.nome, status: paciente.status })
    .from(paciente)
    .where(eq(paciente.id, pacienteId))

  if (!p) return { ok: false, mensagem: 'Paciente não encontrado.' }
  if (p.status === 'arquivado') {
    return { ok: false, mensagem: 'Paciente arquivado não recebe acesso ao portal.' }
  }

  // E-mail é único no realm do paciente: dois pacientes com o mesmo login seria
  // ambiguidade na hora de entrar.
  const [conflito] = await db
    .select({ pacienteId: pacienteConta.pacienteId })
    .from(pacienteConta)
    .where(sql`lower(${pacienteConta.email}) = ${limpo}`)

  if (conflito && conflito.pacienteId !== pacienteId) {
    return { ok: false, mensagem: 'Este e-mail já está em uso por outro paciente.' }
  }

  const convite = gerarConvite()

  try {
    const [existente] = await db
      .select({ id: pacienteConta.id, senhaHash: pacienteConta.senhaHash })
      .from(pacienteConta)
      .where(eq(pacienteConta.pacienteId, pacienteId))

    let contaId: string

    if (existente) {
      // Conta já existe: emite convite novo. Se ela já tinha senha, o convite
      // funciona como redefinição — e a trigger de `drizzle/0013` garante que o
      // convite morre quando a senha for gravada.
      await db
        .update(pacienteConta)
        .set({
          email: limpo,
          tokenConviteHash: convite.hash,
          tokenConviteExpiraEm: convite.expiraEm,
          ativo: true,
          bloqueadoAte: null,
        })
        .where(eq(pacienteConta.id, existente.id))
      contaId = existente.id
    } else {
      const [criada] = await db
        .insert(pacienteConta)
        .values({
          pacienteId,
          email: limpo,
          tokenConviteHash: convite.hash,
          tokenConviteExpiraEm: convite.expiraEm,
        })
        .returning({ id: pacienteConta.id })
      contaId = criada!.id
    }

    await registrar({
      ator,
      acao: existente ? 'atualizacao' : 'criacao',
      entidade: 'paciente_conta',
      entidadeId: contaId,
      pacienteId,
      // O convite NÃO entra na trilha — nem em `detalhes`. O log é lido por mais
      // gente que a conta, e um convite no log é uma credencial no log.
      detalhes: { conviteEmitido: true, expiraEm: convite.expiraEm.toISOString() },
    })

    revalidatePath(`/pacientes/${pacienteId}`)

    return {
      ok: true,
      mensagem: existente
        ? 'Novo convite gerado. O anterior deixou de valer.'
        : 'Acesso criado. Entregue o convite ao paciente.',
      convite: convite.token,
      expiraEm: convite.expiraEm.toISOString(),
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Corta o acesso ao portal.
 *
 * Desativa a conta **e derruba as sessões abertas**. Só desativar deixaria quem
 * está logado continuar navegando até o fim das 12 horas — e "cortar o acesso"
 * precisa valer agora.
 */
export async function revogarAcessoAoPortal(pacienteId: string): Promise<ResultadoAcesso> {
  const ator = await exigirPermissao('paciente', 'editar')

  const [conta] = await db
    .select({ id: pacienteConta.id })
    .from(pacienteConta)
    .where(eq(pacienteConta.pacienteId, pacienteId))

  if (!conta) return { ok: false, mensagem: 'Este paciente não tem acesso ao portal.' }

  try {
    await db
      .update(pacienteConta)
      .set({ ativo: false, tokenConviteHash: null, tokenConviteExpiraEm: null })
      .where(eq(pacienteConta.id, conta.id))

    const encerradas = await revogarSessoes(conta.id, ator.usuarioId)

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'paciente_conta',
      entidadeId: conta.id,
      pacienteId,
      detalhes: { acessoRevogado: true, sessoesEncerradas: encerradas },
    })

    revalidatePath(`/pacientes/${pacienteId}`)
    return {
      ok: true,
      mensagem:
        encerradas > 0
          ? `Acesso revogado e ${encerradas} sessão(ões) encerrada(s).`
          : 'Acesso revogado.',
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Situação do acesso, para a ficha do paciente. */
export async function situacaoDoAcesso(pacienteId: string) {
  const [conta] = await db
    .select({
      id: pacienteConta.id,
      email: pacienteConta.email,
      ativo: pacienteConta.ativo,
      senhaDefinidaEm: pacienteConta.senhaDefinidaEm,
      tokenConviteExpiraEm: pacienteConta.tokenConviteExpiraEm,
      temConvitePendente: sql<boolean>`${pacienteConta.tokenConviteHash} is not null`,
      ultimoLoginEm: pacienteConta.ultimoLoginEm,
      bloqueadoAte: pacienteConta.bloqueadoAte,
    })
    .from(pacienteConta)
    .where(eq(pacienteConta.pacienteId, pacienteId))

  if (!conta) return null

  const [sessoes] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from paciente_sessao
     where conta_id = ${conta.id} and revogada_em is null and expira_em > now()
  `).then((r) => (Array.isArray(r) ? r : r.rows) as { n: number }[])

  return { ...conta, sessoesAbertas: sessoes?.n ?? 0 }
}

/** Reativa uma conta revogada, com convite novo. */
export async function reativarAcessoAoPortal(
  pacienteId: string,
  email: string,
): Promise<ResultadoAcesso> {
  // Reativar é o mesmo caminho de liberar: conta existente ganha convite novo e
  // volta a `ativo`. Não há atalho que reative sem convite — a senha antiga pode
  // ser exatamente o motivo da revogação.
  return liberarAcessoAoPortal(pacienteId, email)
}

function mensagemDeErro(e: unknown): string {
  let atual: unknown = e
  while (atual instanceof Error) {
    const m = atual.message
    if (!m.startsWith('Failed query') && !m.includes('insert into')) return m
    atual = (atual as { cause?: unknown }).cause
  }
  return 'Não foi possível concluir a operação.'
}
