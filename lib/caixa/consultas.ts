import { db } from '@/lib/db'
import {
  categoriaDespesa,
  clinica,
  despesa,
  eventoPix,
  intencaoPix,
  pagamento,
  pagamentoDespesa,
  regraDespesaRecorrente,
  taxaMeioPagamento,
} from '@/lib/db/schema'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import {
  type SituacaoDespesa,
  competenciaDaData,
  saldoDaDespesa,
  situacaoDaDespesa,
} from '@/lib/domain/despesa'
import { compara, somar, subtrair } from '@/lib/domain/dinheiro'
import { quebrarLiquido, taxaVigenteEm } from '@/lib/domain/taxaPagamento'
import { DA_CLINICA_ATUAL } from '@/lib/tenant/sql'
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm'

/**
 * Leituras do fechamento financeiro.
 *
 * ── Qual tela responde qual pergunta ────────────────────────────────────────
 * Este arquivo tem duas funções que parecem a mesma coisa e não são. A confusão entre
 * elas é o erro clássico do módulo financeiro, e o sintoma não é um erro na tela — é
 * um relatório que a contadora recusa. Então está escrito aqui, uma vez:
 *
 * | Pergunta                                  | Função                      | Data que manda |
 * |-------------------------------------------|-----------------------------|----------------|
 * | "quanto entrou e saiu do banco em agosto?"| `fluxoDeCaixaDoPeriodo`     | `pago_em`      |
 * | "quanto custou julho?"                    | `despesasPorCompetencia`    | `competencia`  |
 * | "o que eu ainda devo?"                    | `contasAPagar`              | `vencimento`   |
 *
 * O aluguel de julho pago em 5 de agosto aparece em **agosto** no fluxo de caixa e em
 * **julho** na competência. As duas estão certas; são perguntas diferentes.
 *
 * ── O que NÃO existe aqui, e não deve passar a existir ──────────────────────
 * Nenhuma função soma **caixa** com **produção** — decisão fechada do projeto. São
 * grandezas diferentes: executado em julho pode entrar em outubro, e a comissão é sobre
 * o recebido. `producaoDoPeriodo` vive em `lib/relatorios/` e continua lá, separada.
 *
 * E nenhuma função deriva despesa de comissão apurada. `comissaoDoPeriodo` diz quanto
 * cada profissional tem a receber; quando a clínica paga, alguém lança a despesa — à
 * mão. Derivar automaticamente seria contagem dupla esperando acontecer, porque o
 * lançamento manual vai existir de todo jeito (o dinheiro saiu do banco).
 */

export interface Periodo {
  readonly de: string
  readonly ate: string
}

// ── Fluxo de caixa: regime de CAIXA ──────────────────────────────────────────

export interface FluxoDeCaixa {
  readonly deIso: string
  readonly ateIso: string
  /** Entradas pelo valor BRUTO pago pelo paciente. */
  readonly entradasBrutas: string
  /** Quanto o meio de pagamento retém (MDR). */
  readonly taxas: string
  /** O que de fato chega na conta: bruto − taxas. */
  readonly entradasLiquidas: string
  readonly saidas: string
  /** `entradasLiquidas − saidas`. Pode ser negativo, e isso é informação. */
  readonly resultadoDeCaixa: string
  readonly porCategoria: readonly {
    readonly categoria: string
    readonly natureza: 'fixa' | 'variavel'
    readonly valor: string
  }[]
}

/**
 * Entrou menos saiu, no período, pelas datas em que o dinheiro se moveu.
 *
 * ── Por que as taxas aparecem separadas em vez de já descontadas ────────────
 * Porque as duas informações são usadas por pessoas diferentes. A recepção precisa
 * saber que o paciente pagou R$ 100 (é o que consta no recibo dele); quem confere o
 * extrato precisa saber que caíram R$ 97,51. Descontar em silêncio faria o recibo do
 * paciente não bater com o sistema; não descontar faz o sistema não bater com o banco.
 * Mostrar os três números resolve os dois.
 *
 * A taxa aplicada é a **vigente na data do pagamento**, nunca a de hoje — mesma regra
 * do preço de convênio. Sem taxa cadastrada, líquido = bruto (não é erro: é o que
 * acontece com dinheiro em espécie, e é o comportamento anterior).
 */
export async function fluxoDeCaixaDoPeriodo(p: Periodo): Promise<FluxoDeCaixa> {
  const taxas = await db
    .select({
      meio: taxaMeioPagamento.meio,
      percentual: taxaMeioPagamento.percentual,
      valorFixo: taxaMeioPagamento.valorFixo,
      vigenciaInicio: taxaMeioPagamento.vigenciaInicio,
      vigenciaFim: taxaMeioPagamento.vigenciaFim,
    })
    .from(taxaMeioPagamento)
    // `eq(tabela.clinicaId, app_clinica_id())`, e NÃO `DA_CLINICA_ATUAL`: aquele é
    // `eq(clinica.id, …)` e serve para quem seleciona FROM clinica. Usado em outra
    // tabela, ele gera `where "clinica"."id" = …` sem clinica no FROM — erro 42P01,
    // "missing FROM-clause entry". Custou uma execução desta demonstração.
    .where(eq(taxaMeioPagamento.clinicaId, sql`app_clinica_id()`))

  const entradas = await db
    .select({ valor: pagamento.valor, meio: pagamento.meio, pagoEm: pagamento.pagoEm })
    .from(pagamento)
    .where(
      and(
        eq(pagamento.clinicaId, sql`app_clinica_id()`),
        isNull(pagamento.estornadoEm),
        gte(pagamento.pagoEm, p.de),
        lte(pagamento.pagoEm, p.ate),
      ),
    )

  let bruto = '0.00'
  let taxaTotal = '0.00'
  for (const e of entradas) {
    const quebra = quebrarLiquido(e.valor, taxaVigenteEm(taxas, e.meio, e.pagoEm))
    bruto = somar(bruto, quebra.bruto)
    taxaTotal = somar(taxaTotal, quebra.taxa)
  }
  const liquido = subtrair(bruto, taxaTotal)

  const saidasPorCategoria = await db
    .select({
      categoria: categoriaDespesa.nome,
      natureza: categoriaDespesa.natureza,
      valor: sql<string>`coalesce(sum("pagamento_despesa"."valor"), 0)::text`,
    })
    .from(pagamentoDespesa)
    // `"tabela"."coluna"` literal no `sql` acima: `${pagamentoDespesa.valor}` renderiza
    // SEM qualificar a tabela, e com join isso vira "column reference is ambiguous".
    .innerJoin(
      despesa,
      and(eq(despesa.id, pagamentoDespesa.despesaId), eq(despesa.clinicaId, pagamentoDespesa.clinicaId)),
    )
    .innerJoin(
      categoriaDespesa,
      and(
        eq(categoriaDespesa.id, despesa.categoriaId),
        eq(categoriaDespesa.clinicaId, despesa.clinicaId),
      ),
    )
    .where(
      and(
        eq(pagamentoDespesa.clinicaId, sql`app_clinica_id()`),
        isNull(pagamentoDespesa.estornadoEm),
        gte(pagamentoDespesa.pagoEm, p.de),
        lte(pagamentoDespesa.pagoEm, p.ate),
      ),
    )
    .groupBy(categoriaDespesa.nome, categoriaDespesa.natureza)
    .orderBy(asc(categoriaDespesa.nome))

  const saidas =
    saidasPorCategoria.length === 0 ? '0.00' : somar(...saidasPorCategoria.map((s) => s.valor))

  return {
    deIso: p.de,
    ateIso: p.ate,
    entradasBrutas: bruto,
    taxas: taxaTotal,
    entradasLiquidas: liquido,
    saidas,
    resultadoDeCaixa: subtrair(liquido, saidas),
    porCategoria: saidasPorCategoria.map((s) => ({
      categoria: s.categoria,
      natureza: s.natureza as 'fixa' | 'variavel',
      valor: s.valor,
    })),
  }
}

// ── Competência: quanto custou o mês ─────────────────────────────────────────

export interface DespesaPorCompetencia {
  readonly competencia: string
  readonly total: string
  readonly fixas: string
  readonly variaveis: string
  readonly porCategoria: readonly { readonly categoria: string; readonly valor: string }[]
}

/**
 * Quanto o período CUSTOU, independente de quando foi pago.
 *
 * Despesa cancelada fica fora: não é custo, é lançamento desfeito.
 *
 * `fixas` responde a pergunta que decide se a clínica aguenta um mês fraco — "de
 * quanto preciso com zero paciente?". É a soma que um consultório precisa saber de
 * cabeça e quase nunca sabe.
 */
export async function despesasPorCompetencia(p: Periodo): Promise<DespesaPorCompetencia> {
  const linhas = await db
    .select({
      categoria: categoriaDespesa.nome,
      natureza: categoriaDespesa.natureza,
      valor: sql<string>`coalesce(sum("despesa"."valor"), 0)::text`,
    })
    .from(despesa)
    .innerJoin(
      categoriaDespesa,
      and(
        eq(categoriaDespesa.id, despesa.categoriaId),
        eq(categoriaDespesa.clinicaId, despesa.clinicaId),
      ),
    )
    .where(
      and(
        eq(despesa.clinicaId, sql`app_clinica_id()`),
        isNull(despesa.canceladoEm),
        gte(despesa.competencia, p.de),
        lte(despesa.competencia, p.ate),
      ),
    )
    .groupBy(categoriaDespesa.nome, categoriaDespesa.natureza)
    .orderBy(asc(categoriaDespesa.nome))

  const fixas = linhas.filter((l) => l.natureza === 'fixa').map((l) => l.valor)
  const variaveis = linhas.filter((l) => l.natureza === 'variavel').map((l) => l.valor)

  return {
    competencia: competenciaDaData(p.de),
    total: linhas.length === 0 ? '0.00' : somar(...linhas.map((l) => l.valor)),
    fixas: fixas.length === 0 ? '0.00' : somar(...fixas),
    variaveis: variaveis.length === 0 ? '0.00' : somar(...variaveis),
    porCategoria: linhas.map((l) => ({ categoria: l.categoria, valor: l.valor })),
  }
}

// ── Contas a pagar ───────────────────────────────────────────────────────────

export interface ContaAPagar {
  readonly id: string
  readonly descricao: string
  readonly categoria: string
  readonly fornecedor: string | null
  readonly valor: string
  readonly pago: string
  readonly saldo: string
  readonly vencimento: string
  readonly competencia: string
  readonly situacao: SituacaoDespesa
  readonly diasDeAtraso: number
}

/**
 * O que ainda se deve, em ordem de vencimento.
 *
 * `saldo` e `situacao` são **derivados** — a soma dos pagamentos não estornados. Não
 * existe coluna de saldo, pelo mesmo motivo que `lote_material.saldo` recusa `UPDATE`
 * à mão: coluna derivada é a que fica errada primeiro, e ninguém percebe até o mês em
 * que a conta não bate.
 */
export async function contasAPagar(opcoes: { readonly incluirPagas?: boolean } = {}): Promise<
  readonly ContaAPagar[]
> {
  const hoje = await hojeDaClinica()

  const linhas = await db
    .select({
      id: despesa.id,
      descricao: despesa.descricao,
      categoria: categoriaDespesa.nome,
      fornecedor: despesa.fornecedor,
      valor: despesa.valor,
      vencimento: despesa.vencimento,
      competencia: despesa.competencia,
      canceladoEm: despesa.canceladoEm,
      pago: sql<string>`(
        select coalesce(sum(pd.valor), 0)::text from pagamento_despesa pd
         where pd.despesa_id = "despesa"."id" and pd.estornado_em is null
      )`,
    })
    .from(despesa)
    .innerJoin(
      categoriaDespesa,
      and(
        eq(categoriaDespesa.id, despesa.categoriaId),
        eq(categoriaDespesa.clinicaId, despesa.clinicaId),
      ),
    )
    .where(eq(despesa.clinicaId, sql`app_clinica_id()`))
    .orderBy(asc(despesa.vencimento))

  const contas = linhas.map((l) => {
    const pagos = compara(l.pago, '0.00') > 0 ? [l.pago] : []
    const saldo = saldoDaDespesa({ valor: l.valor, pagos })
    const situacao = situacaoDaDespesa(
      { valor: l.valor, pagos, vencimento: l.vencimento, cancelada: l.canceladoEm !== null },
      hoje,
    )
    return {
      id: l.id,
      descricao: l.descricao,
      categoria: l.categoria,
      fornecedor: l.fornecedor,
      valor: l.valor,
      pago: l.pago,
      saldo,
      vencimento: l.vencimento,
      competencia: l.competencia,
      situacao,
      diasDeAtraso: situacao === 'vencida' ? diasEntre(l.vencimento, hoje) : 0,
    }
  })

  if (opcoes.incluirPagas) return contas
  return contas.filter((c) => c.situacao !== 'paga' && c.situacao !== 'cancelada')
}

function diasEntre(deIso: string, ateIso: string): number {
  const ms = Date.parse(`${ateIso}T00:00:00Z`) - Date.parse(`${deIso}T00:00:00Z`)
  return Math.max(0, Math.round(ms / 86_400_000))
}

// ── Projeção das recorrentes: cálculo, não escrita ───────────────────────────

export interface ProjecaoRecorrente {
  readonly descricao: string
  readonly categoria: string
  readonly valor: string
  readonly diaVencimento: number
}

/**
 * As regras recorrentes ativas — para projetar os próximos meses **sem gravar nada**.
 *
 * Materializar o futuro criaria 240 linhas por aluguel e transformaria o reajuste
 * anual em "editar 240 linhas futuras, ou algumas e esquecer". Quem quer ver o que vem
 * soma isto; quem quer pagar espera a competência chegar.
 */
export async function recorrentesAtivas(): Promise<readonly ProjecaoRecorrente[]> {
  return await db
    .select({
      descricao: regraDespesaRecorrente.descricao,
      categoria: categoriaDespesa.nome,
      valor: regraDespesaRecorrente.valor,
      diaVencimento: regraDespesaRecorrente.diaVencimento,
    })
    .from(regraDespesaRecorrente)
    .innerJoin(
      categoriaDespesa,
      and(
        eq(categoriaDespesa.id, regraDespesaRecorrente.categoriaId),
        eq(categoriaDespesa.clinicaId, regraDespesaRecorrente.clinicaId),
      ),
    )
    .where(
      and(eq(regraDespesaRecorrente.clinicaId, sql`app_clinica_id()`), eq(regraDespesaRecorrente.ativo, true)),
    )
    .orderBy(asc(regraDespesaRecorrente.diaVencimento))
}

// ── Leituras de apoio das telas ──────────────────────────────────────────────

export interface CategoriaNaTela {
  readonly id: string
  readonly nome: string
  readonly natureza: 'fixa' | 'variavel'
  readonly ativo: boolean
}

/**
 * As categorias, para o seletor do lançamento.
 *
 * Inclui as desativadas quando pedido: a tela de custos precisa nomear a categoria de
 * uma despesa antiga cuja categoria foi desativada depois. Sem isso a linha apareceria
 * sem nome, e "sem categoria" é indistinguível de erro de cadastro.
 */
export async function categoriasDeDespesa(
  opcoes: { readonly incluirInativas?: boolean } = {},
): Promise<readonly CategoriaNaTela[]> {
  const linhas = await db
    .select({
      id: categoriaDespesa.id,
      nome: categoriaDespesa.nome,
      natureza: categoriaDespesa.natureza,
      ativo: categoriaDespesa.ativo,
    })
    .from(categoriaDespesa)
    .where(eq(categoriaDespesa.clinicaId, sql`app_clinica_id()`))
    .orderBy(asc(categoriaDespesa.nome))

  const todas = linhas.map((l) => ({ ...l, natureza: l.natureza as 'fixa' | 'variavel' }))
  return opcoes.incluirInativas ? todas : todas.filter((c) => c.ativo)
}

export interface PagamentoNaTela {
  readonly id: string
  readonly valor: string
  readonly pagoEm: string
  readonly meio: string
  readonly comprovante: string | null
  readonly estornado: boolean
  readonly motivoEstorno: string | null
}

/**
 * Os pagamentos de uma despesa, **inclusive os estornados**.
 *
 * O estornado fica visível de propósito. Ele saiu da soma do saldo, mas não da
 * história: quem confere o extrato do mês vê a saída e o retorno, e uma tela que
 * esconde o estorno faz o extrato do banco não bater com o sistema sem explicação.
 */
export async function pagamentosDaDespesa(despesaId: string): Promise<readonly PagamentoNaTela[]> {
  const linhas = await db
    .select({
      id: pagamentoDespesa.id,
      valor: pagamentoDespesa.valor,
      pagoEm: pagamentoDespesa.pagoEm,
      meio: pagamentoDespesa.meio,
      comprovante: pagamentoDespesa.comprovante,
      estornadoEm: pagamentoDespesa.estornadoEm,
      motivoEstorno: pagamentoDespesa.motivoEstorno,
    })
    .from(pagamentoDespesa)
    .where(
      and(
        eq(pagamentoDespesa.clinicaId, sql`app_clinica_id()`),
        eq(pagamentoDespesa.despesaId, despesaId),
      ),
    )
    .orderBy(asc(pagamentoDespesa.pagoEm))

  return linhas.map((l) => ({
    id: l.id,
    valor: l.valor,
    pagoEm: l.pagoEm,
    meio: l.meio,
    comprovante: l.comprovante,
    estornado: l.estornadoEm !== null,
    motivoEstorno: l.motivoEstorno,
  }))
}

// ── Conciliação do Pix ───────────────────────────────────────────────────────

export interface EventoPixPendente {
  readonly id: string
  readonly endToEndId: string
  readonly txid: string
  readonly valor: string
  readonly liquidadoEm: Date
  readonly motivo: string
}

/**
 * Liquidações que chegaram e **não** viraram pagamento.
 *
 * Esta é a tela mais importante do módulo de conciliação, e a razão é desconfortável:
 * cada linha aqui é **dinheiro que caiu na conta da clínica e o sistema não sabe de
 * quem é**. Pix sem cobrança correspondente, valor divergente, ou segundo pagamento do
 * mesmo QR.
 *
 * O evento não é descartado justamente para aparecer aqui — apagar a notificação seria
 * a única coisa pior que não conciliar. A resolução é humana: devolver, casar à mão, ou
 * descobrir que era outra clínica pagando na chave errada.
 */
export async function eventosPixPendentes(): Promise<readonly EventoPixPendente[]> {
  const linhas = await db
    .select({
      id: eventoPix.id,
      endToEndId: eventoPix.endToEndId,
      txid: eventoPix.txid,
      valor: eventoPix.valor,
      liquidadoEm: eventoPix.liquidadoEm,
      motivo: eventoPix.motivoNaoProcessado,
    })
    .from(eventoPix)
    .where(and(eq(eventoPix.clinicaId, sql`app_clinica_id()`), isNull(eventoPix.processadoEm)))
    .orderBy(asc(eventoPix.liquidadoEm))

  return linhas.map((l) => ({
    id: l.id,
    endToEndId: l.endToEndId,
    txid: l.txid,
    valor: l.valor,
    liquidadoEm: l.liquidadoEm,
    // O CHECK `evento_pix_nao_processado_justificado` garante que não-processado tem
    // motivo. O `??` existe para o tipo, não para o caso.
    motivo: l.motivo ?? 'sem motivo registrado',
  }))
}

export interface CobrancaPixNaTela {
  readonly id: string
  readonly txid: string
  readonly valor: string
  readonly situacao: string
  readonly expiraEm: Date
  readonly expirada: boolean
}

/**
 * Cobranças Pix emitidas e ainda não liquidadas.
 *
 * `expirada` é derivado do instante, não de uma coluna de estado: um QR expira sozinho
 * quando a hora passa, e gravar "expirado" exigiria alguém rodando para marcar — o que
 * significa que a tela mostraria "pendente" para um QR morto até a próxima passada.
 */
export async function cobrancasPixEmAberto(): Promise<readonly CobrancaPixNaTela[]> {
  const agora = new Date()
  const linhas = await db
    .select({
      id: intencaoPix.id,
      txid: intencaoPix.txid,
      valor: intencaoPix.valor,
      situacao: intencaoPix.situacao,
      expiraEm: intencaoPix.expiraEm,
    })
    .from(intencaoPix)
    .where(
      and(
        eq(intencaoPix.clinicaId, sql`app_clinica_id()`),
        eq(intencaoPix.situacao, 'pendente'),
      ),
    )
    .orderBy(asc(intencaoPix.expiraEm))

  return linhas.map((l) => ({
    id: l.id,
    txid: l.txid,
    valor: l.valor,
    situacao: l.situacao,
    expiraEm: l.expiraEm,
    expirada: l.expiraEm.getTime() < agora.getTime(),
  }))
}

/** A escolha da clínica sobre a base da comissão. Um lugar só que lê essa coluna. */
export async function comissaoSobreLiquido(): Promise<boolean> {
  const [linha] = await db
    .select({ v: clinica.comissaoSobreLiquido })
    .from(clinica)
    .where(DA_CLINICA_ATUAL)
  if (!linha) {
    throw new Error('Clínica do contexto não encontrada ao ler a base da comissão.')
  }
  return linha.v
}
