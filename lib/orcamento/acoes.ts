'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { itemPlano, orcamento, orcamentoItem, planoTratamento } from '@/lib/db/schema'
import { ErroDominio } from '@/lib/domain/erros'
import {
  type Desconto,
  type LinhaOrcamento,
  type StatusOrcamento,
  calcularTotais,
  ehEditavel,
  exigirTransicao,
  validadeSugerida,
} from '@/lib/domain/orcamento'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { hojeDaClinica, itensDoPlano } from './consultas'

/**
 * Ações de orçamento.
 *
 * ── O congelamento acontece AQUI ────────────────────────────────────────────
 * `gerarOrcamento` **copia** descrição, detalhe e valor de cada item do plano
 * para `orcamento_item`. Não referencia e não recalcula. Se a tabela de preços
 * subir amanhã, ou se o dentista trocar as faces do item, o documento que o
 * paciente recebeu continua dizendo o mesmo.
 *
 * O `item_plano_id` fica guardado apenas para rastreabilidade, e é `set null` se
 * o item desaparecer — o documento não perde sentido por isso.
 *
 * O banco reforça: drizzle/0004_orcamento_congelado.sql impede alteração depois
 * de enviado, e exige que a soma das linhas seja exatamente o valor bruto.
 */

export type ResultadoOrcamento =
  | { ok: true; orcamentoId: string; numero?: number }
  | { ok: false; mensagem: string; campo?: string }

export async function gerarOrcamento({
  pacienteId,
  planoId,
  itemIds,
  desconto,
  diasValidade,
  observacao,
}: {
  pacienteId: string
  planoId: string
  /** Quais itens do plano entram. Orçamento parcial é comum: fase a fase. */
  itemIds: readonly string[]
  desconto?: Desconto | undefined
  diasValidade?: number | undefined
  observacao?: string | undefined
}): Promise<ResultadoOrcamento> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('orcamento', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (itemIds.length === 0) {
    return { ok: false, mensagem: 'Selecione ao menos um item do plano.', campo: 'itens' }
  }

  const itensDoBanco = await itensDoPlano(planoId)
  const selecionados = itensDoBanco.filter((i) => itemIds.includes(i.id))

  if (selecionados.length !== itemIds.length) {
    return {
      ok: false,
      mensagem: 'Algum item selecionado não está mais no plano. Recarregue a página.',
    }
  }

  // As linhas do documento: valor é o que o PACIENTE paga, não o valor cheio.
  const linhas: LinhaOrcamento[] = selecionados.map((i) => ({
    descricao: i.descricao,
    quantidade: 1,
    valorUnitario: i.valorPaciente,
  }))

  let totais: ReturnType<typeof calcularTotais>
  try {
    totais = calcularTotais(linhas, desconto)
  } catch (e) {
    return {
      ok: false,
      mensagem: e instanceof ErroDominio ? e.message : 'Desconto inválido.',
      campo: 'desconto',
    }
  }

  const hoje = await hojeDaClinica()
  let validadeAte: string
  try {
    validadeAte = validadeSugerida(hoje, diasValidade)
  } catch (e) {
    return {
      ok: false,
      mensagem: e instanceof ErroDominio ? e.message : 'Validade inválida.',
      campo: 'diasValidade',
    }
  }

  try {
    const resultado = await db.transaction(async (tx) => {
      const [criado] = await tx
        .insert(orcamento)
        .values({
          // `numero` vem da sequência criada em drizzle/0001; não passar aqui.
          pacienteId,
          planoId,
          status: 'rascunho',
          validadeAte,
          valorBruto: totais.valorBruto,
          desconto: totais.desconto,
          valorTotal: totais.valorTotal,
          observacao: observacao ?? null,
          criadoPorId: ator.usuarioId,
        })
        .returning({ id: orcamento.id, numero: orcamento.numero })

      if (!criado) throw new Error('Não foi possível criar o orçamento.')

      await tx.insert(orcamentoItem).values(
        selecionados.map((i, indice) => ({
          orcamentoId: criado.id,
          itemPlanoId: i.id,
          // CÓPIA, não referência: é isto que congela o documento.
          descricao: i.descricao,
          detalhe: i.detalhe,
          quantidade: 1,
          valorUnitario: i.valorPaciente,
          ordem: indice,
        })),
      )

      return criado
    })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'orcamento',
      entidadeId: resultado.id,
      pacienteId,
      detalhes: { numero: resultado.numero, linhas: linhas.length, total: totais.valorTotal },
    })

    revalidatePath(`/pacientes/${pacienteId}/plano`)
    return { ok: true, orcamentoId: resultado.id, numero: resultado.numero }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/** Muda o status. O banco impede alterar conteúdo depois de enviado. */
export async function mudarStatusOrcamento(
  id: string,
  para: StatusOrcamento,
): Promise<ResultadoOrcamento> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('orcamento', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const [atual] = await db
    .select({
      status: orcamento.status,
      numero: orcamento.numero,
      pacienteId: orcamento.pacienteId,
      planoId: orcamento.planoId,
    })
    .from(orcamento)
    .where(eq(orcamento.id, id))
    .limit(1)

  if (!atual) return { ok: false, mensagem: 'Orçamento não encontrado.' }

  try {
    exigirTransicao(atual.status, para)
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : 'Transição inválida.' }
  }

  const agora = new Date()

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(orcamento)
        .set({
          status: para,
          ...(para === 'enviado' ? { enviadoEm: agora } : {}),
          ...(para === 'aprovado' || para === 'recusado' ? { decididoEm: agora } : {}),
        })
        .where(eq(orcamento.id, id))

      /*
       * A CASCATA — o elo clínico↔financeiro da fase.
       *
       * Aprovar o orçamento aprova os itens do plano que ele contém. Sem isso, o
       * dentista teria que aprovar duas vezes: no documento e item por item, e
       * as duas listas divergiriam na primeira distração.
       *
       * Só itens em `proposto` mudam: o que já foi executado não volta atrás.
       */
      if (para === 'aprovado') {
        const linhas = await tx
          .select({ itemPlanoId: orcamentoItem.itemPlanoId })
          .from(orcamentoItem)
          .where(eq(orcamentoItem.orcamentoId, id))

        const ids = linhas.map((l) => l.itemPlanoId).filter((v): v is string => v !== null)

        if (ids.length > 0) {
          await tx
            .update(itemPlano)
            .set({ status: 'aprovado', aprovadoEm: agora })
            .where(and(inArray(itemPlano.id, ids), eq(itemPlano.status, 'proposto')))
        }
      }

      /*
       * Recusar NÃO recusa os itens do plano. O paciente pode ter recusado só o
       * preço ou o parcelamento — o plano clínico continua válido, e um novo
       * orçamento pode ser gerado dos mesmos itens.
       */
    })

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'orcamento',
      entidadeId: id,
      pacienteId: atual.pacienteId,
      detalhes: { numero: atual.numero, de: atual.status, para },
    })

    revalidatePath(`/orcamentos/${id}`)
    revalidatePath(`/pacientes/${atual.pacienteId}/plano`)
    revalidatePath(`/pacientes/${atual.pacienteId}/odontograma`)
    return { ok: true, orcamentoId: id, numero: atual.numero }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/** Exclui rascunho. Enviado não se exclui — o banco também impede. */
export async function excluirRascunho(id: string): Promise<ResultadoOrcamento> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('orcamento', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const [atual] = await db
    .select({ status: orcamento.status, numero: orcamento.numero, pacienteId: orcamento.pacienteId })
    .from(orcamento)
    .where(eq(orcamento.id, id))
    .limit(1)

  if (!atual) return { ok: false, mensagem: 'Orçamento não encontrado.' }

  if (!ehEditavel(atual.status)) {
    return {
      ok: false,
      mensagem: `Orçamento ${atual.numero} já foi enviado ao paciente e não pode ser excluído.`,
    }
  }

  await db.delete(orcamento).where(eq(orcamento.id, id))

  await registrar({
    ator,
    acao: 'exclusao',
    entidade: 'orcamento',
    entidadeId: id,
    pacienteId: atual.pacienteId,
    detalhes: { numero: atual.numero },
  })

  revalidatePath(`/pacientes/${atual.pacienteId}/plano`)
  return { ok: true, orcamentoId: id }
}

// ── Plano de tratamento ──────────────────────────────────────────────────────

export async function atualizarPlano({
  planoId,
  titulo,
  diagnostico,
  observacao,
}: {
  planoId: string
  titulo: string
  diagnostico?: string | undefined
  observacao?: string | undefined
}): Promise<{ ok: boolean; mensagem?: string }> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('plano_tratamento', 'editar')
  } catch (e) {
    const r = respostaDeAcesso(e)
    return { ok: false, mensagem: r.ok ? undefined : r.mensagem }
  }

  if (titulo.trim().length < 3) {
    return { ok: false, mensagem: 'O título do plano precisa de ao menos 3 caracteres.' }
  }

  const [plano] = await db
    .select({ pacienteId: planoTratamento.pacienteId })
    .from(planoTratamento)
    .where(eq(planoTratamento.id, planoId))
    .limit(1)

  if (!plano) return { ok: false, mensagem: 'Plano não encontrado.' }

  await db
    .update(planoTratamento)
    .set({
      titulo: titulo.trim(),
      diagnostico: diagnostico?.trim() || null,
      observacao: observacao?.trim() || null,
    })
    .where(eq(planoTratamento.id, planoId))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'plano_tratamento',
    entidadeId: planoId,
    pacienteId: plano.pacienteId,
    detalhes: { campos: ['titulo', 'diagnostico', 'observacao'] },
  })

  revalidatePath(`/pacientes/${plano.pacienteId}/plano`)
  return { ok: true }
}

/**
 * Ajusta o valor de um item do plano.
 *
 * Permitido porque o dentista negocia: "esse eu faço por 250". Só afeta
 * orçamentos FUTUROS — os já enviados estão congelados no banco.
 */
export async function ajustarValorItem(
  itemId: string,
  valor: string,
): Promise<{ ok: boolean; mensagem?: string }> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('plano_tratamento', 'editar')
  } catch (e) {
    const r = respostaDeAcesso(e)
    return { ok: false, mensagem: r.ok ? undefined : r.mensagem }
  }

  if (!/^\d{1,8}(\.\d{1,2})?$/.test(valor)) {
    return { ok: false, mensagem: 'Valor inválido. Use o formato 1234.56.' }
  }

  const [item] = await db
    .select({ status: itemPlano.status, planoId: itemPlano.planoId, cobertura: itemPlano.cobertura })
    .from(itemPlano)
    .where(eq(itemPlano.id, itemId))
    .limit(1)

  if (!item) return { ok: false, mensagem: 'Item não encontrado.' }

  // Item já faturado tem cobrança atrelada; mexer no valor descasaria o caixa.
  if (['faturado', 'recebido', 'glosado'].includes(item.status)) {
    return { ok: false, mensagem: `Item em "${item.status}" já foi para o financeiro.` }
  }

  const [plano] = await db
    .select({ pacienteId: planoTratamento.pacienteId })
    .from(planoTratamento)
    .where(eq(planoTratamento.id, item.planoId))
    .limit(1)

  await db
    .update(itemPlano)
    .set({
      valor,
      // No particular a coparticipação não existe; no convênio ela é o que o
      // paciente paga e acompanha o ajuste.
      ...(item.cobertura === 'particular' ? {} : { valorCoparticipacao: valor }),
    })
    .where(eq(itemPlano.id, itemId))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'item_plano',
    entidadeId: itemId,
    pacienteId: plano?.pacienteId ?? null,
    detalhes: { campo: 'valor' },
  })

  if (plano) revalidatePath(`/pacientes/${plano.pacienteId}/plano`)
  return { ok: true }
}

/** Reordena os itens — a ordem do plano é a ordem clínica do tratamento. */
export async function reordenarItens(
  planoId: string,
  idsNaOrdem: readonly string[],
): Promise<{ ok: boolean; mensagem?: string }> {
  try {
    await exigirPermissao('plano_tratamento', 'editar')
  } catch (e) {
    const r = respostaDeAcesso(e)
    return { ok: false, mensagem: r.ok ? undefined : r.mensagem }
  }

  await db.transaction(async (tx) => {
    for (const [indice, id] of idsNaOrdem.entries()) {
      await tx
        .update(itemPlano)
        .set({ ordem: indice })
        .where(and(eq(itemPlano.id, id), eq(itemPlano.planoId, planoId)))
    }
  })

  const [plano] = await db
    .select({ pacienteId: planoTratamento.pacienteId })
    .from(planoTratamento)
    .where(eq(planoTratamento.id, planoId))
    .limit(1)

  if (plano) revalidatePath(`/pacientes/${plano.pacienteId}/plano`)
  return { ok: true }
}

// ── Tradução de erros ────────────────────────────────────────────────────────

function respostaDeAcesso(e: unknown): ResultadoOrcamento {
  if (e instanceof SemSessao) return { ok: false, mensagem: 'Sua sessão expirou. Entre novamente.' }
  if (e instanceof SemPermissao) return { ok: false, mensagem: 'Seu perfil não permite esta ação.' }
  throw e
}

function respostaDeBanco(e: unknown): ResultadoOrcamento {
  if (e instanceof ErroDominio) return { ok: false, mensagem: e.message }

  const texto = e instanceof Error ? e.message : String(e)

  // Mensagens dos triggers de drizzle/0004_orcamento_congelado.sql.
  if (texto.includes('ja foi enviado ao paciente')) {
    return {
      ok: false,
      mensagem:
        'Este orçamento já foi enviado ao paciente e seu conteúdo é imutável. Gere um novo orçamento.',
    }
  }
  if (texto.includes('linhas de um orcamento enviado')) {
    return { ok: false, mensagem: 'As linhas de um orçamento enviado não podem ser alteradas.' }
  }
  if (texto.includes('ja foi enviado e nao pode ser excluido')) {
    return { ok: false, mensagem: 'Orçamento enviado não pode ser excluído.' }
  }
  if (texto.includes('soma das linhas')) {
    return {
      ok: false,
      mensagem: 'Os valores não fecham. Recarregue a página e tente novamente.',
    }
  }
  if (texto.includes('nao pode ser enviado sem nenhuma linha')) {
    return { ok: false, mensagem: 'Um orçamento sem itens não pode ser enviado.' }
  }
  if (texto.includes('orcamento_total_nao_negativo')) {
    return { ok: false, mensagem: 'O desconto não pode ser maior que o valor total.', campo: 'desconto' }
  }
  if (texto.includes('orcamento_numero')) {
    return { ok: false, mensagem: 'Conflito de numeração. Tente novamente.' }
  }

  console.error('[orcamento] erro inesperado', texto)
  return { ok: false, mensagem: 'Não foi possível salvar. Tente novamente.' }
}
