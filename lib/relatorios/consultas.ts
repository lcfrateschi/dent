import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  agendamento,
  clinica,
  execucao,
  itemPlano,
  pagamento,
  paciente,
  planoTratamento,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { somar } from '@/lib/domain/dinheiro'
import { FUSO_PADRAO, inicioDoDia, partesLocais } from '@/lib/domain/fuso'
import {
  type DiaSemana,
  type HorarioFuncionamento,
  minutosDisponiveis,
} from '@/lib/domain/horario'
import {
  type Comparecimento,
  type EfeitoConfirmacao,
  type Ocupacao,
  calcularComparecimento,
  calcularEfeitoConfirmacao,
  calcularOcupacao,
  ticketMedio,
} from '@/lib/domain/indicadores'
import { type Periodo, diaSemanaDe, diasDoPeriodo } from '@/lib/domain/periodo'
import { addDias } from '@/lib/domain/datas'
import { and, eq, gte, isNull, lt, lte, sql } from 'drizzle-orm'

/**
 * Agregações dos relatórios.
 *
 * **A regra que organiza este arquivo: caixa e produção são consultas separadas,
 * e não existe função que devolva a soma das duas.** O que foi executado (produção
 * do dentista) e o que entrou no caixa (dinheiro) andam em ritmos diferentes — um
 * tratamento executado em julho pode ser recebido em outubro. Um "faturamento"
 * que junta os dois responde a pergunta de ninguém, e é o erro mais comum em
 * painel de clínica.
 *
 * A comissão da clínica é sobre **valor recebido** (decisão fechada), o que torna
 * a separação ainda mais concreta: produção alta com caixa baixo significa
 * comissão que ainda não venceu, não comissão devida.
 *
 * ── Fuso ────────────────────────────────────────────────────────────────────
 * O período é data civil; a agenda é `timestamptz`. A conversão acontece aqui,
 * uma vez, pelo fuso da clínica — e o `ate` é convertido para a meia-noite do dia
 * SEGUINTE, com comparação `<`, porque o intervalo do relatório é fechado nas duas
 * pontas e o do banco não.
 */

async function fusoDaClinica(): Promise<string> {
  const [c] = await db.select({ fuso: clinica.fusoHorario }).from(clinica).limit(1)
  return c?.fuso ?? FUSO_PADRAO
}

async function configuracaoDaClinica(): Promise<{
  fuso: string
  horario: HorarioFuncionamento
}> {
  const [c] = await db
    .select({ fuso: clinica.fusoHorario, horario: clinica.horarioFuncionamento })
    .from(clinica)
    .limit(1)
  return {
    fuso: c?.fuso ?? FUSO_PADRAO,
    horario: (c?.horario ?? {}) as HorarioFuncionamento,
  }
}

/** Instantes que delimitam o período no banco. `fim` é exclusivo. */
function limites(p: Periodo, fuso: string): { inicio: Date; fim: Date } {
  return { inicio: inicioDoDia(p.de, fuso), fim: inicioDoDia(addDias(p.ate, 1), fuso) }
}

// ── Caixa ────────────────────────────────────────────────────────────────────

export interface Caixa {
  /** Tudo que entrou no período, conciliado ou não. */
  readonly recebido: string
  /** Só o que foi conferido no extrato. É a base da comissão. */
  readonly conciliado: string
  readonly aguardandoConciliacao: string
  readonly ticketMedioCentavos: number | null
  readonly pacientesQuePagaram: number
  readonly porForma: readonly { readonly forma: string; readonly valor: string; readonly n: number }[]
}

/**
 * O que entrou no caixa no período.
 *
 * `pago_em` é `date` (dia civil), então a comparação é direta com o período — sem
 * conversão de fuso, porque a data de pagamento é um dia, não um instante.
 */
export async function caixaDoPeriodo(p: Periodo): Promise<Caixa> {
  const linhas = await db
    .select({
      valor: pagamento.valor,
      conciliado: pagamento.conciliado,
      meio: pagamento.meio,
      pacienteId: sql<string>`(
        select c.paciente_id from cobranca c
        join parcela pa on pa.cobranca_id = c.id
        where pa.id = ${pagamento.parcelaId}
      )`,
    })
    .from(pagamento)
    .where(
      and(
        isNull(pagamento.estornadoEm),
        gte(pagamento.pagoEm, p.de),
        lte(pagamento.pagoEm, p.ate),
      ),
    )

  const [aguardando] = await db
    .select({
      total: sql<string>`coalesce(sum(${pagamento.valor}), 0)::text`,
    })
    .from(pagamento)
    .where(and(isNull(pagamento.estornadoEm), eq(pagamento.conciliado, false)))

  const recebido = soma(linhas.map((l) => l.valor))
  const conciliado = soma(linhas.filter((l) => l.conciliado).map((l) => l.valor))

  const porForma = new Map<string, { valores: string[]; n: number }>()
  for (const l of linhas) {
    const atual = porForma.get(l.meio) ?? { valores: [], n: 0 }
    atual.valores.push(l.valor)
    atual.n++
    porForma.set(l.meio, atual)
  }

  const pacientes = new Set(linhas.map((l) => l.pacienteId).filter(Boolean))

  return {
    recebido,
    conciliado,
    aguardandoConciliacao: aguardando?.total ?? '0.00',
    ticketMedioCentavos: ticketMedio(
      Math.round(Number(recebido) * 100),
      pacientes.size,
    ),
    pacientesQuePagaram: pacientes.size,
    porForma: [...porForma.entries()]
      .map(([forma, v]) => ({ forma, valor: soma(v.valores), n: v.n }))
      .sort((a, b) => Number(b.valor) - Number(a.valor)),
  }
}

// ── Produção ─────────────────────────────────────────────────────────────────

export interface Producao {
  /** Valor dos procedimentos executados no período. Não é caixa. */
  readonly valorExecutado: string
  readonly execucoes: number
  readonly pacientesAtendidos: number
  readonly porProfissional: readonly {
    readonly profissionalId: string
    readonly nome: string
    readonly valor: string
    readonly execucoes: number
  }[]
}

/**
 * Produção clínica do período: o que foi feito, por quem, valendo quanto.
 *
 * O valor vem de `item_plano.valor` — o preço acordado com o paciente quando o
 * plano foi montado —, não do catálogo de hoje. Um procedimento executado em
 * janeiro vale o que valia em janeiro, e o catálogo muda.
 */
export async function producaoDoPeriodo(p: Periodo): Promise<Producao> {
  const fuso = await fusoDaClinica()
  const { inicio, fim } = limites(p, fuso)

  const linhas = await db
    .select({
      profissionalId: execucao.profissionalId,
      nome: usuario.nome,
      valor: itemPlano.valor,
      // O paciente vem do PLANO: `item_plano` não repete a coluna, e é assim que
      // as quatro entidades ficam distintas (ver CLAUDE.md).
      pacienteId: planoTratamento.pacienteId,
    })
    .from(execucao)
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(profissional, eq(profissional.id, execucao.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(and(gte(execucao.executadoEm, inicio), lt(execucao.executadoEm, fim)))

  const porProfissional = new Map<string, { nome: string; valores: string[]; n: number }>()
  for (const l of linhas) {
    const atual = porProfissional.get(l.profissionalId) ?? { nome: l.nome, valores: [], n: 0 }
    atual.valores.push(l.valor)
    atual.n++
    porProfissional.set(l.profissionalId, atual)
  }

  return {
    valorExecutado: soma(linhas.map((l) => l.valor)),
    execucoes: linhas.length,
    pacientesAtendidos: new Set(linhas.map((l) => l.pacienteId)).size,
    porProfissional: [...porProfissional.entries()]
      .map(([profissionalId, v]) => ({
        profissionalId,
        nome: v.nome,
        valor: soma(v.valores),
        execucoes: v.n,
      }))
      .sort((a, b) => Number(b.valor) - Number(a.valor)),
  }
}

/** Procedimentos mais executados no período. */
export async function procedimentosMaisExecutados(p: Periodo, limite = 15) {
  const fuso = await fusoDaClinica()
  const { inicio, fim } = limites(p, fuso)

  return db
    .select({
      procedimentoId: procedimento.id,
      nome: procedimento.nome,
      codigo: procedimento.codigo,
      execucoes: sql<number>`count(*)::int`,
      valor: sql<string>`coalesce(sum(${itemPlano.valor}), 0)::text`,
    })
    .from(execucao)
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .where(and(gte(execucao.executadoEm, inicio), lt(execucao.executadoEm, fim)))
    .groupBy(procedimento.id, procedimento.nome, procedimento.codigo)
    .orderBy(sql`count(*) desc`)
    .limit(limite)
}

// ── Agenda ───────────────────────────────────────────────────────────────────

export interface RelatorioAgenda {
  readonly ocupacao: Ocupacao
  readonly comparecimento: Comparecimento
  readonly efeitoConfirmacao: EfeitoConfirmacao
  readonly porProfissional: readonly {
    readonly nome: string
    readonly minutosReservados: number
    readonly concluidos: number
    readonly faltas: number
  }[]
  /** Faltas por dia da semana — mostra em qual dia a cadeira esvazia. */
  readonly faltasPorDiaSemana: readonly { readonly diaSemana: number; readonly faltas: number; readonly total: number }[]
  /** Faltas por hora do dia. O primeiro horário da manhã é o suspeito de sempre. */
  readonly faltasPorHora: readonly { readonly hora: number; readonly faltas: number; readonly total: number }[]
}

/**
 * Relatório de agenda: ocupação, faltas e o efeito da confirmação.
 *
 * A ocupação divide pelos minutos que a clínica **tinha disponíveis**, calculados
 * a partir do horário de funcionamento configurado × dias do período × número de
 * profissionais ativos. Dividir por 24h daria uma taxa bonita e inútil; dividir
 * sem contar profissional faria duas cadeiras parecerem 200% ocupadas.
 */
export async function relatorioDeAgenda(p: Periodo, agora: Date): Promise<RelatorioAgenda> {
  const { fuso, horario } = await configuracaoDaClinica()
  const { inicio, fim } = limites(p, fuso)

  const [linhas, [contagem]] = await Promise.all([
    db
      .select({
        inicio: agendamento.inicio,
        fim: agendamento.fim,
        status: agendamento.status,
        confirmadoEm: agendamento.confirmadoEm,
        profissionalNome: usuario.nome,
      })
      .from(agendamento)
      .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
      .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
      .where(and(gte(agendamento.inicio, inicio), lt(agendamento.inicio, fim))),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(profissional)
      .where(eq(profissional.ativo, true)),
  ])

  const profissionaisAtivos = Math.max(1, contagem?.n ?? 1)

  // Minutos disponíveis: horário de funcionamento de cada dia do período, vezes
  // o número de profissionais que podiam atender.
  const disponiveisPorDia = diasDoPeriodo(p).reduce(
    (acc, dia) => acc + minutosDisponiveis(horario, diaSemanaDe(dia) as DiaSemana),
    0,
  )
  const totalDisponivel = disponiveisPorDia * profissionaisAtivos

  let minutosReservados = 0
  let minutosRealizados = 0
  let minutosPerdidos = 0
  let concluidos = 0
  let faltas = 0
  let cancelados = 0
  let futuros = 0

  const porProfissional = new Map<
    string,
    { minutosReservados: number; concluidos: number; faltas: number }
  >()
  const porDia = new Map<number, { faltas: number; total: number }>()
  const porHora = new Map<number, { faltas: number; total: number }>()

  const efeito = {
    confirmadosQueVieram: 0,
    confirmadosQueFaltaram: 0,
    naoConfirmadosQueVieram: 0,
    naoConfirmadosQueFaltaram: 0,
  }


  for (const a of linhas) {
    const minutos = Math.max(
      0,
      Math.round((a.fim.getTime() - a.inicio.getTime()) / 60_000),
    )

    if (a.status === 'cancelado') {
      cancelados++
      continue
    }

    // Cancelado não reserva agenda; todo o resto reserva — inclusive a falta, que
    // é justamente o horário que ficou vazio sem liberar.
    minutosReservados += minutos

    const doProfissional =
      porProfissional.get(a.profissionalNome) ?? { minutosReservados: 0, concluidos: 0, faltas: 0 }
    doProfissional.minutosReservados += minutos

    // Hora e dia da semana LOCAIS da clínica, por `partesLocais` — nunca por
    // parse de data formatada nem por `getDay()` do servidor: os dois dariam
    // resposta diferente conforme onde o relatório roda.
    const local = partesLocais(a.inicio, fuso)
    const hora = local.hora
    const diaSemana = local.diaSemana

    const doDia = porDia.get(diaSemana) ?? { faltas: 0, total: 0 }
    const daHora = porHora.get(hora) ?? { faltas: 0, total: 0 }
    doDia.total++
    daHora.total++

    if (a.status === 'concluido') {
      concluidos++
      minutosRealizados += minutos
      doProfissional.concluidos++
      if (a.confirmadoEm) efeito.confirmadosQueVieram++
      else efeito.naoConfirmadosQueVieram++
    } else if (a.status === 'faltou') {
      faltas++
      minutosPerdidos += minutos
      doProfissional.faltas++
      doDia.faltas++
      daHora.faltas++
      if (a.confirmadoEm) efeito.confirmadosQueFaltaram++
      else efeito.naoConfirmadosQueFaltaram++
    } else if (a.inicio.getTime() > agora.getTime()) {
      // Ainda vai acontecer: fica fora das taxas.
      futuros++
    } else {
      // Horário passou e ninguém deu baixa. Não é falta nem atendimento — é
      // agenda mal fechada, e contar como qualquer um dos dois falsearia a taxa.
      minutosRealizados += 0
    }

    porProfissional.set(a.profissionalNome, doProfissional)
    porDia.set(diaSemana, doDia)
    porHora.set(hora, daHora)
  }

  return {
    ocupacao: calcularOcupacao({
      minutosDisponiveis: totalDisponivel,
      minutosReservados,
      minutosRealizados,
      minutosPerdidosPorFalta: minutosPerdidos,
    }),
    comparecimento: calcularComparecimento({ concluidos, faltas, cancelados, futuros }),
    efeitoConfirmacao: calcularEfeitoConfirmacao(efeito),
    porProfissional: [...porProfissional.entries()]
      .map(([nome, v]) => ({ nome, ...v }))
      .sort((a, b) => b.minutosReservados - a.minutosReservados),
    faltasPorDiaSemana: [...porDia.entries()]
      .map(([diaSemana, v]) => ({ diaSemana, ...v }))
      .sort((a, b) => a.diaSemana - b.diaSemana),
    faltasPorHora: [...porHora.entries()]
      .map(([hora, v]) => ({ hora, ...v }))
      .sort((a, b) => a.hora - b.hora),
  }
}

// ── Pacientes ────────────────────────────────────────────────────────────────

export interface RelatorioPacientes {
  readonly novos: number
  readonly ativos: number
  /** Como conheceram a clínica. Alimenta a decisão de onde investir. */
  readonly porOrigem: readonly { readonly origem: string; readonly n: number }[]
}

export async function relatorioDePacientes(p: Periodo): Promise<RelatorioPacientes> {
  const fuso = await fusoDaClinica()
  const { inicio, fim } = limites(p, fuso)

  const [novos, origens, [ativos]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(paciente)
      .where(and(gte(paciente.criadoEm, inicio), lt(paciente.criadoEm, fim))),

    db
      .select({
        origem: sql<string>`coalesce(nullif(btrim(${paciente.indicadoPor}), ''), 'não informado')`,
        n: sql<number>`count(*)::int`,
      })
      .from(paciente)
      .where(and(gte(paciente.criadoEm, inicio), lt(paciente.criadoEm, fim)))
      .groupBy(sql`coalesce(nullif(btrim(${paciente.indicadoPor}), ''), 'não informado')`)
      .orderBy(sql`count(*) desc`),

    db
      .select({ n: sql<number>`count(*)::int` })
      .from(paciente)
      .where(eq(paciente.status, 'ativo')),
  ])

  return {
    novos: novos[0]?.n ?? 0,
    ativos: ativos?.n ?? 0,
    porOrigem: origens,
  }
}

// ── Painel ───────────────────────────────────────────────────────────────────

export interface Painel {
  readonly periodo: Periodo
  readonly caixa: Caixa
  readonly producao: Producao
  readonly agenda: RelatorioAgenda
  readonly pacientes: RelatorioPacientes
}

/**
 * Monta o painel de um período.
 *
 * Registra a leitura na auditoria como `relatorio_financeiro` quando inclui caixa
 * — é dado agregado, mas ainda é dado da clínica, e saber quem consultou o
 * faturamento é parte do controle.
 */
export async function montarPainel(ator: Ator, p: Periodo, agora: Date): Promise<Painel> {
  const [caixa, producao, agenda, pacientes] = await Promise.all([
    caixaDoPeriodo(p),
    producaoDoPeriodo(p),
    relatorioDeAgenda(p, agora),
    relatorioDePacientes(p),
  ])

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'relatorio_financeiro',
    detalhes: { tipo: 'painel', de: p.de, ate: p.ate },
  })

  return { periodo: p, caixa, producao, agenda, pacientes }
}

function soma(valores: readonly string[]): string {
  return valores.length === 0 ? '0.00' : somar(...valores)
}
