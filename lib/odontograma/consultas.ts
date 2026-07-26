import { registrarLeitura } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { dentePaciente, execucao, itemPlano, planoTratamento, procedimento } from '@/lib/db/schema'
import type { Face } from '@/lib/domain/dentes'
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'

/**
 * Estado do odontograma montado a partir do banco.
 *
 * A tradução central da Fase 5: `item_plano` e `execucao` são o modelo
 * financeiro-clínico; `MarcacoesFace` é o modelo de desenho. Esta camada
 * converte um no outro, e é o único lugar onde as duas linguagens se encontram.
 *
 * Regra de precedência de face:
 *   executado  →  há `execucao` para o item
 *   planejado  →  item em proposto ou aprovado
 *   nada       →  item recusado ou cancelado
 *
 * Executado ganha de planejado no mesmo dente e face: se a restauração foi
 * feita, mostrar como "a fazer" seria erro clínico.
 */

export type EstadoFace = 'higido' | 'planejado' | 'executado'
export type EstadoDenteRegistrado = 'ausente' | 'coroa' | 'implante' | 'raiz_residual'

export type MarcacoesFace = Readonly<Record<number, Partial<Record<Face, EstadoFace>>>>
export type MarcacoesDente = Readonly<Record<number, EstadoDenteRegistrado>>

export interface ItemDoOdontograma {
  readonly id: string
  readonly planoId: string
  readonly denteFdi: number | null
  readonly faces: readonly Face[]
  readonly status: string
  readonly procedimentoNome: string
  readonly procedimentoId: string
  readonly valor: string
  readonly executado: boolean
  readonly executadoEm: Date | null
}

export interface EstadoOdontograma {
  readonly marcacoesFace: MarcacoesFace
  readonly marcacoesDente: MarcacoesDente
  /** Itens que alimentaram as marcações, para o painel lateral. */
  readonly itens: readonly ItemDoOdontograma[]
  readonly planoAtivoId: string | null
}

/** Status de item que ainda contam como intenção de tratamento. */
const STATUS_PLANEJADO = ['proposto', 'aprovado'] as const
/** Status que indicam trabalho feito e cobrável. */
const STATUS_FEITO = ['executado', 'faturado', 'recebido', 'glosado'] as const

export async function estadoDoOdontograma(
  ator: Ator,
  pacienteId: string,
): Promise<EstadoOdontograma> {
  const [linhas, estadosDente, plano] = await Promise.all([
    db
      .select({
        id: itemPlano.id,
        planoId: itemPlano.planoId,
        denteFdi: itemPlano.denteFdi,
        faces: itemPlano.faces,
        status: itemPlano.status,
        valor: itemPlano.valor,
        procedimentoId: itemPlano.procedimentoId,
        procedimentoNome: procedimento.nome,
        // Item pode ter mais de uma execução (retratamento); basta saber se há.
        execucaoEm: execucao.executadoEm,
      })
      .from(itemPlano)
      .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
      .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
      .leftJoin(execucao, eq(execucao.itemPlanoId, itemPlano.id))
      .where(
        and(
          eq(planoTratamento.pacienteId, pacienteId),
          inArray(itemPlano.status, [...STATUS_PLANEJADO, ...STATUS_FEITO]),
        ),
      )
      .orderBy(asc(itemPlano.denteFdi), asc(itemPlano.criadoEm)),

    db
      .select({ denteFdi: dentePaciente.denteFdi, estado: dentePaciente.estado })
      .from(dentePaciente)
      .where(eq(dentePaciente.pacienteId, pacienteId)),

    acharPlanoAtivo(pacienteId),
  ])

  const marcacoesFace: Record<number, Partial<Record<Face, EstadoFace>>> = {}
  const itens: ItemDoOdontograma[] = []
  const vistos = new Set<string>()

  for (const l of linhas) {
    const executado =
      l.execucaoEm !== null || (STATUS_FEITO as readonly string[]).includes(l.status)

    // O left join duplica a linha quando há várias execuções.
    if (!vistos.has(l.id)) {
      vistos.add(l.id)
      itens.push({
        id: l.id,
        planoId: l.planoId,
        denteFdi: l.denteFdi,
        faces: (l.faces ?? []) as readonly Face[],
        status: l.status,
        procedimentoNome: l.procedimentoNome,
        procedimentoId: l.procedimentoId,
        valor: l.valor,
        executado,
        executadoEm: l.execucaoEm,
      })
    }

    if (l.denteFdi === null) continue
    const doDente = (marcacoesFace[l.denteFdi] ??= {})

    for (const face of (l.faces ?? []) as Face[]) {
      // Executado nunca é rebaixado para planejado.
      if (doDente[face] === 'executado') continue
      doDente[face] = executado ? 'executado' : 'planejado'
    }
  }

  const marcacoesDente: Record<number, EstadoDenteRegistrado> = {}
  for (const e of estadosDente) {
    marcacoesDente[e.denteFdi] = e.estado
  }

  await registrarLeitura(ator, 'odontograma', pacienteId, {
    itens: itens.length,
    dentesComEstado: estadosDente.length,
  })

  return { marcacoesFace, marcacoesDente, itens, planoAtivoId: plano?.id ?? null }
}

/**
 * Plano de tratamento ativo do paciente.
 *
 * A gestão de planos é a Fase 6; aqui só se localiza o ativo, para o
 * odontograma ter onde pendurar o item que criar.
 */
export async function acharPlanoAtivo(
  pacienteId: string,
): Promise<{ id: string; titulo: string } | null> {
  const [linha] = await db
    .select({ id: planoTratamento.id, titulo: planoTratamento.titulo })
    .from(planoTratamento)
    .where(and(eq(planoTratamento.pacienteId, pacienteId), eq(planoTratamento.status, 'ativo')))
    .orderBy(asc(planoTratamento.criadoEm))
    .limit(1)
  return linha ?? null
}

/** Procedimentos que se aplicam a dente, para o seletor do odontograma. */
export async function procedimentosPorDente(): Promise<
  readonly {
    id: string
    nome: string
    valorParticular: string
    requerFace: boolean
    especialidade: string | null
  }[]
> {
  return db
    .select({
      id: procedimento.id,
      nome: procedimento.nome,
      valorParticular: procedimento.valorParticular,
      requerFace: procedimento.requerFace,
      especialidade: procedimento.especialidade,
    })
    .from(procedimento)
    .where(and(eq(procedimento.ativo, true), eq(procedimento.requerDente, true)))
    .orderBy(asc(procedimento.nome))
}

/** Histórico de execuções do paciente — a base da aba de prontuário na Fase 7. */
export async function execucoesDoPaciente(
  pacienteId: string,
): Promise<
  readonly {
    itemId: string
    denteFdi: number | null
    procedimentoNome: string
    executadoEm: Date
  }[]
> {
  return db
    .select({
      itemId: itemPlano.id,
      denteFdi: itemPlano.denteFdi,
      procedimentoNome: procedimento.nome,
      executadoEm: execucao.executadoEm,
    })
    .from(execucao)
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .where(and(eq(planoTratamento.pacienteId, pacienteId), isNotNull(execucao.executadoEm)))
    .orderBy(asc(execucao.executadoEm))
}
