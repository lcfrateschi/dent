'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { dentePaciente, execucao, itemPlano, planoTratamento, procedimento } from '@/lib/db/schema'
import type { Face } from '@/lib/domain/dentes'
import { ErroDominio } from '@/lib/domain/erros'
import { descreverFaces } from '@/lib/domain/faces'
import { exigirItemCoerente, exigirTransicao } from '@/lib/domain/itemPlano'
import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { EstadoDenteRegistrado } from './consultas'

/**
 * Ações do odontograma.
 *
 * O odontograma é a porta de entrada do plano de tratamento: o dentista clica
 * nas faces e isso PRECISA virar `item_plano`, não um estado solto de UI. Toda
 * marca no diagrama tem consequência financeira e clínica.
 *
 * A validação de coerência (`exigirItemCoerente`) roda aqui, não só no banco:
 * o banco não vê `procedimento.requer_face` na hora de checar `item_plano`.
 */

export type ResultadoOdontograma =
  | { ok: true; itemId?: string; mensagem?: string; execucaoId?: string }
  | { ok: false; mensagem: string }

/**
 * Cria um item de plano a partir da seleção no diagrama.
 *
 * O plano é criado **sob demanda**: exigir que a recepção crie um plano vazio
 * antes de o dentista poder marcar o primeiro dente inverte a ordem natural do
 * atendimento. A gestão de planos vem na Fase 6.
 */
export async function planejarProcedimento({
  pacienteId,
  procedimentoId,
  denteFdi,
  faces,
  observacao,
}: {
  pacienteId: string
  procedimentoId: string
  denteFdi: number
  faces: readonly Face[]
  observacao?: string | undefined
}): Promise<ResultadoOdontograma> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('plano_tratamento', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (!ator.profissionalId) {
    return {
      ok: false,
      mensagem: 'Só um profissional com CRO pode planejar procedimento.',
    }
  }

  const [proc] = await db
    .select({
      id: procedimento.id,
      nome: procedimento.nome,
      valorParticular: procedimento.valorParticular,
      requerDente: procedimento.requerDente,
      requerFace: procedimento.requerFace,
    })
    .from(procedimento)
    .where(eq(procedimento.id, procedimentoId))
    .limit(1)

  if (!proc) return { ok: false, mensagem: 'Procedimento não encontrado.' }

  try {
    // Anatomia e coerência com o catálogo — antes de tocar no banco.
    exigirItemCoerente({ procedimento: proc, denteFdi, faces })
  } catch (e) {
    return {
      ok: false,
      mensagem: e instanceof ErroDominio ? e.message : 'Combinação de dente e faces inválida.',
    }
  }

  try {
    const itemId = await db.transaction(async (tx) => {
      const planoId = await garantirPlanoAtivo(tx, pacienteId, ator.profissionalId!)

      const [criado] = await tx
        .insert(itemPlano)
        .values({
          planoId,
          procedimentoId: proc.id,
          denteFdi,
          faces: faces.length > 0 ? [...faces] : null,
          // Particular por padrão. Convênio entra na Fase 13, e o gancho
          // (cobertura, convenio_id) já existe no schema desde a Fase 1.
          cobertura: 'particular',
          valor: proc.valorParticular,
          status: 'proposto',
          observacao: observacao ?? null,
        })
        .returning({ id: itemPlano.id })

      return criado?.id ?? null
    })

    if (!itemId) return { ok: false, mensagem: 'Não foi possível salvar.' }

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'item_plano',
      entidadeId: itemId,
      pacienteId,
      detalhes: {
        procedimento: proc.nome,
        denteFdi,
        // Descrição congelada, a mesma que vai para o orçamento na Fase 6.
        alvo: descreverFaces(denteFdi, faces),
      },
    })

    revalidatePath(`/pacientes/${pacienteId}/odontograma`)
    return { ok: true, itemId, mensagem: `${proc.nome} — ${descreverFaces(denteFdi, faces)}` }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/** Registra que um item planejado foi executado. Gera a marca azul no diagrama. */
export async function registrarExecucao(
  itemId: string,
  pacienteId: string,
): Promise<ResultadoOdontograma> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('odontograma', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (!ator.profissionalId) {
    return { ok: false, mensagem: 'Só um profissional com CRO pode registrar execução.' }
  }

  const [item] = await db
    .select({ status: itemPlano.status })
    .from(itemPlano)
    .where(eq(itemPlano.id, itemId))
    .limit(1)

  if (!item) return { ok: false, mensagem: 'Item não encontrado.' }

  // Item proposto precisa ser aprovado antes de executado: a máquina de estados
  // existe para o paciente não ser cobrado por algo que não autorizou.
  try {
    if (item.status === 'proposto') {
      exigirTransicao('proposto', 'aprovado')
    }
    exigirTransicao(item.status === 'proposto' ? 'aprovado' : (item.status as 'aprovado'), 'executado')
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : 'Transição inválida.' }
  }

  // O id da execução volta para a tela: é ele que liga o consumo de material ao
  // atendimento, e sem devolvê-lo a proposta de baixa não teria a que se referir.
  const execucaoId = await db.transaction(async (tx) => {
    if (item.status === 'proposto') {
      await tx
        .update(itemPlano)
        .set({ status: 'aprovado', aprovadoEm: new Date() })
        .where(eq(itemPlano.id, itemId))
    }
    const [nova] = await tx
      .insert(execucao)
      .values({
        itemPlanoId: itemId,
        profissionalId: ator.profissionalId!,
        executadoEm: new Date(),
      })
      .returning({ id: execucao.id })
    await tx.update(itemPlano).set({ status: 'executado' }).where(eq(itemPlano.id, itemId))
    return nova?.id
  })

  await registrar({
    ator,
    acao: 'criacao',
    entidade: 'execucao',
    entidadeId: itemId,
    pacienteId,
    detalhes: { de: item.status, para: 'executado' },
  })

  revalidatePath(`/pacientes/${pacienteId}/odontograma`)
  return { ok: true, itemId, execucaoId }
}

/** Cancela um item ainda não executado — desfaz a marca vermelha. */
export async function cancelarItem(
  itemId: string,
  pacienteId: string,
): Promise<ResultadoOdontograma> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('plano_tratamento', 'excluir')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const [item] = await db
    .select({ status: itemPlano.status })
    .from(itemPlano)
    .where(eq(itemPlano.id, itemId))
    .limit(1)

  if (!item) return { ok: false, mensagem: 'Item não encontrado.' }

  try {
    exigirTransicao(item.status as 'proposto', 'cancelado')
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : 'Não é possível cancelar.' }
  }

  await db.update(itemPlano).set({ status: 'cancelado' }).where(eq(itemPlano.id, itemId))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'item_plano',
    entidadeId: itemId,
    pacienteId,
    detalhes: { de: item.status, para: 'cancelado' },
  })

  revalidatePath(`/pacientes/${pacienteId}/odontograma`)
  return { ok: true }
}

/**
 * Constata o estado do dente inteiro.
 *
 * Não cria item de plano: "o 18 não está aqui" é achado de exame, não
 * procedimento executado. `null` volta o dente ao normal.
 */
export async function definirEstadoDente({
  pacienteId,
  denteFdi,
  estado,
  observacao,
}: {
  pacienteId: string
  denteFdi: number
  estado: EstadoDenteRegistrado | null
  observacao?: string | undefined
}): Promise<ResultadoOdontograma> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('odontograma', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  try {
    if (estado === null) {
      await db
        .delete(dentePaciente)
        .where(and(eq(dentePaciente.pacienteId, pacienteId), eq(dentePaciente.denteFdi, denteFdi)))
    } else {
      await db
        .insert(dentePaciente)
        .values({
          pacienteId,
          denteFdi,
          estado,
          observacao: observacao ?? null,
          profissionalId: ator.profissionalId,
        })
        .onConflictDoUpdate({
          target: [dentePaciente.pacienteId, dentePaciente.denteFdi],
          set: {
            estado,
            observacao: observacao ?? null,
            profissionalId: ator.profissionalId,
            atualizadoEm: new Date(),
          },
        })
    }

    await registrar({
      ator,
      acao: estado === null ? 'exclusao' : 'atualizacao',
      entidade: 'dente_paciente',
      entidadeId: `${pacienteId}:${denteFdi}`,
      pacienteId,
      detalhes: { denteFdi, estado },
    })

    revalidatePath(`/pacientes/${pacienteId}/odontograma`)
    return { ok: true }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

// ── Auxiliares ───────────────────────────────────────────────────────────────

/** Localiza o plano ativo ou cria um. Ver comentário em `planejarProcedimento`. */
async function garantirPlanoAtivo(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  pacienteId: string,
  profissionalId: string,
): Promise<string> {
  const [existente] = await tx
    .select({ id: planoTratamento.id })
    .from(planoTratamento)
    .where(and(eq(planoTratamento.pacienteId, pacienteId), eq(planoTratamento.status, 'ativo')))
    .limit(1)

  if (existente) return existente.id

  const [criado] = await tx
    .insert(planoTratamento)
    .values({
      pacienteId,
      profissionalId,
      titulo: 'Plano de tratamento',
      status: 'ativo',
    })
    .returning({ id: planoTratamento.id })

  if (!criado) throw new Error('Não foi possível criar o plano de tratamento.')
  return criado.id
}

function respostaDeAcesso(e: unknown): ResultadoOdontograma {
  if (e instanceof SemSessao) return { ok: false, mensagem: 'Sua sessão expirou. Entre novamente.' }
  if (e instanceof SemPermissao) return { ok: false, mensagem: 'Seu perfil não permite esta ação.' }
  throw e
}

function respostaDeBanco(e: unknown): ResultadoOdontograma {
  if (e instanceof ErroDominio) return { ok: false, mensagem: e.message }

  const texto = e instanceof Error ? e.message : String(e)

  if (texto.includes('item_plano_face_exige_dente')) {
    return { ok: false, mensagem: 'Não é possível indicar faces sem indicar o dente.' }
  }
  if (texto.includes('item_plano_convenio_coerente')) {
    return { ok: false, mensagem: 'Cobertura e convênio não concordam.' }
  }
  if (texto.includes('dente_fdi')) {
    return { ok: false, mensagem: 'Dente inválido.' }
  }

  console.error('[odontograma] erro inesperado', texto)
  return { ok: false, mensagem: 'Não foi possível salvar. Tente novamente.' }
}
