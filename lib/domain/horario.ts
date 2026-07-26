import { erro } from './erros'
import { hhmmParaMinutos, minutosParaHhmm } from './fuso'

/**
 * Horário de funcionamento da clínica.
 *
 * Duas faixas por dia é o caso normal, não a exceção: quase todo consultório
 * fecha para o almoço. Modelar como uma faixa só ("08:00–18:00") faria a agenda
 * oferecer 12:30 como horário livre.
 */

export interface Faixa {
  /** 'HH:MM' */
  readonly inicio: string
  readonly fim: string
}

/** 0 = domingo … 6 = sábado. */
export type DiaSemana = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type HorarioFuncionamento = Readonly<Record<string, readonly Faixa[]>>

export const NOME_DIA: Readonly<Record<DiaSemana, string>> = {
  0: 'Domingo',
  1: 'Segunda',
  2: 'Terça',
  3: 'Quarta',
  4: 'Quinta',
  5: 'Sexta',
  6: 'Sábado',
}

export const NOME_DIA_CURTO: Readonly<Record<DiaSemana, string>> = {
  0: 'Dom',
  1: 'Seg',
  2: 'Ter',
  3: 'Qua',
  4: 'Qui',
  5: 'Sex',
  6: 'Sáb',
}

/** Padrão de consultório: manhã e tarde de segunda a sexta, sábado só de manhã. */
export const HORARIO_PADRAO: HorarioFuncionamento = {
  0: [],
  1: [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
  2: [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
  3: [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
  4: [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
  5: [{ inicio: '08:00', fim: '12:00' }, { inicio: '13:00', fim: '18:00' }],
  6: [{ inicio: '08:00', fim: '12:00' }],
}

export function faixasDoDia(
  horario: HorarioFuncionamento,
  diaSemana: DiaSemana,
): readonly Faixa[] {
  return horario[String(diaSemana)] ?? []
}

export function abreNoDia(horario: HorarioFuncionamento, diaSemana: DiaSemana): boolean {
  return faixasDoDia(horario, diaSemana).length > 0
}

/**
 * Se um intervalo cabe DENTRO de uma única faixa de atendimento.
 *
 * Uma faixa só de propósito: um atendimento que começa às 11:30 e termina às
 * 13:30 atravessaria o almoço. Ele não é "parcialmente válido" — é inválido.
 */
export function dentroDoFuncionamento(
  horario: HorarioFuncionamento,
  diaSemana: DiaSemana,
  inicioMin: number,
  fimMin: number,
): boolean {
  return faixasDoDia(horario, diaSemana).some(
    (f) => inicioMin >= hhmmParaMinutos(f.inicio) && fimMin <= hhmmParaMinutos(f.fim),
  )
}

export interface LimitesGrade {
  /** Minuto de abertura mais cedo da semana — o topo da grade. */
  readonly inicioMin: number
  /** Minuto de fechamento mais tarde — a base da grade. */
  readonly fimMin: number
}

/**
 * Limites verticais da grade, considerando **todos** os dias exibidos.
 *
 * Usar os limites de um dia só faria o sábado, que fecha ao meio-dia, cortar
 * a tarde da segunda.
 */
export function limitesDaGrade(
  horario: HorarioFuncionamento,
  dias: readonly DiaSemana[],
): LimitesGrade {
  let inicio = Number.POSITIVE_INFINITY
  let fim = Number.NEGATIVE_INFINITY

  for (const dia of dias) {
    for (const f of faixasDoDia(horario, dia)) {
      inicio = Math.min(inicio, hhmmParaMinutos(f.inicio))
      fim = Math.max(fim, hhmmParaMinutos(f.fim))
    }
  }

  // Nenhum dia aberto (clínica fechada na semana toda): grade comercial padrão,
  // para a tela não ficar com altura zero.
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) {
    return { inicioMin: 8 * 60, fimMin: 18 * 60 }
  }
  return { inicioMin: inicio, fimMin: fim }
}

/**
 * Fatia as faixas do dia em passos de `passoMin`, devolvendo os inícios
 * possíveis para um atendimento de `duracaoMin`.
 *
 * Só inclui horários em que o atendimento INTEIRO cabe na faixa: um
 * procedimento de 60 min não pode começar às 11:30.
 */
export function horariosPossiveis({
  horario,
  diaSemana,
  duracaoMin,
  passoMin = 15,
}: {
  horario: HorarioFuncionamento
  diaSemana: DiaSemana
  duracaoMin: number
  passoMin?: number
}): readonly number[] {
  if (duracaoMin <= 0) {
    erro('DURACAO_INVALIDA', `Duração deve ser positiva, recebida ${duracaoMin}.`, { duracaoMin })
  }
  if (passoMin <= 0) {
    erro('PASSO_INVALIDO', `Passo deve ser positivo, recebido ${passoMin}.`, { passoMin })
  }

  const saida: number[] = []
  for (const f of faixasDoDia(horario, diaSemana)) {
    const abre = hhmmParaMinutos(f.inicio)
    const fecha = hhmmParaMinutos(f.fim)
    // Alinha ao passo a partir da abertura, não da meia-noite: uma clínica que
    // abre às 08:10 deve oferecer 08:10, não 08:15.
    for (let t = abre; t + duracaoMin <= fecha; t += passoMin) {
      saida.push(t)
    }
  }
  return saida
}

/** Valida a configuração inteira. Usada ao salvar nos ajustes da clínica. */
export function exigirHorarioValido(horario: HorarioFuncionamento): void {
  for (const dia of [0, 1, 2, 3, 4, 5, 6] as DiaSemana[]) {
    const faixas = faixasDoDia(horario, dia)
    let fimAnterior = -1

    for (const f of faixas) {
      const inicio = hhmmParaMinutos(f.inicio)
      const fim = hhmmParaMinutos(f.fim)

      if (fim <= inicio) {
        erro(
          'FAIXA_INVERTIDA',
          `${NOME_DIA[dia]}: o fim (${f.fim}) precisa ser depois do início (${f.inicio}).`,
          { dia, faixa: f },
        )
      }
      // Faixas do mesmo dia precisam vir em ordem e não se sobrepor — senão o
      // cálculo de horários livres conta o mesmo minuto duas vezes.
      if (inicio < fimAnterior) {
        erro(
          'FAIXAS_SOBREPOSTAS',
          `${NOME_DIA[dia]}: as faixas de atendimento se sobrepõem ou estão fora de ordem.`,
          { dia, faixa: f },
        )
      }
      fimAnterior = fim
    }
  }
}

/** Descrição legível, para a tela de configuração e o cabeçalho da agenda. */
export function descreverDia(horario: HorarioFuncionamento, diaSemana: DiaSemana): string {
  const faixas = faixasDoDia(horario, diaSemana)
  if (faixas.length === 0) return 'Fechado'
  return faixas.map((f) => `${f.inicio}–${f.fim}`).join(' e ')
}

/** Total de minutos de atendimento no dia — base da taxa de ocupação (Fase 11). */
export function minutosDisponiveis(
  horario: HorarioFuncionamento,
  diaSemana: DiaSemana,
): number {
  return faixasDoDia(horario, diaSemana).reduce(
    (acc, f) => acc + (hhmmParaMinutos(f.fim) - hhmmParaMinutos(f.inicio)),
    0,
  )
}

export { minutosParaHhmm }
