import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  execucao,
  insumoProcedimento,
  itemPlano,
  loteMaterial,
  material,
  movimentoEstoque,
  paciente,
  planoTratamento,
  procedimento,
} from '@/lib/db/schema'
import { type LoteDisponivel, planejarBaixaFefo } from '@/lib/domain/estoque'
import { deMilesimos, formatarQuantidade, paraMilesimos } from '@/lib/domain/quantidade'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { and, asc, eq, gt, sql } from 'drizzle-orm'

/**
 * Baixa de estoque a partir de uma execução. **Núcleo, sem `'use server'`.**
 *
 * É o elo que fazia falta: a ficha técnica existia, o FEFO existia, a
 * rastreabilidade existia — e nenhuma tela passava o `execucaoId`. Sem ele, a
 * baixa dependia de alguém abrir a tela de estoque depois do atendimento e
 * lembrar do que usou. Ninguém lembra, e é assim que controle de estoque morre no
 * segundo mês.
 *
 * ── Propõe, não executa ─────────────────────────────────────────────────────
 * O sistema monta a proposta (ficha técnica + lote FEFO) e **uma pessoa
 * confirma**. Se baixasse sozinho, a rastreabilidade afirmaria um lote que talvez
 * não tenha sido o usado — e rastreabilidade que mente é pior que nenhuma.
 * A pessoa pode ajustar quantidade, remover item e trocar de lote.
 *
 * ── Idempotência ────────────────────────────────────────────────────────────
 * Duplo clique não baixa duas vezes. A confirmação abre transação, **travam a
 * linha da execução** (`FOR UPDATE`) e só então verifica se já existe consumo
 * ligado a ela. Sem o lock, duas requisições simultâneas passariam as duas pela
 * verificação — e o estoque sairia com o dobro do consumo, sem nada indicando o
 * motivo.
 */

export type ResultadoBaixa =
  | { readonly ok: true; readonly mensagem: string; readonly movimentos?: number }
  | { readonly ok: false; readonly mensagem: string }

export interface ItemProposto {
  readonly materialId: string
  readonly codigo: string
  readonly nome: string
  readonly unidade: string
  readonly controlado: boolean
  /** Quantidade da ficha técnica. */
  readonly quantidade: string
  readonly saldoTotal: string
  /** Alocação FEFO: de quais lotes sairia, e quanto de cada. */
  readonly alocacoes: readonly { readonly loteId: string; readonly codigoFabricante: string | null; readonly validade: string | null; readonly quantidade: string }[]
  readonly faltante: string
  readonly atende: boolean
  /** Lotes vencidos com saldo, ignorados pelo FEFO. A tela avisa em vez de sumir. */
  readonly vencidosIgnorados: number
}

export interface PropostaDeBaixa {
  readonly execucaoId: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly procedimentoNome: string
  readonly denteFdi: number | null
  /** `true` quando já existe consumo lançado para esta execução. */
  readonly jaLancada: boolean
  readonly itens: readonly ItemProposto[]
  readonly temFalta: boolean
}

/**
 * Monta a proposta de consumo de uma execução.
 *
 * Devolve `null` quando o procedimento não tem ficha técnica: aí não há o que
 * propor, e a tela simplesmente não mostra o painel. Silêncio aqui é correto —
 * insistir com um painel vazio treinaria a pessoa a ignorá-lo.
 */
export async function proporBaixaComAtor(
  _ator: Ator,
  execucaoId: string,
): Promise<PropostaDeBaixa | null> {
  const hoje = await hojeDaClinica()

  const [contexto] = await db
    .select({
      execucaoId: execucao.id,
      procedimentoId: itemPlano.procedimentoId,
      procedimentoNome: procedimento.nome,
      denteFdi: itemPlano.denteFdi,
      pacienteId: planoTratamento.pacienteId,
      pacienteNome: paciente.nome,
    })
    .from(execucao)
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .where(eq(execucao.id, execucaoId))
    .limit(1)

  if (!contexto) return null

  const ficha = await db
    .select({
      materialId: material.id,
      codigo: material.codigo,
      nome: material.nome,
      unidade: material.unidade,
      controlado: material.controlado,
      quantidade: insumoProcedimento.quantidade,
    })
    .from(insumoProcedimento)
    .innerJoin(material, eq(material.id, insumoProcedimento.materialId))
    .where(
      and(
        eq(insumoProcedimento.procedimentoId, contexto.procedimentoId),
        eq(material.ativo, true),
      ),
    )
    .orderBy(asc(material.nome))

  if (ficha.length === 0) return null

  const [jaExiste] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(movimentoEstoque)
    .where(and(eq(movimentoEstoque.execucaoId, execucaoId), eq(movimentoEstoque.tipo, 'consumo')))

  const itens: ItemProposto[] = []

  for (const insumo of ficha) {
    const lotes = await db
      .select({
        id: loteMaterial.id,
        saldo: loteMaterial.saldo,
        validade: loteMaterial.validade,
        recebidoEm: loteMaterial.recebidoEm,
        custoUnitario: loteMaterial.custoUnitario,
        codigoFabricante: loteMaterial.codigoFabricante,
      })
      .from(loteMaterial)
      .where(and(eq(loteMaterial.materialId, insumo.materialId), gt(loteMaterial.saldo, '0')))

    const plano = planejarBaixaFefo(lotes as readonly LoteDisponivel[], insumo.quantidade, hoje)
    const porId = new Map(lotes.map((l) => [l.id, l]))

    itens.push({
      ...insumo,
      saldoTotal: deMilesimos(lotes.reduce((acc, l) => acc + paraMilesimos(l.saldo), 0)),
      alocacoes: plano.alocacoes.map((a) => ({
        loteId: a.loteId,
        codigoFabricante: porId.get(a.loteId)?.codigoFabricante ?? null,
        validade: porId.get(a.loteId)?.validade ?? null,
        quantidade: a.quantidade,
      })),
      faltante: plano.faltante,
      atende: plano.atende,
      vencidosIgnorados: plano.vencidosIgnorados.length,
    })
  }

  return {
    execucaoId,
    pacienteId: contexto.pacienteId,
    pacienteNome: contexto.pacienteNome,
    procedimentoNome: contexto.procedimentoNome,
    denteFdi: contexto.denteFdi,
    jaLancada: (jaExiste?.n ?? 0) > 0,
    itens,
    temFalta: itens.some((i) => !i.atende),
  }
}

export interface ItemConfirmado {
  readonly materialId: string
  readonly quantidade: string
  /** Lote escolhido a dedo. Sem isto, o FEFO decide na hora da gravação. */
  readonly loteId?: string
}

/**
 * Confirma o consumo, criando um movimento por lote.
 *
 * O que **não** acontece aqui: falhar por falta de saldo de um material não
 * impede o resto. Estoque incompleto é a situação normal de uma clínica (a luva
 * acabou e ninguém lançou a entrada), e recusar a baixa inteira faria a pessoa
 * desistir de lançar qualquer coisa. Os que dão são gravados; o que faltou volta
 * na mensagem, nominalmente.
 */
export async function confirmarBaixaComAtor(
  ator: Ator,
  execucaoId: string,
  itens: readonly ItemConfirmado[],
): Promise<ResultadoBaixa> {
  if (itens.length === 0) {
    return { ok: false, mensagem: 'Nada a lançar: nenhum insumo foi marcado.' }
  }

  const hoje = await hojeDaClinica()

  const [contexto] = await db
    .select({
      profissionalId: execucao.profissionalId,
      pacienteId: planoTratamento.pacienteId,
      procedimentoNome: procedimento.nome,
    })
    .from(execucao)
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .where(eq(execucao.id, execucaoId))
    .limit(1)

  if (!contexto) return { ok: false, mensagem: 'Execução não encontrada.' }

  const naoAtendidos: string[] = []
  let movimentos = 0

  try {
    await db.transaction(async (tx) => {
      /**
       * Trava a execução antes de verificar. Sem o `FOR UPDATE`, dois cliques
       * simultâneos passariam os dois pela checagem de "já lançada" e o consumo
       * sairia dobrado — com dois conjuntos de movimentos idênticos no livro e
       * nada explicando o motivo.
       */
      await tx.execute(sql`select id from execucao where id = ${execucaoId} for update`)

      const [ja] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(movimentoEstoque)
        .where(
          and(eq(movimentoEstoque.execucaoId, execucaoId), eq(movimentoEstoque.tipo, 'consumo')),
        )
      if ((ja?.n ?? 0) > 0) {
        throw new BaixaJaLancada()
      }

      for (const item of itens) {
        const [m] = await tx
          .select({
            id: material.id,
            nome: material.nome,
            unidade: material.unidade,
            controlado: material.controlado,
          })
          .from(material)
          .where(eq(material.id, item.materialId))
          .limit(1)
        if (!m) continue

        const lotes = await tx
          .select({
            id: loteMaterial.id,
            saldo: loteMaterial.saldo,
            validade: loteMaterial.validade,
            recebidoEm: loteMaterial.recebidoEm,
            custoUnitario: loteMaterial.custoUnitario,
          })
          .from(loteMaterial)
          .where(
            item.loteId
              ? and(eq(loteMaterial.id, item.loteId), gt(loteMaterial.saldo, '0'))
              : and(eq(loteMaterial.materialId, item.materialId), gt(loteMaterial.saldo, '0')),
          )

        const plano = planejarBaixaFefo(lotes as readonly LoteDisponivel[], item.quantidade, hoje)

        if (plano.alocacoes.length === 0) {
          naoAtendidos.push(`${m.nome} (sem saldo)`)
          continue
        }
        if (!plano.atende) {
          naoAtendidos.push(
            `${m.nome} (faltaram ${formatarQuantidade(plano.faltante, m.unidade)})`,
          )
        }

        const custoPorLote = new Map(lotes.map((l) => [l.id, l.custoUnitario]))

        for (const a of plano.alocacoes) {
          await tx.insert(movimentoEstoque).values({
            loteId: a.loteId,
            materialId: item.materialId,
            tipo: 'consumo',
            quantidade: deMilesimos(-paraMilesimos(a.quantidade)),
            custoUnitario: custoPorLote.get(a.loteId) ?? null,
            execucaoId,
            profissionalId: contexto.profissionalId,
            registradoPorId: ator.usuarioId,
            // Material controlado exige motivo (Portaria 344/98). O procedimento
            // e o paciente são o motivo, e ficam explícitos no livro.
            motivo: m.controlado
              ? `${contexto.procedimentoNome} — execução ${execucaoId.slice(0, 8)}`
              : null,
          })
          movimentos++
        }
      }
    })
  } catch (e) {
    if (e instanceof BaixaJaLancada) {
      return {
        ok: false,
        mensagem:
          'O consumo desta execução já foi lançado. Para corrigir, ajuste o lote na tela de estoque — o livro é append-only.',
      }
    }
    return { ok: false, mensagem: traduzir(e) }
  }

  // Consumo ligado a execução toca dado de paciente: a auditoria precisa saber
  // de quem é o prontuário envolvido.
  await registrar({
    ator,
    acao: 'criacao',
    entidade: 'movimento_estoque',
    entidadeId: execucaoId,
    pacienteId: contexto.pacienteId,
    detalhes: {
      origem: 'execucao',
      movimentos,
      itens: itens.length,
      naoAtendidos: naoAtendidos.length,
    },
  })

  const base = `Consumo lançado: ${movimentos} movimento(s) em ${itens.length} material(is).`
  return {
    ok: true,
    movimentos,
    mensagem:
      naoAtendidos.length === 0
        ? base
        : `${base} Sem saldo suficiente para: ${naoAtendidos.join('; ')}. Lance a entrada e ajuste depois.`,
  }
}

class BaixaJaLancada extends Error {}

// ── Fila de consumo pendente ──────────────────────────────────────────────────

export interface ExecucaoSemBaixa {
  readonly execucaoId: string
  readonly executadoEm: Date
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly procedimentoNome: string
  readonly denteFdi: number | null
  readonly profissionalNome: string | null
  readonly insumos: number
}

/**
 * Execuções com ficha técnica e **sem consumo lançado**.
 *
 * É a rede de segurança do fluxo de um clique: quem fechou a tela sem confirmar
 * não perde o lançamento — ele aparece nesta fila. Sem ela, a baixa esquecida
 * viraria diferença na contagem do mês seguinte, sem rastro de onde saiu.
 *
 * Ordena pela mais antiga: o consumo esquecido há duas semanas é o que mais
 * distorce o saldo.
 */
export async function execucoesSemBaixa(limite = 50): Promise<readonly ExecucaoSemBaixa[]> {
  return db
    .select({
      execucaoId: execucao.id,
      executadoEm: execucao.executadoEm,
      pacienteId: planoTratamento.pacienteId,
      pacienteNome: paciente.nome,
      procedimentoNome: procedimento.nome,
      denteFdi: itemPlano.denteFdi,
      profissionalNome: sql<string | null>`(
        select u.nome from usuario u
          join profissional pr on pr.usuario_id = u.id
         where pr.id = "execucao"."profissional_id"
      )`,
      insumos: sql<number>`(
        select count(*)::int from insumo_procedimento i
         where i."procedimento_id" = "item_plano"."procedimento_id"
      )`,
    })
    .from(execucao)
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .where(
      sql`
        exists (
          select 1 from insumo_procedimento i
           where i."procedimento_id" = "item_plano"."procedimento_id"
        )
        and not exists (
          select 1 from movimento_estoque m
           where m."execucao_id" = "execucao"."id" and m."tipo" = 'consumo'
        )
      `,
    )
    .orderBy(asc(execucao.executadoEm))
    .limit(limite)
}

function traduzir(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  for (let i = 0; i < 5 && atual instanceof Error; i++) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  const bruto = partes.join(' | ')
  if (bruto.includes('Saldo insuficiente')) {
    return 'Saldo insuficiente em um dos lotes. Confira o estoque e lance a entrada que falta.'
  }
  if (bruto.includes('venceu em')) {
    return 'Um dos lotes escolhidos está vencido. Lote vencido só pode ser descartado.'
  }
  if (bruto.includes('Material controlado')) {
    return 'Material de controle especial exige profissional responsável na execução.'
  }
  return 'Não foi possível lançar o consumo. Confira os dados e tente de novo.'
}
