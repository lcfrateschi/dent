'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { cobranca, orcamento, pagamento, parcela } from '@/lib/db/schema'
import { exigirPagamentoCabe } from '@/lib/domain/cobranca'
import { ErroDominio } from '@/lib/domain/erros'
import { gerarParcelas, somaConfere } from '@/lib/domain/parcelamento'
import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

/**
 * Ações do financeiro.
 *
 * O parcelamento vem de `lib/domain/parcelamento.ts`, escrito e testado na
 * Fase 1: a soma das parcelas é exatamente o total e a sobra do arredondamento
 * vai na primeira. A mesma invariante é imposta por trigger deferido no banco —
 * se as duas discordarem, o COMMIT falha.
 */

export type ResultadoFinanceiro =
  | { ok: true; id: string; mensagem?: string }
  | { ok: false; mensagem: string; campo?: string }

/**
 * Fatura um orçamento aprovado.
 *
 * O valor vem do ORÇAMENTO, não é recalculado: o documento foi congelado na
 * emissão e é isso que o paciente aceitou. Recalcular aqui abriria a porta para
 * cobrar diferente do que foi assinado.
 */
export async function faturarOrcamento({
  orcamentoId,
  forma,
  quantidade,
  primeiroVencimento,
  intervaloMeses,
  observacao,
}: {
  orcamentoId: string
  forma: 'dinheiro' | 'pix' | 'debito' | 'credito' | 'boleto' | 'transferencia' | 'convenio'
  quantidade: number
  primeiroVencimento: string
  intervaloMeses?: number | undefined
  observacao?: string | undefined
}): Promise<ResultadoFinanceiro> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('cobranca', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const [orc] = await db
    .select({
      id: orcamento.id,
      numero: orcamento.numero,
      pacienteId: orcamento.pacienteId,
      status: orcamento.status,
      valorTotal: orcamento.valorTotal,
    })
    .from(orcamento)
    .where(eq(orcamento.id, orcamentoId))
    .limit(1)

  if (!orc) return { ok: false, mensagem: 'Orçamento não encontrado.' }

  if (orc.status !== 'aprovado') {
    return {
      ok: false,
      mensagem: `Orçamento ${orc.numero} está em "${orc.status}". Só orçamento aprovado gera cobrança.`,
    }
  }
  if (Number(orc.valorTotal) <= 0) {
    return { ok: false, mensagem: 'Orçamento com valor zero não gera cobrança.' }
  }

  let parcelas: ReturnType<typeof gerarParcelas>
  try {
    parcelas = gerarParcelas({
      total: orc.valorTotal,
      quantidade,
      primeiroVencimento,
      intervaloMeses,
    })
  } catch (e) {
    return {
      ok: false,
      mensagem: e instanceof ErroDominio ? e.message : 'Parcelamento inválido.',
      campo: e instanceof ErroDominio && e.codigo.includes('PARCELA') ? 'quantidade' : 'primeiroVencimento',
    }
  }

  // Confere em memória a mesma invariante que o trigger checa no COMMIT.
  if (!somaConfere(orc.valorTotal, parcelas)) {
    return { ok: false, mensagem: 'As parcelas não somam o total. Não deveria acontecer — avise o suporte.' }
  }

  try {
    const id = await db.transaction(async (tx) => {
      const [criada] = await tx
        .insert(cobranca)
        .values({
          pacienteId: orc.pacienteId,
          orcamentoId: orc.id,
          valorTotal: orc.valorTotal,
          forma,
          qtdParcelas: parcelas.length,
          observacao: observacao ?? null,
          criadoPorId: ator.usuarioId,
        })
        .returning({ id: cobranca.id })

      if (!criada) throw new Error('Não foi possível criar a cobrança.')

      await tx.insert(parcela).values(
        parcelas.map((p) => ({
          cobrancaId: criada.id,
          numero: p.numero,
          vencimento: p.vencimento,
          valor: p.valor,
        })),
      )

      return criada.id
    })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'cobranca',
      entidadeId: id,
      pacienteId: orc.pacienteId,
      detalhes: {
        orcamentoNumero: orc.numero,
        total: orc.valorTotal,
        parcelas: parcelas.length,
        forma,
      },
    })

    revalidatePath('/financeiro')
    revalidatePath(`/pacientes/${orc.pacienteId}/plano`)
    return {
      ok: true,
      id,
      mensagem: `Cobrança criada: ${parcelas.length}× ${parcelas[0]?.valor ?? ''}, primeira em ${parcelas[0]?.vencimento ?? ''}.`,
    }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/** Baixa de pagamento numa parcela. */
export async function registrarPagamento({
  parcelaId,
  valor,
  pagoEm,
  meio,
  conciliado,
  comprovante,
  observacao,
}: {
  parcelaId: string
  valor: string
  pagoEm: string
  meio: 'dinheiro' | 'pix' | 'debito' | 'credito' | 'boleto' | 'transferencia' | 'convenio'
  /** Dinheiro e PIX entram já conciliados; cheque e boleto esperam o extrato. */
  conciliado: boolean
  comprovante?: string | undefined
  observacao?: string | undefined
}): Promise<ResultadoFinanceiro> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('pagamento', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const contexto = await contextoDaParcela(parcelaId)
  if (!contexto) return { ok: false, mensagem: 'Parcela não encontrada.' }
  if (contexto.canceladoEm) return { ok: false, mensagem: 'Esta cobrança foi cancelada.' }

  try {
    // Mensagem boa antes; o trigger `pagamento_nao_excede_parcela` é a autoridade.
    exigirPagamentoCabe(contexto.parcela, valor)
  } catch (e) {
    return {
      ok: false,
      mensagem: e instanceof ErroDominio ? e.message : 'Valor inválido.',
      campo: 'valor',
    }
  }

  try {
    const [criado] = await db
      .insert(pagamento)
      .values({
        parcelaId,
        valor,
        pagoEm,
        meio,
        conciliado,
        // O CHECK `pagamento_conciliacao_coerente` exige os dois juntos.
        conciliadoEm: conciliado ? new Date() : null,
        comprovante: comprovante ?? null,
        observacao: observacao ?? null,
        registradoPorId: ator.usuarioId,
      })
      .returning({ id: pagamento.id })

    if (!criado) return { ok: false, mensagem: 'Não foi possível registrar.' }

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'pagamento',
      entidadeId: criado.id,
      pacienteId: contexto.pacienteId,
      detalhes: { valor, meio, conciliado, parcela: contexto.parcela.numero },
    })

    revalidatePath('/financeiro')
    revalidatePath(`/financeiro/cobrancas/${contexto.cobrancaId}`)
    return { ok: true, id: criado.id, mensagem: `Pagamento de ${valor} registrado.` }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/**
 * Conciliação: confere o pagamento contra o extrato.
 *
 * É o que libera a comissão. Antes disso o dinheiro está lançado mas não
 * confirmado, e pagar comissão sobre ele seria adiantamento.
 */
export async function conciliarPagamento(
  pagamentoId: string,
  conciliado: boolean,
): Promise<ResultadoFinanceiro> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('pagamento', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const [pag] = await db
    .select({ id: pagamento.id, estornadoEm: pagamento.estornadoEm, parcelaId: pagamento.parcelaId })
    .from(pagamento)
    .where(eq(pagamento.id, pagamentoId))
    .limit(1)

  if (!pag) return { ok: false, mensagem: 'Pagamento não encontrado.' }
  if (pag.estornadoEm) {
    return { ok: false, mensagem: 'Pagamento estornado não pode ser conciliado.' }
  }

  const contexto = await contextoDaParcela(pag.parcelaId)

  await db
    .update(pagamento)
    .set({ conciliado, conciliadoEm: conciliado ? new Date() : null })
    .where(eq(pagamento.id, pagamentoId))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'pagamento',
    entidadeId: pagamentoId,
    pacienteId: contexto?.pacienteId ?? null,
    detalhes: { campo: 'conciliado', valor: conciliado },
  })

  revalidatePath('/financeiro')
  if (contexto) revalidatePath(`/financeiro/cobrancas/${contexto.cobrancaId}`)
  return { ok: true, id: pagamentoId }
}

/**
 * Estorna um pagamento. **Não exclui** — o banco recusa DELETE em pagamento.
 *
 * O trigger recalcula `parcela.status` sozinho: uma parcela quitada volta a
 * `parcial` ou `aberta` conforme o que sobrou.
 */
export async function estornarPagamento(
  pagamentoId: string,
  motivo: string,
): Promise<ResultadoFinanceiro> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('pagamento', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (motivo.trim().length < 3) {
    return { ok: false, mensagem: 'Informe o motivo do estorno.', campo: 'motivo' }
  }

  const [pag] = await db
    .select({ id: pagamento.id, estornadoEm: pagamento.estornadoEm, parcelaId: pagamento.parcelaId, valor: pagamento.valor })
    .from(pagamento)
    .where(eq(pagamento.id, pagamentoId))
    .limit(1)

  if (!pag) return { ok: false, mensagem: 'Pagamento não encontrado.' }
  if (pag.estornadoEm) return { ok: false, mensagem: 'Este pagamento já foi estornado.' }

  const contexto = await contextoDaParcela(pag.parcelaId)

  try {
    await db
      .update(pagamento)
      .set({ estornadoEm: new Date(), motivoEstorno: motivo.trim() })
      .where(eq(pagamento.id, pagamentoId))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'pagamento',
      entidadeId: pagamentoId,
      pacienteId: contexto?.pacienteId ?? null,
      // O motivo VAI para a trilha: estorno sem justificativa registrada é o que
      // uma auditoria financeira procura primeiro.
      detalhes: { tipo: 'estorno', valor: pag.valor, motivo: motivo.trim() },
    })

    revalidatePath('/financeiro')
    if (contexto) revalidatePath(`/financeiro/cobrancas/${contexto.cobrancaId}`)
    return { ok: true, id: pagamentoId, mensagem: 'Pagamento estornado.' }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/**
 * Cancela a cobrança. Não exclui: se houve pagamento, o banco recusa o DELETE, e
 * apagar recebimento apagaria a contabilidade.
 */
export async function cancelarCobranca(
  cobrancaId: string,
  motivo: string,
): Promise<ResultadoFinanceiro> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('cobranca', 'excluir')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  if (motivo.trim().length < 3) {
    return { ok: false, mensagem: 'Informe o motivo do cancelamento.', campo: 'motivo' }
  }

  const [cob] = await db
    .select({
      id: cobranca.id,
      pacienteId: cobranca.pacienteId,
      canceladoEm: cobranca.canceladoEm,
      observacao: cobranca.observacao,
    })
    .from(cobranca)
    .where(eq(cobranca.id, cobrancaId))
    .limit(1)

  if (!cob) return { ok: false, mensagem: 'Cobrança não encontrada.' }
  if (cob.canceladoEm) return { ok: false, mensagem: 'Esta cobrança já está cancelada.' }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(cobranca)
        .set({
          canceladoEm: new Date(),
          observacao: [cob.observacao, `Cancelada: ${motivo.trim()}`].filter(Boolean).join(' · '),
        })
        .where(eq(cobranca.id, cobrancaId))

      // Parcelas sem pagamento são canceladas; as com pagamento permanecem, para
      // o histórico do que entrou continuar coerente.
      await tx
        .update(parcela)
        .set({ status: 'cancelada' })
        .where(
          and(
            eq(parcela.cobrancaId, cobrancaId),
            eq(parcela.status, 'aberta'),
          ),
        )
    })

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'cobranca',
      entidadeId: cobrancaId,
      pacienteId: cob.pacienteId,
      detalhes: { tipo: 'cancelamento', motivo: motivo.trim() },
    })

    revalidatePath('/financeiro')
    revalidatePath(`/financeiro/cobrancas/${cobrancaId}`)
    return { ok: true, id: cobrancaId, mensagem: 'Cobrança cancelada.' }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

// ── Auxiliares ───────────────────────────────────────────────────────────────

async function contextoDaParcela(parcelaId: string): Promise<
  | {
      cobrancaId: string
      pacienteId: string
      canceladoEm: Date | null
      parcela: Parameters<typeof exigirPagamentoCabe>[0] & { numero: number }
    }
  | null
> {
  const [linha] = await db
    .select({
      cobrancaId: parcela.cobrancaId,
      pacienteId: cobranca.pacienteId,
      canceladoEm: cobranca.canceladoEm,
      numero: parcela.numero,
      valor: parcela.valor,
      vencimento: parcela.vencimento,
      status: parcela.status,
    })
    .from(parcela)
    .innerJoin(cobranca, eq(cobranca.id, parcela.cobrancaId))
    .where(eq(parcela.id, parcelaId))
    .limit(1)

  if (!linha) return null

  const pagamentos = await db
    .select({
      valor: pagamento.valor,
      estornadoEm: pagamento.estornadoEm,
      conciliado: pagamento.conciliado,
    })
    .from(pagamento)
    .where(eq(pagamento.parcelaId, parcelaId))

  return {
    cobrancaId: linha.cobrancaId,
    pacienteId: linha.pacienteId,
    canceladoEm: linha.canceladoEm,
    parcela: {
      numero: linha.numero,
      valor: linha.valor,
      vencimento: linha.vencimento,
      status: linha.status,
      pagamentos,
    },
  }
}

function respostaDeAcesso(e: unknown): ResultadoFinanceiro {
  if (e instanceof SemSessao) return { ok: false, mensagem: 'Sua sessão expirou. Entre novamente.' }
  if (e instanceof SemPermissao) {
    return { ok: false, mensagem: 'Seu perfil não permite esta ação no financeiro.' }
  }
  throw e
}

/** Traduz as mensagens dos triggers de drizzle/0001 e drizzle/0007. */
function respostaDeBanco(e: unknown): ResultadoFinanceiro {
  if (e instanceof ErroDominio) return { ok: false, mensagem: e.message }

  const texto = e instanceof Error ? e.message : String(e)

  if (texto.includes('cobranca_uma_por_orcamento')) {
    return { ok: false, mensagem: 'Este orçamento já tem uma cobrança. Cancele a existente antes de refazer.' }
  }
  if (texto.includes('so orcamento aprovado gera cobranca')) {
    return { ok: false, mensagem: 'Só orçamento aprovado gera cobrança.' }
  }
  if (texto.includes('soma das parcelas')) {
    return { ok: false, mensagem: 'As parcelas não somam o total da cobrança. Recarregue e tente de novo.' }
  }
  if (texto.includes('excedem o valor da parcela')) {
    return { ok: false, mensagem: 'O valor excede o saldo da parcela.', campo: 'valor' }
  }
  if (texto.includes('parcela cancelada')) {
    return { ok: false, mensagem: 'Não é possível receber numa parcela cancelada.' }
  }
  if (texto.includes('pagamento nao pode ser excluido')) {
    return { ok: false, mensagem: 'Pagamento não se exclui — registre um estorno com motivo.' }
  }
  if (texto.includes('nao pode ser excluida. Cancele')) {
    return { ok: false, mensagem: 'Cobrança com pagamento registrado não se exclui. Cancele em vez de excluir.' }
  }
  if (texto.includes('pagamento_estorno_justificado')) {
    return { ok: false, mensagem: 'Estorno exige informar o motivo.', campo: 'motivo' }
  }

  console.error('[financeiro] erro inesperado', texto)
  return { ok: false, mensagem: 'Não foi possível salvar. Tente novamente.' }
}

