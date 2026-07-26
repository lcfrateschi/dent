'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { paciente } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { type ErrosCampo, achatarErros, dosCampos, pacienteSchema } from './schema'

/**
 * Server actions de paciente.
 *
 * O padrão de toda action, na ordem:
 *   1. `exigirPermissao` — sessão + RBAC. Esconder o botão não protege a rota.
 *   2. Zod valida a entrada.
 *   3. Persiste.
 *   4. `registrar` na trilha de auditoria.
 *
 * Este é o molde que os módulos das Fases 4+ vão repetir.
 */

export type ResultadoForm =
  | { ok: true; id: string }
  | { ok: false; erros: ErrosCampo; mensagem?: string }

export async function criarPaciente(
  _anterior: ResultadoForm | null,
  dados: FormData,
): Promise<ResultadoForm> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('paciente', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const analise = pacienteSchema.safeParse(dosCampos(dados))
  if (!analise.success) {
    return { ok: false, erros: achatarErros(analise.error) }
  }

  const v = analise.data

  try {
    const [criado] = await db
      .insert(paciente)
      .values({
        nome: v.nome,
        nomeSocial: v.nomeSocial ?? null,
        cpf: v.cpf ?? null,
        rg: v.rg ?? null,
        dataNascimento: v.dataNascimento,
        sexo: v.sexo,
        telefone: v.telefone ?? null,
        telefoneWhatsapp: v.telefoneWhatsapp ?? null,
        email: v.email ?? null,
        cep: v.cep ?? null,
        logradouro: v.logradouro ?? null,
        numero: v.numero ?? null,
        complemento: v.complemento ?? null,
        bairro: v.bairro ?? null,
        cidade: v.cidade ?? null,
        uf: v.uf ?? null,
        responsavelLegalId: v.responsavelLegalId ?? null,
        indicadoPor: v.indicadoPor ?? null,
        observacoes: v.observacoes ?? null,
        status: v.status,
      })
      .returning({ id: paciente.id })

    if (!criado) return { ok: false, erros: {}, mensagem: 'Não foi possível salvar.' }

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'paciente',
      entidadeId: criado.id,
      pacienteId: criado.id,
    })

    revalidatePath('/pacientes')
    return { ok: true, id: criado.id }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

export async function atualizarPaciente(
  id: string,
  _anterior: ResultadoForm | null,
  dados: FormData,
): Promise<ResultadoForm> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('paciente', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const analise = pacienteSchema.safeParse(dosCampos(dados))
  if (!analise.success) {
    return { ok: false, erros: achatarErros(analise.error) }
  }

  const v = analise.data

  // Um paciente não pode ser responsável por si mesmo. O banco também barra
  // (CHECK paciente_nao_e_responsavel_de_si); aqui a mensagem é apresentável.
  if (v.responsavelLegalId === id) {
    return {
      ok: false,
      erros: { responsavelLegalId: 'O paciente não pode ser o próprio responsável.' },
    }
  }

  try {
    const [atualizado] = await db
      .update(paciente)
      .set({
        nome: v.nome,
        nomeSocial: v.nomeSocial ?? null,
        cpf: v.cpf ?? null,
        rg: v.rg ?? null,
        dataNascimento: v.dataNascimento,
        sexo: v.sexo,
        telefone: v.telefone ?? null,
        telefoneWhatsapp: v.telefoneWhatsapp ?? null,
        email: v.email ?? null,
        cep: v.cep ?? null,
        logradouro: v.logradouro ?? null,
        numero: v.numero ?? null,
        complemento: v.complemento ?? null,
        bairro: v.bairro ?? null,
        cidade: v.cidade ?? null,
        uf: v.uf ?? null,
        responsavelLegalId: v.responsavelLegalId ?? null,
        indicadoPor: v.indicadoPor ?? null,
        observacoes: v.observacoes ?? null,
        status: v.status,
      })
      .where(eq(paciente.id, id))
      .returning({ id: paciente.id })

    if (!atualizado) return { ok: false, erros: {}, mensagem: 'Paciente não encontrado.' }

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'paciente',
      entidadeId: id,
      pacienteId: id,
      // Só os NOMES dos campos: o log registra que houve alteração, não o
      // conteúdo. Copiar valores criaria uma segunda cópia do cadastro.
      detalhes: { campos: Object.keys(dosCampos(dados)) },
    })

    revalidatePath('/pacientes')
    revalidatePath(`/pacientes/${id}`)
    return { ok: true, id }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/**
 * Arquiva em vez de excluir.
 *
 * Prontuário tem guarda mínima de 20 anos (CFO) e o paciente pode ter histórico
 * financeiro. `excluir` no RBAC significa "tirar da operação", não `DELETE`.
 */
export async function arquivarPaciente(id: string): Promise<void> {
  const ator = await exigirPermissao('paciente', 'excluir')

  await db.update(paciente).set({ status: 'arquivado' }).where(eq(paciente.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'paciente',
    entidadeId: id,
    pacienteId: id,
    detalhes: { campo: 'status', valor: 'arquivado' },
  })

  revalidatePath('/pacientes')
  redirect('/pacientes')
}

export async function reativarPaciente(id: string): Promise<void> {
  const ator = await exigirPermissao('paciente', 'editar')

  await db.update(paciente).set({ status: 'ativo' }).where(eq(paciente.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'paciente',
    entidadeId: id,
    pacienteId: id,
    detalhes: { campo: 'status', valor: 'ativo' },
  })

  revalidatePath('/pacientes')
  revalidatePath(`/pacientes/${id}`)
}

// ── Tradução de erros ────────────────────────────────────────────────────────

function respostaDeAcesso(e: unknown): ResultadoForm {
  if (e instanceof SemSessao) {
    return { ok: false, erros: {}, mensagem: 'Sua sessão expirou. Entre novamente.' }
  }
  if (e instanceof SemPermissao) {
    return { ok: false, erros: {}, mensagem: 'Seu perfil não permite esta ação.' }
  }
  throw e
}

/**
 * Converte violação de constraint em mensagem de campo.
 *
 * O banco é a última linha e ganha corridas que a aplicação perde: dois
 * cadastros simultâneos com o mesmo CPF passam pela checagem em memória e só o
 * índice único barra o segundo.
 */
function respostaDeBanco(e: unknown): ResultadoForm {
  const texto = e instanceof Error ? e.message : String(e)

  if (texto.includes('paciente_cpf_uk')) {
    return { ok: false, erros: { cpf: 'Já existe um paciente com este CPF.' } }
  }
  if (texto.includes('paciente_nao_e_responsavel_de_si')) {
    return {
      ok: false,
      erros: { responsavelLegalId: 'O paciente não pode ser o próprio responsável.' },
    }
  }
  if (texto.includes('responsavel_legal_id')) {
    return { ok: false, erros: { responsavelLegalId: 'Responsável legal não encontrado.' } }
  }

  console.error('[pacientes] erro inesperado ao gravar', texto)
  return { ok: false, erros: {}, mensagem: 'Não foi possível salvar. Tente novamente.' }
}
