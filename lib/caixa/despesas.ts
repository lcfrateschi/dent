import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { categoriaDespesa, despesa, pagamentoDespesa, regraDespesaRecorrente } from '@/lib/db/schema'
import {
  competenciaDaData,
  competenciasDevidas,
  saldoDaDespesa,
  vencimentoNaCompetencia,
} from '@/lib/domain/despesa'
import { compara } from '@/lib/domain/dinheiro'
import { ErroDominio } from '@/lib/domain/erros'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

/**
 * Escrita do dinheiro que sai. **Núcleo, sem `'use server'`.**
 *
 * ── O que este arquivo NÃO decide ───────────────────────────────────────────
 * Saldo, situação e competências devidas são de `lib/domain/despesa.ts`, puras e
 * testadas. Aqui há persistência e uma trava de concorrência — nada mais. A regra
 * duplicada entre a ação e o gerador é como as duas divergem.
 *
 * E o limite mais importante: a soma dos pagamentos nunca passa do valor da despesa,
 * e isso é **trigger no banco** (`pagamento_despesa_soma`, na `0034`), não um `if`
 * daqui. Um `if` aqui protegeria esta função e deixaria passar o `INSERT` que um
 * script de importação futuro faria direto.
 */

export type ResultadoDespesa =
  | { readonly ok: true; readonly mensagem: string; readonly id?: string }
  | { readonly ok: false; readonly mensagem: string }

export interface NovaDespesa {
  readonly categoriaId: string
  readonly descricao: string
  readonly valor: string
  /** Dia civil a que a despesa pertence. Ausente = a competência de hoje. */
  readonly competencia?: string
  readonly vencimento: string
  readonly fornecedor?: string
  readonly documento?: string
  readonly observacao?: string
}

export async function lancarDespesaComAtor(
  ator: Ator,
  entrada: NovaDespesa,
): Promise<ResultadoDespesa> {
  const descricao = entrada.descricao?.trim()
  if (!descricao || descricao.length < 3) {
    return { ok: false, mensagem: 'Descreva a despesa — "diversos" não ajuda ninguém depois.' }
  }
  if (compara(entrada.valor, '0.00') <= 0) {
    return { ok: false, mensagem: 'O valor da despesa precisa ser maior que zero.' }
  }

  const hoje = await hojeDaClinica()
  const competencia = competenciaDaData(entrada.competencia ?? hoje)

  const [cat] = await db
    .select({ id: categoriaDespesa.id, ativo: categoriaDespesa.ativo })
    .from(categoriaDespesa)
    .where(
      and(
        eq(categoriaDespesa.clinicaId, sql`app_clinica_id()`),
        eq(categoriaDespesa.id, entrada.categoriaId),
      ),
    )
  if (!cat) return { ok: false, mensagem: 'Categoria não encontrada nesta clínica.' }
  if (!cat.ativo) {
    return {
      ok: false,
      mensagem: 'Categoria desativada. Reative-a ou escolha outra — despesa antiga mantém a dela.',
    }
  }

  const [nova] = await db
    .insert(despesa)
    .values({
      categoriaId: entrada.categoriaId,
      descricao,
      valor: entrada.valor,
      competencia,
      vencimento: entrada.vencimento,
      fornecedor: entrada.fornecedor?.trim() || null,
      documento: entrada.documento?.trim() || null,
      observacao: entrada.observacao?.trim() || null,
      criadoPorId: ator.usuarioId,
    })
    .returning({ id: despesa.id })

  await registrar({
    ator,
    acao: 'criacao',
    entidade: 'despesa',
    entidadeId: nova!.id,
    detalhes: { valor: entrada.valor, competencia, categoria: entrada.categoriaId },
  })

  return { ok: true, mensagem: 'Despesa lançada.', id: nova!.id }
}

export interface PagamentoDeDespesa {
  readonly despesaId: string
  readonly valor: string
  /** Dia em que o dinheiro saiu. Ausente = hoje. */
  readonly pagoEm?: string
  readonly meio: 'dinheiro' | 'pix' | 'debito' | 'credito' | 'boleto' | 'transferencia'
  readonly comprovante?: string
  readonly observacao?: string
}

/**
 * Registra a saída de dinheiro.
 *
 * `FOR UPDATE` na despesa: duas pessoas pagando a mesma conta ao mesmo tempo é o caso
 * que a trigger de soma pega, mas pegar com erro de constraint é pior que serializar —
 * a mensagem do Postgres não diz "outra pessoa acabou de pagar isto".
 */
export async function pagarDespesaComAtor(
  ator: Ator,
  entrada: PagamentoDeDespesa,
): Promise<ResultadoDespesa> {
  if (compara(entrada.valor, '0.00') <= 0) {
    return { ok: false, mensagem: 'O valor do pagamento precisa ser maior que zero.' }
  }
  const hoje = await hojeDaClinica()

  try {
    return await db.transaction(async (tx) => {
      const [d] = await tx
        .select({
          id: despesa.id,
          valor: despesa.valor,
          canceladoEm: despesa.canceladoEm,
          descricao: despesa.descricao,
        })
        .from(despesa)
        .where(and(eq(despesa.clinicaId, sql`app_clinica_id()`), eq(despesa.id, entrada.despesaId)))
        .for('update')
      if (!d) return { ok: false as const, mensagem: 'Despesa não encontrada nesta clínica.' }
      if (d.canceladoEm) {
        return {
          ok: false as const,
          mensagem: 'Despesa cancelada não recebe pagamento. Se o dinheiro saiu, ela não devia estar cancelada.',
        }
      }

      // Lido DENTRO da transação e com a despesa travada: fora dela, o total pago pode
      // mudar entre a leitura e o INSERT, e a mensagem amigável descreveria um saldo
      // que já não existe.
      const [totalPago] = await tx
        .select({ pago: sql<string>`coalesce(sum(${pagamentoDespesa.valor}), 0)::text` })
        .from(pagamentoDespesa)
        .where(
          and(
            eq(pagamentoDespesa.despesaId, d.id),
            isNull(pagamentoDespesa.estornadoEm),
          ),
        )

      const saldo = saldoDaDespesa({ valor: d.valor, pagos: [totalPago?.pago ?? '0.00'] })
      if (compara(entrada.valor, saldo) > 0) {
        return {
          ok: false as const,
          mensagem: `O pagamento (${entrada.valor}) passa do saldo devedor (${saldo}) de "${d.descricao}".`,
        }
      }

      const [novo] = await tx
        .insert(pagamentoDespesa)
        .values({
          despesaId: d.id,
          valor: entrada.valor,
          pagoEm: entrada.pagoEm ?? hoje,
          meio: entrada.meio,
          comprovante: entrada.comprovante?.trim() || null,
          observacao: entrada.observacao?.trim() || null,
          registradoPorId: ator.usuarioId,
        })
        .returning({ id: pagamentoDespesa.id })

      await registrar({
        ator,
        acao: 'criacao',
        entidade: 'pagamento_despesa',
        entidadeId: novo!.id,
        detalhes: { despesaId: d.id, valor: entrada.valor, meio: entrada.meio },
      })

      return { ok: true as const, mensagem: 'Pagamento registrado.', id: novo!.id }
    })
  } catch (e) {
    if (e instanceof ErroDominio) return { ok: false, mensagem: e.message }
    throw e
  }
}

export async function cancelarDespesaComAtor(
  ator: Ator,
  despesaId: string,
  motivo: string,
): Promise<ResultadoDespesa> {
  const razao = motivo?.trim()
  if (!razao) {
    return { ok: false, mensagem: 'Cancelar despesa exige motivo — o histórico é o que sobra.' }
  }

  return await db.transaction(async (tx) => {
    const [d] = await tx
      .select({ id: despesa.id, canceladoEm: despesa.canceladoEm })
      .from(despesa)
      .where(and(eq(despesa.clinicaId, sql`app_clinica_id()`), eq(despesa.id, despesaId)))
      .for('update')
    if (!d) return { ok: false as const, mensagem: 'Despesa não encontrada nesta clínica.' }
    if (d.canceladoEm) return { ok: true as const, mensagem: 'Já estava cancelada.' }

    const [contagem] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(pagamentoDespesa)
      .where(and(eq(pagamentoDespesa.despesaId, d.id), isNull(pagamentoDespesa.estornadoEm)))
    const n = contagem?.n ?? 0
    if (n > 0) {
      /**
       * Cancelar despesa já paga apagaria a obrigação e deixaria a saída de caixa
       * órfã: o dinheiro saiu, o extrato mostra, e o sistema diria que não havia nada
       * a pagar. O caminho é estornar o pagamento primeiro — que deixa rastro dos dois
       * lados.
       */
      return {
        ok: false as const,
        mensagem: `Esta despesa tem ${n} pagamento(s). Estorne-os antes — cancelar deixaria a saída de caixa sem obrigação.`,
      }
    }

    await tx
      .update(despesa)
      .set({ canceladoEm: sql`now()`, motivoCancelamento: razao })
      .where(eq(despesa.id, d.id))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'despesa',
      entidadeId: d.id,
      detalhes: { cancelada: true, motivo: razao },
    })
    return { ok: true as const, mensagem: 'Despesa cancelada.' }
  })
}

export async function estornarPagamentoDeDespesaComAtor(
  ator: Ator,
  pagamentoId: string,
  motivo: string,
): Promise<ResultadoDespesa> {
  const razao = motivo?.trim()
  if (!razao) return { ok: false, mensagem: 'Estorno exige motivo.' }

  const atualizadas = await db
    .update(pagamentoDespesa)
    .set({ estornadoEm: sql`now()`, motivoEstorno: razao })
    .where(
      and(
        eq(pagamentoDespesa.clinicaId, sql`app_clinica_id()`),
        eq(pagamentoDespesa.id, pagamentoId),
        isNull(pagamentoDespesa.estornadoEm),
      ),
    )
    .returning({ id: pagamentoDespesa.id })

  if (atualizadas.length === 0) {
    // `UPDATE` que casa zero linhas é ambíguo: não existe, é de outra clínica, ou já
    // estava estornado. Dizer "estornado" aqui seria mentir para quem clicou.
    return { ok: false, mensagem: 'Pagamento não encontrado, de outra clínica, ou já estornado.' }
  }

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'pagamento_despesa',
    entidadeId: pagamentoId,
    detalhes: { estornado: true, motivo: razao },
  })
  return { ok: true, mensagem: 'Pagamento estornado.' }
}

// ── Materialização das recorrentes ───────────────────────────────────────────

export interface ResultadoMaterializacao {
  readonly criadas: number
  readonly regrasVistas: number
  readonly avisos: readonly string[]
}

/**
 * Cria as despesas das regras recorrentes cujas competências já chegaram.
 *
 * ── Por que é idempotente por ÍNDICE, e não por verificação ────────────────
 * `(recorrente_id, competencia)` é único. O gerador roda no laço do despachante, a
 * cada dez minutos, para sempre — e "verifica se já existe, se não existe insere" tem
 * janela entre ler e escrever. Duas execuções sobrepostas (um `up` durante o laço
 * anterior) criariam o aluguel duas vezes.
 *
 * Aqui a colisão é o mecanismo: `onConflictDoNothing` no índice. O que este código
 * calcula é **quais competências deveriam existir** (`competenciasDevidas`, pura e
 * testada); o banco decide quais faltam.
 *
 * Roda **por clínica**, com o contexto já definido por quem chama — o despachante
 * troca de contexto a cada iteração.
 */
export async function materializarRecorrentes(): Promise<ResultadoMaterializacao> {
  const hoje = await hojeDaClinica()
  const avisos: string[] = []

  const regras = await db
    .select({
      id: regraDespesaRecorrente.id,
      categoriaId: regraDespesaRecorrente.categoriaId,
      descricao: regraDespesaRecorrente.descricao,
      valor: regraDespesaRecorrente.valor,
      diaVencimento: regraDespesaRecorrente.diaVencimento,
      inicioEm: regraDespesaRecorrente.inicioEm,
      fimEm: regraDespesaRecorrente.fimEm,
      ativo: regraDespesaRecorrente.ativo,
    })
    .from(regraDespesaRecorrente)
    // Filtro explícito de clínica: este código roda no despachante, como DONO das
    // tabelas, onde não há política de RLS filtrando por ninguém.
    .where(
      and(
        eq(regraDespesaRecorrente.clinicaId, sql`app_clinica_id()`),
        eq(regraDespesaRecorrente.ativo, true),
      ),
    )

  if (regras.length === 0) return { criadas: 0, regrasVistas: 0, avisos }

  const jaExistem = await db
    .select({ recorrenteId: despesa.recorrenteId, competencia: despesa.competencia })
    .from(despesa)
    .where(
      and(
        eq(despesa.clinicaId, sql`app_clinica_id()`),
        inArray(
          despesa.recorrenteId,
          regras.map((r) => r.id),
        ),
      ),
    )
  const existentes = new Set(jaExistem.map((d) => `${d.recorrenteId}|${d.competencia}`))

  const aInserir: (typeof despesa.$inferInsert)[] = []
  for (const r of regras) {
    let devidas: readonly string[]
    try {
      devidas = competenciasDevidas(r, hoje)
    } catch (e) {
      // Regra com data de início absurda (1926 em vez de 2026) não pode derrubar a
      // materialização das outras — e também não pode ser ignorada em silêncio.
      avisos.push(
        `Regra "${r.descricao}" ignorada: ${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }
    for (const competencia of devidas) {
      if (existentes.has(`${r.id}|${competencia}`)) continue
      aInserir.push({
        categoriaId: r.categoriaId,
        descricao: r.descricao,
        valor: r.valor,
        competencia,
        vencimento: vencimentoNaCompetencia(competencia, r.diaVencimento),
        recorrenteId: r.id,
      })
    }
  }

  if (aInserir.length === 0) return { criadas: 0, regrasVistas: regras.length, avisos }

  /**
   * `INSERT … ON CONFLICT` em SQL cru, e não pelo construtor do Drizzle.
   *
   * O índice é **parcial** (`where recorrente_id is not null`), e o Postgres só o aceita
   * como árbitro de `ON CONFLICT` se o predicado for informado — senão responde
   * `42P10: there is no unique or exclusion constraint matching the ON CONFLICT
   * specification`, uma mensagem que não menciona "parcial" e manda procurar um índice
   * que existe. Esta versão do Drizzle não expõe o predicado (`targetWhere`).
   *
   * A alternativa era `onConflictDoNothing()` sem alvo, que ignora QUALQUER conflito —
   * inclusive um que devesse estourar. Perder a precisão da trava para ganhar açúcar de
   * sintaxe seria trocar a garantia pelo conforto.
   *
   * Uma instrução por linha: o volume é de poucas competências por clínica por mês, e a
   * clareza vale mais que uma inserção múltipla montada com placeholders à mão.
   */
  let criadas = 0
  for (const linha of aInserir) {
    const r = await db.execute(sql`
      insert into despesa (categoria_id, descricao, valor, competencia, vencimento, recorrente_id)
      values (${linha.categoriaId}, ${linha.descricao}, ${linha.valor},
              ${linha.competencia}, ${linha.vencimento}, ${linha.recorrenteId})
      on conflict (recorrente_id, competencia) where recorrente_id is not null do nothing
      returning id
    `)
    criadas += r.rows.length
  }

  return { criadas, regrasVistas: regras.length, avisos }
}
