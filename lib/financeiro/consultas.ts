import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  clinica,
  cobranca,
  execucao,
  itemPlano,
  orcamento,
  orcamentoItem,
  paciente,
  pagamento,
  parcela,

  profissional,
  usuario,
} from '@/lib/db/schema'
import {
  type ParcelaParaSituacao,
  type SituacaoParcela,
  diasDeAtraso,
  resumirCobranca,
  saldoDaParcela,
  situacaoDaParcela,
  totalConciliado,
  totalPago,
} from '@/lib/domain/cobranca'
import {
  type BaseComissao,
  type ExecucaoParaComissao,
  consolidarPorProfissional,
  ratearComissao,
} from '@/lib/domain/comissao'
import { somar, subtrair } from '@/lib/domain/dinheiro'
import { DA_CLINICA_ATUAL } from '@/lib/tenant/sql'
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { hojeDaClinica } from '@/lib/orcamento/consultas'

/**
 * Consultas do financeiro.
 *
 * A situação de cada parcela é calculada por `lib/domain/cobranca.ts`, não lida
 * de `parcela.status` — a coluna é cache mantido pelo trigger e não sabe de
 * `vencida`, que depende de "hoje". Esta camada é onde o cache e a data se
 * juntam.
 */

export interface PagamentoNaTela {
  readonly id: string
  readonly valor: string
  readonly pagoEm: string
  readonly meio: string
  readonly conciliado: boolean
  readonly conciliadoEm: Date | null
  readonly estornadoEm: Date | null
  readonly motivoEstorno: string | null
  readonly observacao: string | null
  readonly registradoPorNome: string | null
}

export interface ParcelaNaTela {
  readonly id: string
  readonly numero: number
  readonly vencimento: string
  readonly valor: string
  readonly situacao: SituacaoParcela
  readonly pago: string
  readonly conciliado: string
  readonly saldo: string
  readonly diasAtraso: number
  readonly pagamentos: readonly PagamentoNaTela[]
}

export interface CobrancaCompleta {
  readonly id: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly orcamentoId: string | null
  readonly orcamentoNumero: number | null
  readonly valorTotal: string
  readonly forma: string
  readonly qtdParcelas: number
  readonly observacao: string | null
  readonly criadoEm: Date
  readonly canceladoEm: Date | null
  readonly criadoPorNome: string | null
  readonly parcelas: readonly ParcelaNaTela[]
  readonly resumo: ReturnType<typeof resumirCobranca>
}

async function parcelasDaCobranca(
  cobrancaId: string,
  hojeIso: string,
): Promise<readonly ParcelaNaTela[]> {
  const linhas = await db
    .select({
      parcelaId: parcela.id,
      numero: parcela.numero,
      vencimento: parcela.vencimento,
      valor: parcela.valor,
      status: parcela.status,
      pagId: pagamento.id,
      pagValor: pagamento.valor,
      pagoEm: pagamento.pagoEm,
      meio: pagamento.meio,
      conciliado: pagamento.conciliado,
      conciliadoEm: pagamento.conciliadoEm,
      estornadoEm: pagamento.estornadoEm,
      motivoEstorno: pagamento.motivoEstorno,
      observacao: pagamento.observacao,
      registradoPorNome: usuario.nome,
    })
    .from(parcela)
    .leftJoin(pagamento, eq(pagamento.parcelaId, parcela.id))
    .leftJoin(usuario, eq(usuario.id, pagamento.registradoPorId))
    .where(eq(parcela.cobrancaId, cobrancaId))
    .orderBy(asc(parcela.numero), asc(pagamento.pagoEm))

  // O left join repete a parcela por pagamento; reagrupa.
  const mapa = new Map<
    string,
    { base: Omit<ParcelaParaSituacao, 'pagamentos'> & { id: string; numero: number }; pagamentos: PagamentoNaTela[] }
  >()

  for (const l of linhas) {
    let entrada = mapa.get(l.parcelaId)
    if (!entrada) {
      entrada = {
        base: {
          id: l.parcelaId,
          numero: l.numero,
          valor: l.valor,
          vencimento: l.vencimento,
          status: l.status as SituacaoParcela,
        },
        pagamentos: [],
      }
      mapa.set(l.parcelaId, entrada)
    }
    if (l.pagId) {
      entrada.pagamentos.push({
        id: l.pagId,
        valor: l.pagValor!,
        pagoEm: l.pagoEm!,
        meio: l.meio!,
        conciliado: l.conciliado!,
        conciliadoEm: l.conciliadoEm,
        estornadoEm: l.estornadoEm,
        motivoEstorno: l.motivoEstorno,
        observacao: l.observacao,
        registradoPorNome: l.registradoPorNome,
      })
    }
  }

  return [...mapa.values()].map(({ base, pagamentos }) => {
    const paraSituacao: ParcelaParaSituacao = { ...base, pagamentos }
    return {
      id: base.id,
      numero: base.numero,
      vencimento: base.vencimento,
      valor: base.valor,
      situacao: situacaoDaParcela(paraSituacao, hojeIso),
      pago: totalPago(pagamentos),
      conciliado: totalConciliado(pagamentos),
      saldo: saldoDaParcela(paraSituacao),
      diasAtraso: diasDeAtraso(paraSituacao, hojeIso),
      pagamentos,
    }
  })
}

export async function acharCobranca(ator: Ator, id: string): Promise<CobrancaCompleta | null> {
  const [linha] = await db
    .select({
      id: cobranca.id,
      pacienteId: cobranca.pacienteId,
      pacienteNome: paciente.nome,
      orcamentoId: cobranca.orcamentoId,
      orcamentoNumero: orcamento.numero,
      valorTotal: cobranca.valorTotal,
      forma: cobranca.forma,
      qtdParcelas: cobranca.qtdParcelas,
      observacao: cobranca.observacao,
      criadoEm: cobranca.criadoEm,
      canceladoEm: cobranca.canceladoEm,
      criadoPorNome: usuario.nome,
    })
    .from(cobranca)
    .innerJoin(paciente, eq(paciente.id, cobranca.pacienteId))
    .leftJoin(orcamento, eq(orcamento.id, cobranca.orcamentoId))
    .leftJoin(usuario, eq(usuario.id, cobranca.criadoPorId))
    .where(eq(cobranca.id, id))
    .limit(1)

  if (!linha) return null

  const hojeIso = await hojeDaClinica()
  const parcelas = await parcelasDaCobranca(id, hojeIso)

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'cobranca',
    entidadeId: id,
    pacienteId: linha.pacienteId,
  })

  return {
    ...linha,
    parcelas,
    resumo: resumirCobranca(
      parcelas.map((p) => ({
        valor: p.valor,
        vencimento: p.vencimento,
        status: p.situacao === 'cancelada' ? 'cancelada' : 'aberta',
        pagamentos: p.pagamentos,
      })),
      hojeIso,
    ),
  }
}

export async function cobrancasDoPaciente(
  pacienteId: string,
): Promise<readonly { id: string; valorTotal: string; criadoEm: Date; canceladoEm: Date | null; orcamentoNumero: number | null }[]> {
  return db
    .select({
      id: cobranca.id,
      valorTotal: cobranca.valorTotal,
      criadoEm: cobranca.criadoEm,
      canceladoEm: cobranca.canceladoEm,
      orcamentoNumero: orcamento.numero,
    })
    .from(cobranca)
    .leftJoin(orcamento, eq(orcamento.id, cobranca.orcamentoId))
    .where(eq(cobranca.pacienteId, pacienteId))
    .orderBy(desc(cobranca.criadoEm))
}

// ── Painel ───────────────────────────────────────────────────────────────────

export interface PainelFinanceiro {
  readonly aReceber: string
  readonly emAtraso: string
  readonly recebidoNoMes: string
  readonly conciliadoNoMes: string
  readonly aguardandoConciliacao: string
  readonly parcelasVencidas: number
  readonly pacientesEmAtraso: number
  readonly hojeIso: string
}

/**
 * Números do painel.
 *
 * `aReceber` e `emAtraso` são deliberadamente separados: `aReceber` é tudo que
 * falta entrar, `emAtraso` só o que já venceu. Somar os dois num único número
 * faria a clínica parecer inadimplente no primeiro dia útil.
 */
export async function painelFinanceiro(ator: Ator): Promise<PainelFinanceiro> {
  const hojeIso = await hojeDaClinica()
  const inicioMes = `${hojeIso.slice(0, 7)}-01`

  const [aberto, recebido, aguardando] = await Promise.all([
    // Saldo em aberto por parcela, com o vencimento para separar o atraso.
    db
      .select({
        vencimento: parcela.vencimento,
        valor: parcela.valor,
        pacienteId: cobranca.pacienteId,
        pago: sql<string>`coalesce((
          select sum(pg.valor) from pagamento pg
          where pg.parcela_id = ${parcela.id} and pg.estornado_em is null
        ), 0)::text`,
      })
      .from(parcela)
      .innerJoin(cobranca, eq(cobranca.id, parcela.cobrancaId))
      .where(and(isNull(cobranca.canceladoEm), sql`${parcela.status} in ('aberta','parcial')`)),

    db
      .select({
        valor: pagamento.valor,
        conciliado: pagamento.conciliado,
      })
      .from(pagamento)
      .where(
        and(
          isNull(pagamento.estornadoEm),
          gte(pagamento.pagoEm, inicioMes),
          lte(pagamento.pagoEm, hojeIso),
        ),
      ),

    db
      .select({ valor: pagamento.valor })
      .from(pagamento)
      .where(and(isNull(pagamento.estornadoEm), eq(pagamento.conciliado, false))),
  ])

  const saldos = aberto.map((p) => ({
    saldo: subtrair(p.valor, p.pago),
    vencida: p.vencimento < hojeIso,
    pacienteId: p.pacienteId,
  }))

  const comSaldo = saldos.filter((s) => Number(s.saldo) > 0)
  const vencidas = comSaldo.filter((s) => s.vencida)

  const recebidoValores = recebido.map((r) => r.valor)
  const conciliadoValores = recebido.filter((r) => r.conciliado).map((r) => r.valor)

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'relatorio_financeiro',
    detalhes: { tipo: 'painel', mes: hojeIso.slice(0, 7) },
  })

  return {
    aReceber: comSaldo.length === 0 ? '0.00' : somar(...comSaldo.map((s) => s.saldo)),
    emAtraso: vencidas.length === 0 ? '0.00' : somar(...vencidas.map((s) => s.saldo)),
    recebidoNoMes: recebidoValores.length === 0 ? '0.00' : somar(...recebidoValores),
    conciliadoNoMes: conciliadoValores.length === 0 ? '0.00' : somar(...conciliadoValores),
    aguardandoConciliacao:
      aguardando.length === 0 ? '0.00' : somar(...aguardando.map((a) => a.valor)),
    parcelasVencidas: vencidas.length,
    pacientesEmAtraso: new Set(vencidas.map((v) => v.pacienteId)).size,
    hojeIso,
  }
}

export interface LinhaInadimplencia {
  readonly parcelaId: string
  readonly cobrancaId: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly pacienteTelefone: string | null
  readonly numero: number
  readonly vencimento: string
  readonly valor: string
  readonly saldo: string
  readonly diasAtraso: number
}

/** Parcelas vencidas com saldo, da mais antiga para a mais recente. */
export async function inadimplencia(ator: Ator): Promise<readonly LinhaInadimplencia[]> {
  const hojeIso = await hojeDaClinica()

  const linhas = await db
    .select({
      parcelaId: parcela.id,
      cobrancaId: parcela.cobrancaId,
      pacienteId: cobranca.pacienteId,
      pacienteNome: paciente.nome,
      pacienteTelefone: paciente.telefoneWhatsapp,
      numero: parcela.numero,
      vencimento: parcela.vencimento,
      valor: parcela.valor,
      pago: sql<string>`coalesce((
        select sum(pg.valor) from pagamento pg
        where pg.parcela_id = ${parcela.id} and pg.estornado_em is null
      ), 0)::text`,
    })
    .from(parcela)
    .innerJoin(cobranca, eq(cobranca.id, parcela.cobrancaId))
    .innerJoin(paciente, eq(paciente.id, cobranca.pacienteId))
    .where(
      and(
        isNull(cobranca.canceladoEm),
        sql`${parcela.status} in ('aberta','parcial')`,
        sql`${parcela.vencimento} < ${hojeIso}::date`,
      ),
    )
    .orderBy(asc(parcela.vencimento))

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'relatorio_financeiro',
    detalhes: { tipo: 'inadimplencia', linhas: linhas.length },
  })

  return linhas
    .map((l) => ({
      parcelaId: l.parcelaId,
      cobrancaId: l.cobrancaId,
      pacienteId: l.pacienteId,
      pacienteNome: l.pacienteNome,
      pacienteTelefone: l.pacienteTelefone,
      numero: l.numero,
      vencimento: l.vencimento,
      valor: l.valor,
      saldo: subtrair(l.valor, l.pago),
      diasAtraso: diasDeAtraso(
        { valor: l.valor, vencimento: l.vencimento, status: 'aberta', pagamentos: [] },
        hojeIso,
      ),
    }))
    .filter((l) => Number(l.saldo) > 0)
}

// ── Comissões ────────────────────────────────────────────────────────────────

export async function baseDaComissao(): Promise<BaseComissao> {
  // Sem `?? 'valor_recebido'`: a base da comissão é decisão fechada de CADA
  // clínica, e adivinhá-la calcularia a folha de pagamento pela regra de outra.
  const [linha] = await db
    .select({ base: clinica.baseComissao })
    .from(clinica)
    .where(DA_CLINICA_ATUAL)
  if (!linha) throw new Error('Clínica do contexto não encontrada ao ler a base da comissão.')
  return linha.base as BaseComissao
}

/**
 * Quem executou o quê numa cobrança, com o valor — a entrada do rateio.
 *
 * O caminho é longo de propósito e é o elo que a Fase 6 preparou:
 * cobrança → orçamento → linha do orçamento → item do plano → execução →
 * profissional. Sem `orcamento_item.item_plano_id` (guardado para
 * rastreabilidade) não haveria como atribuir comissão a ninguém.
 */
export async function execucoesDaCobranca(
  cobrancaId: string,
): Promise<readonly ExecucaoParaComissao[]> {
  const linhas = await db
    .select({
      profissionalId: profissional.id,
      profissionalNome: usuario.nome,
      comissaoPct: profissional.comissaoPct,
      valorExecutado: orcamentoItem.valorUnitario,
      quantidade: orcamentoItem.quantidade,
    })
    .from(cobranca)
    .innerJoin(orcamentoItem, eq(orcamentoItem.orcamentoId, cobranca.orcamentoId))
    .innerJoin(itemPlano, eq(itemPlano.id, orcamentoItem.itemPlanoId))
    .innerJoin(execucao, eq(execucao.itemPlanoId, itemPlano.id))
    .innerJoin(profissional, eq(profissional.id, execucao.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(eq(cobranca.id, cobrancaId))

  return linhas.map((l) => ({
    profissionalId: l.profissionalId,
    profissionalNome: l.profissionalNome,
    comissaoPct: l.comissaoPct,
    valorExecutado:
      l.quantidade > 1
        ? somar(...Array.from({ length: l.quantidade }, () => l.valorExecutado))
        : l.valorExecutado,
  }))
}

export interface ComissaoDoPeriodo {
  readonly base: BaseComissao
  readonly deIso: string
  readonly ateIso: string
  readonly porProfissional: ReturnType<typeof consolidarPorProfissional>
  readonly totalBase: string
  readonly totalComissao: string
  readonly cobrancasConsideradas: number
}

/**
 * Comissão do período.
 *
 * Só entra o que foi **conciliado** dentro do período. Um pagamento de setembro
 * conciliado em outubro conta em outubro — é quando o dinheiro virou dinheiro.
 */
export async function comissaoDoPeriodo(
  ator: Ator,
  deIso: string,
  ateIso: string,
): Promise<ComissaoDoPeriodo> {
  const base = await baseDaComissao()

  // Cobranças com pagamento conciliado no período.
  const linhas = await db
    .selectDistinct({ cobrancaId: parcela.cobrancaId })
    .from(pagamento)
    .innerJoin(parcela, eq(parcela.id, pagamento.parcelaId))
    .innerJoin(cobranca, eq(cobranca.id, parcela.cobrancaId))
    .where(
      and(
        isNull(pagamento.estornadoEm),
        eq(pagamento.conciliado, true),
        gte(pagamento.pagoEm, deIso),
        lte(pagamento.pagoEm, ateIso),
        isNull(cobranca.canceladoEm),
      ),
    )

  const rateios: Awaited<ReturnType<typeof ratearComissao>>[] = []

  for (const { cobrancaId } of linhas) {
    const [execucoes, recebidoNoPeriodo] = await Promise.all([
      execucoesDaCobranca(cobrancaId),
      // Só o conciliado dentro da janela.
      db
        .select({ valor: pagamento.valor })
        .from(pagamento)
        .innerJoin(parcela, eq(parcela.id, pagamento.parcelaId))
        .where(
          and(
            eq(parcela.cobrancaId, cobrancaId),
            isNull(pagamento.estornadoEm),
            eq(pagamento.conciliado, true),
            gte(pagamento.pagoEm, deIso),
            lte(pagamento.pagoEm, ateIso),
          ),
        ),
    ])

    if (execucoes.length === 0) continue
    const recebido =
      recebidoNoPeriodo.length === 0 ? '0.00' : somar(...recebidoNoPeriodo.map((r) => r.valor))

    rateios.push(ratearComissao({ execucoes, recebido }))
  }

  const porProfissional = consolidarPorProfissional(rateios)

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'relatorio_financeiro',
    detalhes: { tipo: 'comissao', de: deIso, ate: ateIso, cobrancas: rateios.length },
  })

  return {
    base,
    deIso,
    ateIso,
    porProfissional,
    totalBase:
      porProfissional.length === 0 ? '0.00' : somar(...porProfissional.map((p) => p.baseDeCalculo)),
    totalComissao:
      porProfissional.length === 0 ? '0.00' : somar(...porProfissional.map((p) => p.comissao)),
    cobrancasConsideradas: rateios.length,
  }
}

/** Orçamentos aprovados que ainda não geraram cobrança. */
export async function orcamentosAFaturar(
  ator: Ator,
): Promise<readonly { id: string; numero: number; pacienteId: string; pacienteNome: string; valorTotal: string; decididoEm: Date | null }[]> {
  const linhas = await db
    .select({
      id: orcamento.id,
      numero: orcamento.numero,
      pacienteId: orcamento.pacienteId,
      pacienteNome: paciente.nome,
      valorTotal: orcamento.valorTotal,
      decididoEm: orcamento.decididoEm,
    })
    .from(orcamento)
    .innerJoin(paciente, eq(paciente.id, orcamento.pacienteId))
    .where(
      and(
        eq(orcamento.status, 'aprovado'),
        sql`not exists (
          select 1 from cobranca c
          where c.orcamento_id = ${orcamento.id} and c.cancelado_em is null
        )`,
      ),
    )
    .orderBy(asc(orcamento.decididoEm))

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'relatorio_financeiro',
    detalhes: { tipo: 'a_faturar', linhas: linhas.length },
  })

  return linhas
}

export { hojeDaClinica }
