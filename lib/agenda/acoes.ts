'use server'

import { registrar } from '@/lib/auditoria/registrar'
import { SemPermissao, SemSessao, exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { agendamento, bloqueioAgenda } from '@/lib/db/schema'
import { addDias, addMeses } from '@/lib/domain/datas'
import {
  type StatusAgendamento,
  exigirIntervaloValido,
  exigirTransicao,
} from '@/lib/domain/agendamento'
import { instanteDe } from '@/lib/domain/fuso'
import { type DiaSemana, dentroDoFuncionamento } from '@/lib/domain/horario'
import { hhmmParaMinutos } from '@/lib/domain/fuso'
import { ErroDominio } from '@/lib/domain/erros'
import { type ErrosCampo, achatarErros, dosCampos } from '@/lib/pacientes/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { configuracaoAgenda } from './consultas'
import { agendamentoSchema, bloqueioSchema } from './schema'

/**
 * Ações da agenda. Mesmo padrão das de paciente:
 * permissão → validação → persistência → auditoria.
 *
 * ── Sobre conflito de horário ───────────────────────────────────────────────
 * Não há checagem prévia em memória aqui, de propósito. A EXCLUDE constraint do
 * banco é a autoridade, e ela **ganha a corrida** que a aplicação perde: duas
 * recepcionistas marcando o mesmo horário ao mesmo tempo passariam as duas por
 * qualquer verificação prévia. O que fazemos é traduzir o erro `23P01` numa
 * mensagem que a pessoa entende.
 */

export type ResultadoAgenda =
  | { ok: true; ids: readonly string[] }
  | { ok: false; erros: ErrosCampo; mensagem?: string }

export async function criarAgendamento(
  _anterior: ResultadoAgenda | null,
  dados: FormData,
): Promise<ResultadoAgenda> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('agenda', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const analise = agendamentoSchema.safeParse(dosCampos(dados))
  if (!analise.success) return { ok: false, erros: achatarErros(analise.error) }

  const v = analise.data
  const config = await configuracaoAgenda()

  // Datas de todas as ocorrências. Recorrência só entra se `repetir` vier.
  const dias = diasDaRecorrencia(v.dia, v.repetir ?? null, v.repeticoes)

  try {
    const criados: string[] = []

    // Uma transação: recorrência é tudo ou nada. Metade das sessões de
    // manutenção ortodôntica agendadas é pior do que nenhuma, porque ninguém
    // percebe o buraco até o paciente não aparecer.
    await db.transaction(async (tx) => {
      for (const dia of dias) {
        const inicio = instanteDe(dia, v.hora, config.fuso)
        const fim = new Date(inicio.getTime() + v.duracaoMinutos * 60_000)
        exigirIntervaloValido({ inicio, fim })

        const diaSemana = new Date(`${dia}T00:00:00Z`).getUTCDay() as DiaSemana
        const inicioMin = hhmmParaMinutos(v.hora)
        if (
          !dentroDoFuncionamento(config.horario, diaSemana, inicioMin, inicioMin + v.duracaoMinutos)
        ) {
          throw new ErroDominio(
            'FORA_DO_FUNCIONAMENTO',
            `${dia} às ${v.hora} está fora do horário de atendimento da clínica (ou atravessa o intervalo).`,
            { dia },
          )
        }

        const [criado] = await tx
          .insert(agendamento)
          .values({
            pacienteId: v.pacienteId,
            profissionalId: v.profissionalId,
            cadeiraId: v.cadeiraId ?? null,
            inicio,
            fim,
            origem: v.origem,
            observacao: v.observacao ?? null,
            criadoPorId: ator.usuarioId,
          })
          .returning({ id: agendamento.id })

        if (criado) criados.push(criado.id)
      }
    })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'agendamento',
      pacienteId: v.pacienteId,
      detalhes: {
        ocorrencias: criados.length,
        repetir: v.repetir ?? undefined,
        primeiroDia: v.dia,
        hora: v.hora,
      },
    })

    revalidatePath('/agenda')
    return { ok: true, ids: criados }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

/** Reagenda mantendo o mesmo registro — o histórico de status é preservado. */
export async function reagendar(
  id: string,
  { dia, hora, duracaoMinutos }: { dia: string; hora: string; duracaoMinutos: number },
): Promise<ResultadoAgenda> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('agenda', 'editar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const config = await configuracaoAgenda()

  try {
    const inicio = instanteDe(dia, hora, config.fuso)
    const fim = new Date(inicio.getTime() + duracaoMinutos * 60_000)
    exigirIntervaloValido({ inicio, fim })

    const diaSemana = new Date(`${dia}T00:00:00Z`).getUTCDay() as DiaSemana
    const inicioMin = hhmmParaMinutos(hora)
    if (!dentroDoFuncionamento(config.horario, diaSemana, inicioMin, inicioMin + duracaoMinutos)) {
      return {
        ok: false,
        erros: { hora: 'Fora do horário de atendimento, ou atravessa o intervalo.' },
      }
    }

    const [atual] = await db
      .select({ status: agendamento.status, pacienteId: agendamento.pacienteId })
      .from(agendamento)
      .where(eq(agendamento.id, id))
      .limit(1)

    if (!atual) return { ok: false, erros: {}, mensagem: 'Agendamento não encontrado.' }

    // Reagendar o que já aconteceu não faz sentido: o registro é histórico.
    if (['concluido', 'faltou', 'cancelado'].includes(atual.status)) {
      return {
        ok: false,
        erros: {},
        mensagem: `Agendamento em "${atual.status}" não pode ser reagendado. Crie um novo.`,
      }
    }

    await db
      .update(agendamento)
      .set({ inicio, fim, status: 'agendado', confirmadoEm: null, confirmadoVia: null })
      .where(eq(agendamento.id, id))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'agendamento',
      entidadeId: id,
      pacienteId: atual.pacienteId,
      // Reagendar zera a confirmação: o paciente confirmou o horário ANTIGO.
      detalhes: { tipo: 'reagendamento', dia, hora, confirmacaoZerada: true },
    })

    revalidatePath('/agenda')
    return { ok: true, ids: [id] }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

export interface ResultadoStatus {
  readonly ok: boolean
  readonly mensagem?: string
}

/**
 * Transição de status. Passa por `exigirTransicao` (lib/domain/agendamento.ts),
 * que é a mesma máquina de estados coberta por teste unitário.
 */
export async function mudarStatus(
  id: string,
  para: StatusAgendamento,
  motivo?: string,
): Promise<ResultadoStatus> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('agenda', 'editar')
  } catch (e) {
    const r = respostaDeAcesso(e)
    return { ok: false, mensagem: r.ok ? undefined : r.mensagem }
  }

  const [atual] = await db
    .select({ status: agendamento.status, pacienteId: agendamento.pacienteId })
    .from(agendamento)
    .where(eq(agendamento.id, id))
    .limit(1)

  if (!atual) return { ok: false, mensagem: 'Agendamento não encontrado.' }

  try {
    exigirTransicao(atual.status as StatusAgendamento, para, { motivoCancelamento: motivo })
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : 'Transição inválida.' }
  }

  const agora = new Date()
  const campos: Record<string, unknown> = { status: para }

  // Cada estado tem seu próprio carimbo de tempo: sem eles não se calcula
  // tempo de espera nem taxa de falta na Fase 11.
  switch (para) {
    case 'confirmado':
      campos.confirmadoEm = agora
      campos.confirmadoVia = 'telefone'
      break
    case 'em_atendimento':
      campos.iniciadoEm = agora
      // Se ninguém registrou a chegada, ela foi agora.
      if (!atual.status.includes('em_atendimento')) campos.chegouEm = agora
      break
    case 'concluido':
      campos.concluidoEm = agora
      break
    case 'cancelado':
      campos.canceladoEm = agora
      campos.motivoCancelamento = motivo
      break
  }

  await db.update(agendamento).set(campos).where(eq(agendamento.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'agendamento',
    entidadeId: id,
    pacienteId: atual.pacienteId,
    detalhes: { de: atual.status, para, motivo: motivo ?? undefined },
  })

  revalidatePath('/agenda')
  return { ok: true }
}

/** Chegada é distinta de confirmação: confirmou = disse que vem; chegou = está aqui. */
export async function registrarChegada(id: string): Promise<ResultadoStatus> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('agenda', 'editar')
  } catch (e) {
    const r = respostaDeAcesso(e)
    return { ok: false, mensagem: r.ok ? undefined : r.mensagem }
  }

  const [atual] = await db
    .select({ status: agendamento.status, pacienteId: agendamento.pacienteId, chegouEm: agendamento.chegouEm })
    .from(agendamento)
    .where(eq(agendamento.id, id))
    .limit(1)

  if (!atual) return { ok: false, mensagem: 'Agendamento não encontrado.' }
  if (atual.chegouEm) return { ok: true }
  if (['concluido', 'faltou', 'cancelado'].includes(atual.status)) {
    return { ok: false, mensagem: 'Este atendimento já foi encerrado.' }
  }

  await db.update(agendamento).set({ chegouEm: new Date() }).where(eq(agendamento.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'agendamento',
    entidadeId: id,
    pacienteId: atual.pacienteId,
    detalhes: { tipo: 'chegada' },
  })

  revalidatePath('/agenda')
  return { ok: true }
}

// ── Bloqueios ────────────────────────────────────────────────────────────────

export async function criarBloqueio(
  _anterior: ResultadoAgenda | null,
  dados: FormData,
): Promise<ResultadoAgenda> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('agenda', 'criar')
  } catch (e) {
    return respostaDeAcesso(e)
  }

  const analise = bloqueioSchema.safeParse(dosCampos(dados))
  if (!analise.success) return { ok: false, erros: achatarErros(analise.error) }

  const v = analise.data
  const config = await configuracaoAgenda()

  try {
    const [criado] = await db
      .insert(bloqueioAgenda)
      .values({
        profissionalId: v.profissionalId ?? null,
        cadeiraId: v.cadeiraId ?? null,
        inicio: instanteDe(v.diaInicio, v.horaInicio, config.fuso),
        fim: instanteDe(v.diaFim, v.horaFim, config.fuso),
        motivo: v.motivo,
        criadoPorId: ator.usuarioId,
      })
      .returning({ id: bloqueioAgenda.id })

    if (!criado) return { ok: false, erros: {}, mensagem: 'Não foi possível salvar.' }

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'bloqueio_agenda',
      entidadeId: criado.id,
      detalhes: { motivo: v.motivo, de: v.diaInicio, ate: v.diaFim },
    })

    revalidatePath('/agenda')
    return { ok: true, ids: [criado.id] }
  } catch (e) {
    return respostaDeBanco(e)
  }
}

export async function removerBloqueio(id: string): Promise<ResultadoStatus> {
  let ator: Awaited<ReturnType<typeof exigirPermissao>>
  try {
    ator = await exigirPermissao('agenda', 'excluir')
  } catch (e) {
    const r = respostaDeAcesso(e)
    return { ok: false, mensagem: r.ok ? undefined : r.mensagem }
  }

  await db.delete(bloqueioAgenda).where(eq(bloqueioAgenda.id, id))

  await registrar({ ator, acao: 'exclusao', entidade: 'bloqueio_agenda', entidadeId: id })
  revalidatePath('/agenda')
  return { ok: true }
}

// ── Auxiliares ───────────────────────────────────────────────────────────────

/**
 * Datas das ocorrências.
 *
 * O mensal usa `addMeses`, que ancora no dia original e faz clamp no fim do mês
 * — 31/jan gera 28/fev e volta a 31/mar, sem acumular o desvio. Mesma lógica
 * do vencimento de parcela em lib/domain/datas.ts.
 */
function diasDaRecorrencia(
  primeiro: string,
  repetir: 'semanal' | 'quinzenal' | 'mensal' | null,
  repeticoes: number,
): readonly string[] {
  if (!repetir || repeticoes <= 1) return [primeiro]

  const dias: string[] = []
  for (let i = 0; i < repeticoes; i++) {
    if (repetir === 'mensal') dias.push(addMeses(primeiro, i))
    else dias.push(addDias(primeiro, i * (repetir === 'semanal' ? 7 : 14)))
  }
  return dias
}

function respostaDeAcesso(e: unknown): ResultadoAgenda {
  if (e instanceof SemSessao) {
    return { ok: false, erros: {}, mensagem: 'Sua sessão expirou. Entre novamente.' }
  }
  if (e instanceof SemPermissao) {
    return { ok: false, erros: {}, mensagem: 'Seu perfil não permite esta ação.' }
  }
  throw e
}

/** Traduz violação de constraint e erro de domínio em mensagem de campo. */
function respostaDeBanco(e: unknown): ResultadoAgenda {
  if (e instanceof ErroDominio) {
    const campo =
      e.codigo === 'FORA_DO_FUNCIONAMENTO'
        ? 'hora'
        : e.codigo === 'INTERVALO_INVERTIDO'
          ? 'duracaoMinutos'
          : undefined
    return campo ? { ok: false, erros: { [campo]: e.message } } : { ok: false, erros: {}, mensagem: e.message }
  }

  const texto = e instanceof Error ? e.message : String(e)

  // 23P01 — a EXCLUDE constraint da agenda. É a autoridade sobre conflito.
  if (texto.includes('agendamento_sem_conflito_profissional')) {
    return { ok: false, erros: { hora: 'O profissional já tem atendimento neste horário.' } }
  }
  if (texto.includes('agendamento_sem_conflito_cadeira')) {
    return { ok: false, erros: { cadeiraId: 'A cadeira já está ocupada neste horário.' } }
  }
  if (texto.includes('bloqueio_sem_sobreposicao_profissional')) {
    return { ok: false, erros: { horaInicio: 'Já existe um bloqueio neste período para o profissional.' } }
  }
  if (texto.includes('agendamento_intervalo_valido') || texto.includes('bloqueio_intervalo_valido')) {
    return { ok: false, erros: { duracaoMinutos: 'O fim precisa ser depois do início.' } }
  }
  if (texto.includes('agendamento_paciente_id')) {
    return { ok: false, erros: { pacienteId: 'Paciente não encontrado.' } }
  }
  if (texto.includes('agendamento_profissional_id')) {
    return { ok: false, erros: { profissionalId: 'Profissional não encontrado.' } }
  }

  console.error('[agenda] erro inesperado ao gravar', texto)
  return { ok: false, erros: {}, mensagem: 'Não foi possível salvar. Tente novamente.' }
}
