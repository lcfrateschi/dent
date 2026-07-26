'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { documento } from '@/lib/db/schema'
import type { TipoDocumento } from '@/lib/domain/arquivo'
import { ehFdiValido } from '@/lib/domain/dentes'
import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  type EntradaUpload,
  type ResultadoDocumento,
  anexarComAtor,
  mensagemDeErro,
} from './anexar'

/**
 * Ações de documento.
 *
 * Camada fina de propósito: autoriza e delega. A regra do upload — validação,
 * ordem storage→banco e compensação em caso de falha — mora em `anexar.ts`, que
 * é código comum e verificável fora de uma requisição.
 */

export type { ResultadoDocumento } from './anexar'

/** Anexa um arquivo ao prontuário do paciente. */
export async function anexarDocumento(
  entrada: EntradaUpload,
  conteudo: Uint8Array,
  mimeDeclarado?: string,
): Promise<ResultadoDocumento> {
  const ator = await exigirPermissao('documento', 'criar')
  const r = await anexarComAtor(ator, entrada, conteudo, mimeDeclarado)

  if (r.ok) {
    revalidatePath(`/pacientes/${entrada.pacienteId}/documentos`)
    revalidatePath(`/pacientes/${entrada.pacienteId}`)
  }
  return r
}

/**
 * Remoção lógica.
 *
 * Exige motivo — e o banco também exige (`drizzle/0011`), porque este não é o
 * único caminho possível. Não há "restaurar": ver o comentário da coluna
 * `removido_em` em `lib/db/schema/documentos.ts`.
 */
export async function removerDocumento(
  id: string,
  motivo: string,
): Promise<{ ok: boolean; mensagem: string }> {
  const ator = await exigirPermissao('documento', 'editar')

  const texto = motivo.trim()
  if (texto.length < 5) {
    return {
      ok: false,
      mensagem: 'Diga por que está removendo — fica no prontuário e não se desfaz.',
    }
  }

  try {
    const feitas = await db
      .update(documento)
      .set({
        removidoEm: new Date(),
        motivoRemocao: texto.slice(0, 500),
        removidoPorId: ator.usuarioId,
      })
      .where(and(eq(documento.id, id), isNull(documento.removidoEm)))
      .returning({ id: documento.id, pacienteId: documento.pacienteId })

    const alvo = feitas[0]
    if (!alvo) return { ok: false, mensagem: 'Documento não encontrado ou já removido.' }

    await registrar({
      ator,
      acao: 'exclusao',
      entidade: 'documento',
      entidadeId: alvo.id,
      pacienteId: alvo.pacienteId,
      detalhes: { logica: true },
    })

    revalidatePath(`/pacientes/${alvo.pacienteId}/documentos`)
    return { ok: true, mensagem: 'Documento removido do prontuário.' }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Corrige metadado. O arquivo e o paciente não mudam — o banco impede. */
export async function corrigirDocumento(
  id: string,
  campos: {
    readonly nome?: string
    readonly descricao?: string
    readonly denteFdi?: number | null
    readonly etapa?: 'inicial' | 'durante' | 'final' | null
    readonly dataExame?: string | null
  },
): Promise<{ ok: boolean; mensagem: string }> {
  const ator = await exigirPermissao('documento', 'editar')

  try {
    if (campos.denteFdi != null && !ehFdiValido(campos.denteFdi)) {
      return { ok: false, mensagem: `Dente ${campos.denteFdi} não existe na notação FDI.` }
    }

    const alteracoes: Record<string, unknown> = {}
    if (campos.nome !== undefined) {
      const nome = campos.nome.trim()
      if (nome.length === 0) return { ok: false, mensagem: 'O nome não pode ficar vazio.' }
      alteracoes.nome = nome.slice(0, 200)
    }
    if (campos.descricao !== undefined) alteracoes.descricao = campos.descricao.trim() || null
    if (campos.denteFdi !== undefined) alteracoes.denteFdi = campos.denteFdi
    if (campos.etapa !== undefined) alteracoes.etapa = campos.etapa
    if (campos.dataExame !== undefined) {
      alteracoes.dataExame = campos.dataExame ? new Date(campos.dataExame) : null
    }

    if (Object.keys(alteracoes).length === 0) {
      return { ok: true, mensagem: 'Nada a alterar.' }
    }

    const feitas = await db
      .update(documento)
      .set(alteracoes)
      .where(and(eq(documento.id, id), isNull(documento.removidoEm)))
      .returning({ id: documento.id, pacienteId: documento.pacienteId })

    const alvo = feitas[0]
    if (!alvo) return { ok: false, mensagem: 'Documento não encontrado ou já removido.' }

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'documento',
      entidadeId: alvo.id,
      pacienteId: alvo.pacienteId,
      detalhes: { campos: Object.keys(alteracoes) },
    })

    revalidatePath(`/pacientes/${alvo.pacienteId}/documentos`)
    return { ok: true, mensagem: 'Documento atualizado.' }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Upload vindo de `<form>` — converte o `File` e delega. */
export async function anexarDoFormulario(dados: FormData): Promise<ResultadoDocumento> {
  const arquivo = dados.get('arquivo')
  if (!(arquivo instanceof File) || arquivo.size === 0) {
    return { ok: false, mensagem: 'Escolha um arquivo.' }
  }

  const denteBruto = String(dados.get('denteFdi') ?? '')
  const etapaBruta = String(dados.get('etapa') ?? '')

  return anexarDocumento(
    {
      pacienteId: String(dados.get('pacienteId') ?? ''),
      tipo: String(dados.get('tipo') ?? '') as TipoDocumento,
      nome: String(dados.get('nome') ?? '').trim() || arquivo.name,
      descricao: String(dados.get('descricao') ?? '') || undefined,
      denteFdi: denteBruto ? Number(denteBruto) : undefined,
      etapa: etapaBruta ? (etapaBruta as 'inicial' | 'durante' | 'final') : undefined,
      dataExame: String(dados.get('dataExame') ?? '') || undefined,
    },
    new Uint8Array(await arquivo.arrayBuffer()),
    arquivo.type,
  )
}
