'use server'

import { registrar, registrarLeitura } from '@/lib/auditoria/registrar'
import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { alertaClinico, anamnese } from '@/lib/db/schema'
import type { Ator } from '@/lib/authz/sessao'
import { and, desc, eq, isNotNull, max } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { type AlertaDerivado, derivarAlertas } from './alertas'
import { type Respostas, VERSAO_ATUAL, formularioDaVersao } from './formulario'

/**
 * Persistência da anamnese.
 *
 * **Versionada, nunca sobrescrita.** Refazer a anamnese insere versão N+1. A
 * resposta antiga continua legível porque a versão do FORMULÁRIO que a gerou
 * também é gravada — sem isso, uma pergunta removida deixaria respostas órfãs
 * impossíveis de interpretar.
 */

export type ResultadoAnamnese =
  | { ok: true; anamneseId: string; alertas: readonly AlertaDerivado[] }
  | { ok: false; mensagem: string }

export async function salvarAnamnese({
  pacienteId,
  respostas,
}: {
  pacienteId: string
  respostas: Respostas
}): Promise<ResultadoAnamnese> {
  let ator: Ator
  try {
    ator = await exigirPermissao('anamnese', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const formulario = formularioDaVersao(VERSAO_ATUAL)
  if (!formulario) return { ok: false, mensagem: 'Versão de formulário desconhecida.' }

  try {
    const anamneseId = await db.transaction(async (tx) => {
      const [ultima] = await tx
        .select({ maior: max(anamnese.versao) })
        .from(anamnese)
        .where(eq(anamnese.pacienteId, pacienteId))

      const versao = (ultima?.maior ?? 0) + 1

      const [criada] = await tx
        .insert(anamnese)
        .values({
          pacienteId,
          profissionalId: ator.profissionalId,
          versao,
          respostas,
          versaoFormulario: VERSAO_ATUAL,
        })
        .returning({ id: anamnese.id })

      return criada?.id ?? null
    })

    if (!anamneseId) return { ok: false, mensagem: 'Não foi possível salvar.' }

    const alertas = derivarAlertas(respostas)

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'anamnese',
      entidadeId: anamneseId,
      pacienteId,
      // Só a CONTAGEM de alertas, nunca o conteúdo: a trilha registra que houve
      // acesso, não duplica o dado clínico.
      detalhes: { versaoFormulario: VERSAO_ATUAL, alertasSugeridos: alertas.length },
    })

    revalidatePath(`/pacientes/${pacienteId}`)
    revalidatePath(`/pacientes/${pacienteId}/anamnese`)
    return { ok: true, anamneseId, alertas }
  } catch (e) {
    console.error('[anamnese] erro ao salvar', e)
    return { ok: false, mensagem: 'Não foi possível salvar. Tente novamente.' }
  }
}

/**
 * Grava os alertas que o dentista CONFIRMOU.
 *
 * Derivação é sugestão; gravação é decisão humana. Automação que escreve no
 * prontuário sem revisão é o que faz sistema clínico perder confiança — e o
 * alerta errado é pior que nenhum, porque a equipe aprende a ignorar a faixa.
 *
 * Os alertas anteriores derivados de anamnese são desativados, não apagados:
 * `alerta_clinico` guarda histórico do que já foi sinalizado.
 */
export async function confirmarAlertas({
  pacienteId,
  anamneseId,
  alertas,
}: {
  pacienteId: string
  anamneseId: string
  alertas: readonly AlertaDerivado[]
}): Promise<{ ok: boolean; mensagem?: string; gravados?: number }> {
  let ator: Ator
  try {
    ator = await exigirPermissao('alerta_clinico', 'criar')
  } catch (e) {
    const r = respostaDeAcesso(e)
    return { ok: false, mensagem: r.ok ? undefined : r.mensagem }
  }

  try {
    await db.transaction(async (tx) => {
      // Desativa os automáticos anteriores; os manuais permanecem intactos.
      await tx
        .update(alertaClinico)
        .set({ ativo: false })
        .where(
          and(
            eq(alertaClinico.pacienteId, pacienteId),
            eq(alertaClinico.ativo, true),
            // Só os que vieram de anamnese: alerta criado à mão pelo dentista
            // não é sobrescrito por um questionário.
            isNotNull(alertaClinico.origemAnamneseId),
          ),
        )

      if (alertas.length > 0) {
        await tx.insert(alertaClinico).values(
          alertas.map((a) => ({
            pacienteId,
            tipo: a.tipo,
            descricao: a.descricao,
            severidade: a.severidade,
            origemAnamneseId: anamneseId,
            ativo: true,
          })),
        )
      }
    })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'alerta_clinico',
      entidadeId: anamneseId,
      pacienteId,
      detalhes: { confirmados: alertas.length, regras: alertas.map((a) => a.regra) },
    })

    revalidatePath(`/pacientes/${pacienteId}`)
    revalidatePath(`/pacientes/${pacienteId}/odontograma`)
    return { ok: true, gravados: alertas.length }
  } catch (e) {
    console.error('[anamnese] erro ao confirmar alertas', e)
    return { ok: false, mensagem: 'Não foi possível gravar os alertas.' }
  }
}

// ── Leitura ──────────────────────────────────────────────────────────────────

export interface AnamneseSalva {
  readonly id: string
  readonly versao: number
  readonly versaoFormulario: string
  readonly respostas: Respostas
  readonly preenchidaEm: Date
}

export async function ultimaAnamnese(
  ator: Ator,
  pacienteId: string,
): Promise<AnamneseSalva | null> {
  const [linha] = await db
    .select({
      id: anamnese.id,
      versao: anamnese.versao,
      versaoFormulario: anamnese.versaoFormulario,
      respostas: anamnese.respostas,
      preenchidaEm: anamnese.preenchidaEm,
    })
    .from(anamnese)
    .where(eq(anamnese.pacienteId, pacienteId))
    .orderBy(desc(anamnese.versao))
    .limit(1)

  if (!linha) return null

  await registrarLeitura(ator, 'anamnese', pacienteId, { versao: linha.versao })

  return { ...linha, respostas: linha.respostas as Respostas }
}

export async function historicoAnamnese(
  pacienteId: string,
): Promise<readonly { id: string; versao: number; preenchidaEm: Date }[]> {
  return db
    .select({ id: anamnese.id, versao: anamnese.versao, preenchidaEm: anamnese.preenchidaEm })
    .from(anamnese)
    .where(eq(anamnese.pacienteId, pacienteId))
    .orderBy(desc(anamnese.versao))
}

function respostaDeAcesso(e: unknown): ResultadoAnamnese {
  if (e instanceof SemSessao) return { ok: false, mensagem: 'Sua sessão expirou. Entre novamente.' }
  if (e instanceof SemPermissao) return { ok: false, mensagem: 'Seu perfil não permite esta ação.' }
  throw e
}
