'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { evolucao } from '@/lib/db/schema'
import { ErroDominio } from '@/lib/domain/erros'
import {
  calcularAssinatura,
  ehRascunho,
  exigirPodeEditar,
  exigirRetificacaoValida,
} from '@/lib/domain/prontuario'
import { and, eq, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

/**
 * Ações da evolução clínica.
 *
 * ── O domínio já existia ────────────────────────────────────────────────────
 * As regras estão em `lib/domain/prontuario.ts` desde a Fase 1, com 18 testes:
 * o que é rascunho, quem pode editar, como se calcula a assinatura, quando uma
 * retificação é válida. Esta camada só liga aquilo ao banco.
 *
 * ── Três guardas, de propósito ──────────────────────────────────────────────
 * 1. RBAC: só `dentista` tem `prontuario:criar` e `prontuario:assinar`.
 * 2. Domínio: `exigirPodeEditar` e `exigirRetificacaoValida`.
 * 3. Banco: o trigger `evolucao_append_only` recusa UPDATE em assinada e
 *    DELETE em qualquer uma.
 *
 * Redundância intencional. A do banco é a que vale quando a aplicação tem bug —
 * e prontuário é guarda legal de 20 anos.
 */

export type ResultadoEvolucao =
  | { ok: true; evolucaoId: string; mensagem?: string }
  | { ok: false; mensagem: string }

/**
 * Cria a evolução como RASCUNHO, sem assinar.
 *
 * Separar criar de assinar é o que permite o dentista escrever durante o
 * atendimento, com o paciente na cadeira, e revisar antes de tornar o registro
 * definitivo. Assinar no mesmo clique produziria prontuário com erro de digitação
 * que só a retificação conserta.
 */
export async function criarRascunho({
  pacienteId,
  texto,
  agendamentoId,
}: {
  pacienteId: string
  texto: string
  agendamentoId?: string | undefined
}): Promise<ResultadoEvolucao> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('prontuario', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (!ator.profissionalId) {
    return { ok: false, mensagem: 'Só um profissional com CRO pode registrar evolução.' }
  }
  if (texto.trim().length === 0) {
    return { ok: false, mensagem: 'A evolução não pode ser vazia.' }
  }

  try {
    // Um rascunho aberto por vez, por profissional e paciente: dois rascunhos
    // simultâneos levariam a assinar o texto errado.
    const [existente] = await db
      .select({ id: evolucao.id })
      .from(evolucao)
      .where(
        and(
          eq(evolucao.pacienteId, pacienteId),
          eq(evolucao.profissionalId, ator.profissionalId),
          isNull(evolucao.assinadoEm),
        ),
      )
      .limit(1)

    if (existente) {
      return {
        ok: false,
        mensagem: 'Você já tem um rascunho aberto para este paciente. Assine ou edite aquele.',
      }
    }

    const [criada] = await db
      .insert(evolucao)
      .values({
        pacienteId,
        profissionalId: ator.profissionalId,
        agendamentoId: agendamentoId ?? null,
        texto: texto.trim(),
      })
      .returning({ id: evolucao.id })

    if (!criada) return { ok: false, mensagem: 'Não foi possível salvar.' }

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'evolucao',
      entidadeId: criada.id,
      pacienteId,
      // Nunca o texto: a trilha registra QUE houve escrita, não duplica o
      // prontuário fora das regras de retenção.
      detalhes: { rascunho: true, caracteres: texto.trim().length },
    })

    revalidatePath(`/pacientes/${pacienteId}/prontuario`)
    return { ok: true, evolucaoId: criada.id }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/** Edita o próprio rascunho. Assinada não passa por aqui — o banco recusa. */
export async function editarRascunho(
  id: string,
  texto: string,
): Promise<ResultadoEvolucao> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('prontuario', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (!ator.profissionalId) {
    return { ok: false, mensagem: 'Só um profissional com CRO pode editar evolução.' }
  }
  if (texto.trim().length === 0) {
    return { ok: false, mensagem: 'A evolução não pode ser vazia.' }
  }

  const atual = await acharParaEscrita(id)
  if (!atual) return { ok: false, mensagem: 'Evolução não encontrada.' }

  try {
    exigirPodeEditar(atual, ator.profissionalId)
  } catch (e) {
    return { ok: false, mensagem: e instanceof ErroDominio ? e.message : 'Não é possível editar.' }
  }

  try {
    await db.update(evolucao).set({ texto: texto.trim() }).where(eq(evolucao.id, id))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'evolucao',
      entidadeId: id,
      pacienteId: atual.pacienteId,
      detalhes: { rascunho: true },
    })

    revalidatePath(`/pacientes/${atual.pacienteId}/prontuario`)
    return { ok: true, evolucaoId: id }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/**
 * Assina a evolução. **Ponto sem volta.**
 *
 * Depois disto o registro é imutável para sempre — nem o autor, nem o admin, nem
 * o banco de dados via UPDATE. O hash cobre id, paciente, profissional, texto e
 * instante: qualquer alteração feita fora da aplicação deixa a assinatura
 * inconsistente, e a tela do prontuário mostra isso.
 */
export async function assinarEvolucao(id: string): Promise<ResultadoEvolucao> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('prontuario', 'assinar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (!ator.profissionalId) {
    return { ok: false, mensagem: 'Só um profissional com CRO pode assinar.' }
  }

  const atual = await acharParaEscrita(id)
  if (!atual) return { ok: false, mensagem: 'Evolução não encontrada.' }

  if (!ehRascunho(atual)) {
    return { ok: false, mensagem: 'Esta evolução já está assinada.' }
  }
  // Assinatura é ato pessoal: ninguém assina o registro de outro profissional.
  if (atual.profissionalId !== ator.profissionalId) {
    return { ok: false, mensagem: 'Só o autor pode assinar a própria evolução.' }
  }

  const assinadoEm = new Date()
  const assinaturaHash = calcularAssinatura({
    evolucaoId: atual.id,
    pacienteId: atual.pacienteId,
    profissionalId: atual.profissionalId,
    texto: atual.texto,
    assinadoEm,
  })

  try {
    // O CHECK `evolucao_assinatura_completa` exige os dois campos juntos.
    await db.update(evolucao).set({ assinadoEm, assinaturaHash }).where(eq(evolucao.id, id))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'evolucao',
      entidadeId: id,
      pacienteId: atual.pacienteId,
      detalhes: { assinada: true },
    })

    revalidatePath(`/pacientes/${atual.pacienteId}/prontuario`)
    return {
      ok: true,
      evolucaoId: id,
      mensagem: 'Evolução assinada. A partir de agora é imutável — correções exigem retificação.',
    }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/**
 * Retifica uma evolução assinada.
 *
 * Não é edição: cria um registro NOVO apontando para o anterior, que continua
 * legível no prontuário marcado como retificado. É o que a exigência do CFO
 * permite — a história do que foi registrado não pode desaparecer, mesmo quando
 * estava errada.
 *
 * A retificação já nasce assinada: um rascunho de correção pendurado seria uma
 * terceira versão da verdade.
 */
export async function retificarEvolucao({
  alvoId,
  texto,
  motivo,
}: {
  alvoId: string
  texto: string
  motivo: string
}): Promise<ResultadoEvolucao> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('prontuario', 'assinar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (!ator.profissionalId) {
    return { ok: false, mensagem: 'Só um profissional com CRO pode retificar.' }
  }

  const alvo = await acharParaEscrita(alvoId)
  if (!alvo) return { ok: false, mensagem: 'Evolução não encontrada.' }

  const retificacoesDoAlvo = await db
    .select({ id: evolucao.id })
    .from(evolucao)
    .where(eq(evolucao.retificaId, alvoId))

  try {
    exigirRetificacaoValida({
      alvo,
      texto,
      motivo,
      profissionalId: ator.profissionalId,
      retificacoesDoAlvo,
    })
  } catch (e) {
    return {
      ok: false,
      mensagem: e instanceof ErroDominio ? e.message : 'Retificação inválida.',
    }
  }

  try {
    const assinadoEm = new Date()

    const criada = await db.transaction(async (tx) => {
      const [nova] = await tx
        .insert(evolucao)
        .values({
          pacienteId: alvo.pacienteId,
          profissionalId: ator.profissionalId!,
          agendamentoId: null,
          texto: texto.trim(),
          retificaId: alvoId,
          motivoRetificacao: motivo.trim(),
        })
        .returning({ id: evolucao.id })

      if (!nova) throw new Error('Não foi possível criar a retificação.')

      // Assina em seguida, já com o id real — o hash depende dele.
      await tx
        .update(evolucao)
        .set({
          assinadoEm,
          assinaturaHash: calcularAssinatura({
            evolucaoId: nova.id,
            pacienteId: alvo.pacienteId,
            profissionalId: ator.profissionalId!,
            texto: texto.trim(),
            assinadoEm,
          }),
        })
        .where(eq(evolucao.id, nova.id))

      return nova
    })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'evolucao',
      entidadeId: criada.id,
      pacienteId: alvo.pacienteId,
      // O motivo VAI para a trilha: é metadado de correção, não conteúdo clínico,
      // e é exatamente o que uma auditoria precisa saber.
      detalhes: { retifica: alvoId, motivo: motivo.trim() },
    })

    revalidatePath(`/pacientes/${alvo.pacienteId}/prontuario`)
    return { ok: true, evolucaoId: criada.id, mensagem: 'Retificação registrada e assinada.' }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/** Descarta rascunho. Assinada nunca — o banco recusa o DELETE. */
export async function descartarRascunho(id: string): Promise<ResultadoEvolucao> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('prontuario', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const atual = await acharParaEscrita(id)
  if (!atual) return { ok: false, mensagem: 'Evolução não encontrada.' }

  if (!ehRascunho(atual)) {
    return {
      ok: false,
      mensagem: 'Evolução assinada não pode ser descartada. Registre uma retificação.',
    }
  }
  if (atual.profissionalId !== ator.profissionalId) {
    return { ok: false, mensagem: 'Só o autor pode descartar o próprio rascunho.' }
  }

  try {
    await db.delete(evolucao).where(eq(evolucao.id, id))

    await registrar({
      ator,
      acao: 'exclusao',
      entidade: 'evolucao',
      entidadeId: id,
      pacienteId: atual.pacienteId,
      detalhes: { rascunho: true },
    })

    revalidatePath(`/pacientes/${atual.pacienteId}/prontuario`)
    return { ok: true, evolucaoId: id }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

// ── Auxiliares ───────────────────────────────────────────────────────────────

/**
 * Leitura sem auditoria, para uso interno das ações.
 *
 * A auditoria da escrita é registrada pela própria ação; auditar a leitura
 * intermediária poluiria a trilha com um evento de leitura por clique de botão.
 */
async function acharParaEscrita(id: string): Promise<
  | {
      id: string
      pacienteId: string
      profissionalId: string
      texto: string
      assinadoEm: Date | null
      retificaId: string | null
      criadoEm: Date
    }
  | null
> {
  const [linha] = await db
    .select({
      id: evolucao.id,
      pacienteId: evolucao.pacienteId,
      profissionalId: evolucao.profissionalId,
      texto: evolucao.texto,
      assinadoEm: evolucao.assinadoEm,
      retificaId: evolucao.retificaId,
      criadoEm: evolucao.criadoEm,
    })
    .from(evolucao)
    .where(eq(evolucao.id, id))
    .limit(1)
  return linha ?? null
}

function respostaDeAcesso(e: unknown): ResultadoEvolucao {
  if (e instanceof SemSessao) return { ok: false, mensagem: 'Sua sessão expirou. Entre novamente.' }
  if (e instanceof SemPermissao) {
    return {
      ok: false,
      mensagem: 'Só o dentista tem acesso ao prontuário. Seu perfil não permite esta ação.',
    }
  }
  throw e
}

/** Traduz as mensagens dos triggers de drizzle/0001_constraints.sql. */
function respostaDeBanco(e: unknown): ResultadoEvolucao {
  if (e instanceof ErroDominio) return { ok: false, mensagem: e.message }

  const texto = e instanceof Error ? e.message : String(e)

  if (texto.includes('ja esta assinada e e imutavel')) {
    return {
      ok: false,
      mensagem:
        'Esta evolução já está assinada e é imutável. Para corrigir, registre uma retificação.',
    }
  }
  if (texto.includes('nao pode ser excluida')) {
    return {
      ok: false,
      mensagem: 'Evolução não pode ser excluída — guarda legal de 20 anos. Registre uma retificação.',
    }
  }
  if (texto.includes('sao imutaveis')) {
    return { ok: false, mensagem: 'Autoria e vínculo de uma evolução não podem ser alterados.' }
  }
  if (texto.includes('evolucao_texto_nao_vazio')) {
    return { ok: false, mensagem: 'A evolução não pode ser vazia.' }
  }
  if (texto.includes('evolucao_retifica_uk')) {
    return {
      ok: false,
      mensagem: 'Esta evolução já foi retificada. Retifique a versão mais recente da cadeia.',
    }
  }
  if (texto.includes('evolucao_retificacao_justificada')) {
    return { ok: false, mensagem: 'Retificar exige informar o motivo.' }
  }

  console.error('[prontuario] erro inesperado', texto)
  return { ok: false, mensagem: 'Não foi possível salvar. Tente novamente.' }
}
