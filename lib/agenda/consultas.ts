import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  agendamento,
  bloqueioAgenda,
  cadeira,
  clinica,
  paciente,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { addDias } from '@/lib/domain/datas'
import { FUSO_PADRAO, inicioDoDia, minutosDoDia } from '@/lib/domain/fuso'
import {
  type DiaSemana,
  HORARIO_PADRAO,
  type HorarioFuncionamento,
  dentroDoFuncionamento,
  horariosPossiveis,
} from '@/lib/domain/horario'
import { STATUS_OCUPAM_AGENDA, type StatusAgendamento, conflita } from '@/lib/domain/agendamento'
import { type SQL, and, asc, eq, gte, lt, or, sql } from 'drizzle-orm'

/**
 * Consultas da agenda.
 *
 * Como em `lib/pacientes/consultas.ts`, o `Ator` é parâmetro obrigatório e toda
 * leitura vai para a trilha — a agenda expõe nome de paciente, que é dado
 * pessoal, e quem atende quem já é informação clínica.
 */

export interface ConfiguracaoAgenda {
  readonly fuso: string
  readonly horario: HorarioFuncionamento
  readonly passoMin: number
}

/** Configuração da clínica, com defaults se a linha singleton não existir. */
export async function configuracaoAgenda(): Promise<ConfiguracaoAgenda> {
  const [linha] = await db
    .select({
      fuso: clinica.fusoHorario,
      horario: clinica.horarioFuncionamento,
      passo: clinica.passoAgendaMinutos,
    })
    .from(clinica)
    .limit(1)

  return {
    fuso: linha?.fuso ?? FUSO_PADRAO,
    horario: (linha?.horario as HorarioFuncionamento | undefined) ?? HORARIO_PADRAO,
    passoMin: linha?.passo ?? 15,
  }
}

export interface AgendamentoNaGrade {
  readonly id: string
  readonly inicio: Date
  readonly fim: Date
  readonly status: StatusAgendamento
  readonly origem: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly pacienteTelefone: string | null
  readonly profissionalId: string
  readonly profissionalNome: string
  readonly cadeiraId: string | null
  readonly cadeiraNome: string | null
  readonly observacao: string | null
  readonly confirmadoEm: Date | null
  readonly chegouEm: Date | null
}

export interface BloqueioNaGrade {
  readonly id: string
  readonly inicio: Date
  readonly fim: Date
  readonly motivo: string
  readonly profissionalId: string | null
  readonly cadeiraId: string | null
}

export interface OpcaoProfissional {
  readonly id: string
  readonly nome: string
  readonly especialidade: string | null
}

export interface DadosAgenda {
  readonly config: ConfiguracaoAgenda
  readonly agendamentos: readonly AgendamentoNaGrade[]
  readonly bloqueios: readonly BloqueioNaGrade[]
  readonly profissionais: readonly OpcaoProfissional[]
  readonly cadeiras: readonly { id: string; nome: string }[]
}

/**
 * Tudo o que a grade precisa, num intervalo de dias locais.
 *
 * O filtro usa instantes derivados do fuso da clínica, não `date_trunc` no
 * banco: o Postgres truncaria no fuso da SESSÃO, e a coluna do dia sairia
 * errada para quem acessa de outro lugar.
 */
export async function dadosDaAgenda(
  ator: Ator,
  {
    deIso,
    ateIso,
    profissionalId,
  }: { deIso: string; ateIso: string; profissionalId?: string | undefined },
): Promise<DadosAgenda> {
  const config = await configuracaoAgenda()

  const de = inicioDoDia(deIso, config.fuso)
  // `ate` exclusivo: início do dia seguinte ao último dia mostrado.
  const ate = inicioDoDia(addDias(ateIso, 1), config.fuso)

  const condicoes: SQL[] = [gte(agendamento.inicio, de), lt(agendamento.inicio, ate)]
  if (profissionalId) condicoes.push(eq(agendamento.profissionalId, profissionalId))

  const [linhas, bloqueios, profissionais, cadeiras] = await Promise.all([
    db
      .select({
        id: agendamento.id,
        inicio: agendamento.inicio,
        fim: agendamento.fim,
        status: agendamento.status,
        origem: agendamento.origem,
        pacienteId: agendamento.pacienteId,
        pacienteNome: paciente.nome,
        pacienteTelefone: paciente.telefoneWhatsapp,
        profissionalId: agendamento.profissionalId,
        profissionalNome: usuario.nome,
        cadeiraId: agendamento.cadeiraId,
        cadeiraNome: cadeira.nome,
        observacao: agendamento.observacao,
        confirmadoEm: agendamento.confirmadoEm,
        chegouEm: agendamento.chegouEm,
      })
      .from(agendamento)
      .innerJoin(paciente, eq(paciente.id, agendamento.pacienteId))
      .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
      .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
      .leftJoin(cadeira, eq(cadeira.id, agendamento.cadeiraId))
      .where(and(...condicoes))
      .orderBy(asc(agendamento.inicio)),

    db
      .select({
        id: bloqueioAgenda.id,
        inicio: bloqueioAgenda.inicio,
        fim: bloqueioAgenda.fim,
        motivo: bloqueioAgenda.motivo,
        profissionalId: bloqueioAgenda.profissionalId,
        cadeiraId: bloqueioAgenda.cadeiraId,
      })
      .from(bloqueioAgenda)
      // Bloqueio que ATRAVESSA a janela também importa (férias de duas semanas).
      .where(and(lt(bloqueioAgenda.inicio, ate), gte(bloqueioAgenda.fim, de)))
      .orderBy(asc(bloqueioAgenda.inicio)),

    profissionaisAtivos(),

    db
      .select({ id: cadeira.id, nome: cadeira.nome })
      .from(cadeira)
      .where(eq(cadeira.ativo, true))
      .orderBy(asc(cadeira.ordem), asc(cadeira.nome)),
  ])

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'agendamento',
    detalhes: {
      tipo: 'grade',
      de: deIso,
      ate: ateIso,
      profissionalId: profissionalId ?? undefined,
      resultados: linhas.length,
    },
  })

  return {
    config,
    agendamentos: linhas as readonly AgendamentoNaGrade[],
    bloqueios,
    profissionais,
    cadeiras,
  }
}

export async function profissionaisAtivos(): Promise<readonly OpcaoProfissional[]> {
  return db
    .select({
      id: profissional.id,
      nome: usuario.nome,
      especialidade: profissional.especialidade,
    })
    .from(profissional)
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(and(eq(profissional.ativo, true), eq(usuario.ativo, true)))
    .orderBy(asc(usuario.nome))
}

export async function acharAgendamento(
  ator: Ator,
  id: string,
): Promise<AgendamentoNaGrade | null> {
  const [linha] = await db
    .select({
      id: agendamento.id,
      inicio: agendamento.inicio,
      fim: agendamento.fim,
      status: agendamento.status,
      origem: agendamento.origem,
      pacienteId: agendamento.pacienteId,
      pacienteNome: paciente.nome,
      pacienteTelefone: paciente.telefoneWhatsapp,
      profissionalId: agendamento.profissionalId,
      profissionalNome: usuario.nome,
      cadeiraId: agendamento.cadeiraId,
      cadeiraNome: cadeira.nome,
      observacao: agendamento.observacao,
      confirmadoEm: agendamento.confirmadoEm,
      chegouEm: agendamento.chegouEm,
    })
    .from(agendamento)
    .innerJoin(paciente, eq(paciente.id, agendamento.pacienteId))
    .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .leftJoin(cadeira, eq(cadeira.id, agendamento.cadeiraId))
    .where(eq(agendamento.id, id))
    .limit(1)

  if (!linha) return null

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'agendamento',
    entidadeId: id,
    pacienteId: linha.pacienteId,
  })

  return linha as AgendamentoNaGrade
}

export interface HorarioLivre {
  /** 'HH:MM' local. */
  readonly hora: string
  readonly inicio: Date
  readonly fim: Date
}

/**
 * Horários livres de um profissional num dia.
 *
 * Filtra em três camadas, e a ordem importa para a mensagem que a recepção vê:
 *   1. horário de funcionamento — o atendimento inteiro tem que caber na faixa;
 *   2. bloqueios — férias, almoço extra, manutenção da cadeira;
 *   3. agendamentos que ocupam a agenda (cancelado e falta liberam).
 *
 * Isto é conveniência de UI. A garantia contra dupla marcação é a EXCLUDE
 * constraint no banco: duas recepcionistas escolhendo às 09:00 ao mesmo tempo
 * passam as duas por esta função, e só uma sobrevive ao COMMIT.
 */
export async function horariosLivres({
  diaIso,
  profissionalId,
  duracaoMin,
  cadeiraId,
  ignorarAgendamentoId,
}: {
  diaIso: string
  profissionalId: string
  duracaoMin: number
  cadeiraId?: string | undefined
  ignorarAgendamentoId?: string | undefined
}): Promise<readonly HorarioLivre[]> {
  const config = await configuracaoAgenda()
  const diaSemana = new Date(`${diaIso}T00:00:00Z`).getUTCDay() as DiaSemana

  const candidatos = horariosPossiveis({
    horario: config.horario,
    diaSemana,
    duracaoMin,
    passoMin: config.passoMin,
  })
  if (candidatos.length === 0) return []

  const de = inicioDoDia(diaIso, config.fuso)
  const ate = inicioDoDia(addDias(diaIso, 1), config.fuso)

  const [ocupados, bloqueios] = await Promise.all([
    db
      .select({
        id: agendamento.id,
        inicio: agendamento.inicio,
        fim: agendamento.fim,
        status: agendamento.status,
        cadeiraId: agendamento.cadeiraId,
        profissionalId: agendamento.profissionalId,
      })
      .from(agendamento)
      .where(
        and(
          gte(agendamento.inicio, de),
          lt(agendamento.inicio, ate),
          cadeiraId
            ? or(
                eq(agendamento.profissionalId, profissionalId),
                eq(agendamento.cadeiraId, cadeiraId),
              )
            : eq(agendamento.profissionalId, profissionalId),
        ),
      ),

    db
      .select({
        inicio: bloqueioAgenda.inicio,
        fim: bloqueioAgenda.fim,
        profissionalId: bloqueioAgenda.profissionalId,
        cadeiraId: bloqueioAgenda.cadeiraId,
      })
      .from(bloqueioAgenda)
      .where(and(lt(bloqueioAgenda.inicio, ate), gte(bloqueioAgenda.fim, de))),
  ])

  const ativos = ocupados.filter(
    (o) =>
      o.id !== ignorarAgendamentoId &&
      STATUS_OCUPAM_AGENDA.includes(o.status as StatusAgendamento),
  )

  const bloqueiosRelevantes = bloqueios.filter(
    (b) =>
      // Bloqueio geral da clínica, ou do profissional, ou da cadeira escolhida.
      (b.profissionalId === null && b.cadeiraId === null) ||
      b.profissionalId === profissionalId ||
      (cadeiraId !== undefined && b.cadeiraId === cadeiraId),
  )

  const livres: HorarioLivre[] = []

  for (const minutoInicio of candidatos) {
    const inicio = new Date(de.getTime() + minutoInicio * 60_000)
    const fim = new Date(inicio.getTime() + duracaoMin * 60_000)

    // Confere de novo contra o funcionamento usando os minutos LOCAIS reais:
    // protege contra virada de horário de verão no meio do dia.
    if (
      !dentroDoFuncionamento(
        config.horario,
        diaSemana,
        minutosDoDia(inicio, config.fuso),
        minutosDoDia(inicio, config.fuso) + duracaoMin,
      )
    ) {
      continue
    }

    const candidato = { inicio, fim }
    if (bloqueiosRelevantes.some((b) => conflita(candidato, b))) continue
    if (ativos.some((a) => conflita(candidato, a))) continue

    livres.push({
      hora: `${String(Math.floor(minutoInicio / 60)).padStart(2, '0')}:${String(minutoInicio % 60).padStart(2, '0')}`,
      inicio,
      fim,
    })
  }

  return livres
}

/** Duração sugerida a partir do catálogo, para pré-preencher o formulário. */
export async function duracaoSugerida(procedimentoId: string): Promise<number | null> {
  const [linha] = await db
    .select({ duracao: procedimento.duracaoMinutos })
    .from(procedimento)
    .where(eq(procedimento.id, procedimentoId))
    .limit(1)
  return linha?.duracao ?? null
}

export async function procedimentosParaAgenda(): Promise<
  readonly { id: string; nome: string; duracaoMinutos: number }[]
> {
  return db
    .select({
      id: procedimento.id,
      nome: procedimento.nome,
      duracaoMinutos: procedimento.duracaoMinutos,
    })
    .from(procedimento)
    .where(eq(procedimento.ativo, true))
    .orderBy(asc(procedimento.nome))
}

/** Contagem por status no período — alimenta o resumo do cabeçalho. */
export async function resumoDoPeriodo(
  deIso: string,
  ateIso: string,
): Promise<Readonly<Record<string, number>>> {
  const config = await configuracaoAgenda()
  const de = inicioDoDia(deIso, config.fuso)
  const ate = inicioDoDia(addDias(ateIso, 1), config.fuso)

  const linhas = await db
    .select({ status: agendamento.status, total: sql<number>`count(*)::int` })
    .from(agendamento)
    .where(and(gte(agendamento.inicio, de), lt(agendamento.inicio, ate)))
    .groupBy(agendamento.status)

  return Object.fromEntries(linhas.map((l) => [l.status, l.total]))
}
