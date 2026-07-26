import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { insumoProcedimento, material, procedimento } from '@/lib/db/schema'
import { paraMilesimos } from '@/lib/domain/quantidade'
import { and, asc, eq, sql } from 'drizzle-orm'

/**
 * Ficha técnica: o que cada procedimento consome.
 *
 * A ficha é o que faz o estoque ser usado em vez de abandonado — sem ela, a baixa
 * depende de alguém lembrar de lançar, e ninguém lembra no meio do atendimento.
 * Mas ela **propõe**, nunca executa: ver o comentário em `lib/db/schema/estoque.ts`.
 *
 * Salvar a ficha é substituir o conjunto inteiro, não mesclar. Mesclagem
 * silenciosa deixa insumo removido na tela por vir de um estado anterior, e a
 * pessoa conclui que o sistema "não salvou".
 */

export type ResultadoFicha =
  | { readonly ok: true; readonly mensagem: string }
  | { readonly ok: false; readonly mensagem: string }

export interface ItemDaFicha {
  readonly materialId: string
  readonly quantidade: string
}

export async function salvarFichaTecnicaComAtor(
  ator: Ator,
  procedimentoId: string,
  itens: readonly ItemDaFicha[],
): Promise<ResultadoFicha> {
  const [proc] = await db
    .select({ id: procedimento.id, nome: procedimento.nome })
    .from(procedimento)
    .where(eq(procedimento.id, procedimentoId))
    .limit(1)
  if (!proc) return { ok: false, mensagem: 'Procedimento não encontrado.' }

  const vistos = new Set<string>()
  for (const i of itens) {
    if (vistos.has(i.materialId)) {
      return { ok: false, mensagem: 'O mesmo material aparece duas vezes na ficha.' }
    }
    vistos.add(i.materialId)

    let milesimos: number
    try {
      milesimos = paraMilesimos(i.quantidade)
    } catch {
      return { ok: false, mensagem: `Quantidade inválida: "${i.quantidade}".` }
    }
    if (milesimos <= 0) {
      return { ok: false, mensagem: 'Quantidade tem de ser positiva — remova o item em vez de zerar.' }
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(insumoProcedimento).where(eq(insumoProcedimento.procedimentoId, procedimentoId))
    if (itens.length > 0) {
      await tx.insert(insumoProcedimento).values(
        itens.map((i) => ({
          procedimentoId,
          materialId: i.materialId,
          quantidade: i.quantidade,
        })),
      )
    }
  })

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'insumo_procedimento',
    entidadeId: procedimentoId,
    detalhes: { procedimento: proc.nome, itens: itens.length },
  })

  return {
    ok: true,
    mensagem:
      itens.length === 0
        ? `Ficha de ${proc.nome} esvaziada — nenhuma baixa será proposta.`
        : `Ficha de ${proc.nome} salva com ${itens.length} insumo(s).`,
  }
}

/** Ativa ou desativa um material. Nunca apaga: movimento e lote apontam para ele. */
export async function alternarMaterialComAtor(
  ator: Ator,
  materialId: string,
  ativo: boolean,
): Promise<ResultadoFicha> {
  const [m] = await db
    .select({ nome: material.nome, saldo: sql<string>`(
      select coalesce(sum(saldo), 0)::text from lote_material l where l.material_id = ${material.id}
    )` })
    .from(material)
    .where(eq(material.id, materialId))
    .limit(1)
  if (!m) return { ok: false, mensagem: 'Material não encontrado.' }

  if (!ativo && paraMilesimos(m.saldo) > 0) {
    // Material inativo sai das telas de reposição e de baixa. Com saldo, isso
    // esconderia estoque que existe na prateleira — e a contagem nunca fecharia.
    return {
      ok: false,
      mensagem: `${m.nome} ainda tem ${m.saldo} em estoque. Zere por consumo, descarte ou devolução antes de inativá-lo.`,
    }
  }

  await db.update(material).set({ ativo, atualizadoEm: new Date() }).where(eq(material.id, materialId))
  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'material',
    entidadeId: materialId,
    detalhes: { ativo },
  })
  return { ok: true, mensagem: ativo ? `${m.nome} reativado.` : `${m.nome} inativado.` }
}

export interface ProcedimentoComFicha {
  readonly id: string
  readonly codigo: string
  readonly nome: string
  readonly especialidade: string | null
  readonly insumos: number
}

/**
 * Procedimentos e quantos insumos cada um tem na ficha.
 *
 * Os que têm zero aparecem primeiro: é a lista de trabalho de quem está montando
 * as fichas, e procedimento sem ficha é baixa que nunca vai ser proposta.
 */
export async function procedimentosComFicha(): Promise<readonly ProcedimentoComFicha[]> {
  return db
    .select({
      id: procedimento.id,
      codigo: procedimento.codigo,
      nome: procedimento.nome,
      especialidade: procedimento.especialidade,
      insumos: sql<number>`(
        select count(*)::int from insumo_procedimento i
         where i."procedimento_id" = "procedimento"."id"
      )`,
    })
    .from(procedimento)
    .where(eq(procedimento.ativo, true))
    .orderBy(sql`(select count(*) from insumo_procedimento i where i."procedimento_id" = "procedimento"."id") asc`, asc(procedimento.nome))
}

/** Um material aparece em quantas fichas? A tela avisa antes de inativá-lo. */
export async function fichasQueUsam(materialId: string): Promise<readonly string[]> {
  const linhas = await db
    .select({ nome: procedimento.nome })
    .from(insumoProcedimento)
    .innerJoin(procedimento, eq(procedimento.id, insumoProcedimento.procedimentoId))
    .where(and(eq(insumoProcedimento.materialId, materialId), eq(procedimento.ativo, true)))
    .orderBy(asc(procedimento.nome))
  return linhas.map((l) => l.nome)
}
