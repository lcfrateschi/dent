import { db } from '@/lib/db'
import { orcamento, tarefaRelacionamento } from '@/lib/db/schema'
import {
  type Conversao,
  type Recuperacao,
  conversaoDeOrcamento,
  recuperacaoDaFila,
} from '@/lib/domain/indicadores'
import type { Periodo } from '@/lib/domain/periodo'
import { ROTULO_DO_TIPO, type TipoTarefa } from '@/lib/domain/relacionamento'
import { sql } from 'drizzle-orm'

/**
 * Indicadores que fecham o ciclo da Fase 18.
 *
 * A fila sem indicador é uma lista de tarefas; com indicador, é a resposta a "isto
 * está funcionando?". As duas perguntas que a clínica passa a poder fazer:
 * **quanto do que ofereci virou tratamento** e **quanto do que a fila apontou
 * virou paciente de volta**.
 *
 * ── O cálculo mora no domínio, não aqui ────────────────────────────────────
 * Estas funções contam linhas e entregam para `lib/domain/indicadores.ts`. A
 * divisão fica lá porque é onde `null` para base zero está garantido por teste —
 * um `count / count` escrito à mão aqui daria `NaN` ou `0%` no mês sem
 * movimento, e o painel mostraria 0% onde não sabe.
 */

/**
 * Conversão de orçamento no período.
 *
 * ── O que é contado, e por qual data ───────────────────────────────────────
 * A base são os orçamentos **enviados no período** — não os decididos no período.
 * A diferença importa: contar por decisão jogaria a conversão de janeiro no mês em
 * que o paciente respondeu, e o número deixaria de dizer nada sobre janeiro.
 *
 * `expirado` conta como não-conversão. Ver o comentário em
 * `conversaoDeOrcamento`: esconder o silêncio do denominador faria a conversão
 * parecer boa exatamente onde ela é ruim.
 *
 * `rascunho` fica fora da base inteira: não foi oferecido a ninguém.
 */
export async function conversaoNoPeriodo(p: Periodo): Promise<Conversao> {
  const [linha] = await db
    .select({
      enviados: sql<number>`count(*) filter (where "orcamento"."status" <> 'rascunho')::int`,
      aprovados: sql<number>`count(*) filter (where "orcamento"."status" = 'aprovado')::int`,
      recusados: sql<number>`count(*) filter (where "orcamento"."status" = 'recusado')::int`,
      expirados: sql<number>`count(*) filter (where "orcamento"."status" = 'expirado')::int`,
      emAberto: sql<number>`count(*) filter (where "orcamento"."status" = 'enviado')::int`,
    })
    .from(orcamento)
    .where(
      sql`"orcamento"."enviado_em" is not null
          and ("orcamento"."enviado_em" at time zone 'UTC')::date between ${p.de}::date and ${p.ate}::date`,
    )

  return conversaoDeOrcamento({
    enviados: Number(linha?.enviados ?? 0),
    aprovados: Number(linha?.aprovados ?? 0),
    recusados: Number(linha?.recusados ?? 0),
    expirados: Number(linha?.expirados ?? 0),
    emAberto: Number(linha?.emAberto ?? 0),
  })
}

export interface RecuperacaoPorTipo {
  readonly tipo: TipoTarefa
  readonly rotulo: string
  readonly indicador: Recuperacao
}

/**
 * Recuperação de cada fila, pelas tarefas CRIADAS no período.
 *
 * Criadas, e não resolvidas: uma fila cheia de tarefas antigas resolvidas neste mês
 * pareceria excelente e não diria nada sobre o mês. Contar pela criação faz a coorte
 * ser a mesma — e é assim que o número serve para comparar meses.
 *
 * Efeito colateral honesto: o mês corrente sempre parece pior, porque parte das
 * tarefas dele ainda não foi trabalhada. É por isso que `taxaTrabalhada` existe ao
 * lado de `taxa`.
 */
export async function recuperacaoNoPeriodo(p: Periodo): Promise<readonly RecuperacaoPorTipo[]> {
  const linhas = await db
    .select({
      tipo: tarefaRelacionamento.tipo,
      criadas: sql<number>`count(*)::int`,
      resolvidas: sql<number>`count(*) filter (
        where "tarefa_relacionamento"."situacao" = 'resolvida')::int`,
      dispensadas: sql<number>`count(*) filter (
        where "tarefa_relacionamento"."situacao" = 'dispensada')::int`,
      pendentes: sql<number>`count(*) filter (
        where "tarefa_relacionamento"."situacao" in ('aberta', 'em_andamento'))::int`,
    })
    .from(tarefaRelacionamento)
    .where(
      sql`("tarefa_relacionamento"."criado_em" at time zone 'UTC')::date
          between ${p.de}::date and ${p.ate}::date`,
    )
    .groupBy(tarefaRelacionamento.tipo)

  return linhas.map((l) => ({
    tipo: l.tipo,
    rotulo: ROTULO_DO_TIPO[l.tipo],
    indicador: recuperacaoDaFila({
      criadas: Number(l.criadas),
      resolvidas: Number(l.resolvidas),
      dispensadas: Number(l.dispensadas),
      pendentes: Number(l.pendentes),
    }),
  }))
}
