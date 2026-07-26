import { erro } from './erros'

export type StatusAgendamento =
  | 'agendado'
  | 'confirmado'
  | 'em_atendimento'
  | 'concluido'
  | 'faltou'
  | 'cancelado'

/**
 * Máquina de estados do agendamento.
 *
 * agendado → confirmado → em_atendimento → concluido
 *      ↘ faltou     ↘ cancelado
 *
 * `concluido` e `faltou` são terminais: o que aconteceu, aconteceu.
 * Reagendar não é transição — é um agendamento novo.
 */
const TRANSICOES: Readonly<Record<StatusAgendamento, readonly StatusAgendamento[]>> = {
  agendado: ['confirmado', 'em_atendimento', 'faltou', 'cancelado'],
  confirmado: ['em_atendimento', 'faltou', 'cancelado'],
  em_atendimento: ['concluido', 'cancelado'],
  concluido: [],
  faltou: [],
  cancelado: [],
}

/** Status que ainda ocupam a agenda. Cancelado e falta liberam o horário. */
export const STATUS_OCUPAM_AGENDA: readonly StatusAgendamento[] = [
  'agendado',
  'confirmado',
  'em_atendimento',
  'concluido',
]

export function podeTransicionar(de: StatusAgendamento, para: StatusAgendamento): boolean {
  return TRANSICOES[de].includes(para)
}

export function exigirTransicao(
  de: StatusAgendamento,
  para: StatusAgendamento,
  opcoes: { readonly motivoCancelamento?: string | null } = {},
): void {
  if (de === para) {
    erro('TRANSICAO_REDUNDANTE', `Agendamento já está em "${de}".`, { de, para })
  }
  if (!podeTransicionar(de, para)) {
    const possiveis = TRANSICOES[de]
    erro(
      'TRANSICAO_INVALIDA',
      possiveis.length === 0
        ? `Agendamento em "${de}" é estado final e não pode mudar.`
        : `Não é possível ir de "${de}" para "${para}". Possíveis: ${possiveis.join(', ')}.`,
      { de, para, possiveis },
    )
  }
  // Espelha o CHECK agendamento_cancelado_tem_motivo, com mensagem melhor.
  if (para === 'cancelado' && !opcoes.motivoCancelamento?.trim()) {
    erro('CANCELAMENTO_SEM_MOTIVO', 'Cancelar um agendamento exige informar o motivo.', { de })
  }
}

export interface Intervalo {
  readonly inicio: Date
  readonly fim: Date
}

/**
 * Sobreposição meio-aberta `[inicio, fim)`: um atendimento que termina às 10:00
 * não conflita com outro que começa às 10:00. Mesma semântica do
 * `tstzrange(inicio, fim, '[)')` usado na EXCLUDE constraint.
 */
export function conflita(a: Intervalo, b: Intervalo): boolean {
  return a.inicio < b.fim && b.inicio < a.fim
}

export function exigirIntervaloValido({ inicio, fim }: Intervalo): void {
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
    erro('INTERVALO_INVALIDO', 'Início e fim do agendamento precisam ser datas válidas.')
  }
  if (fim <= inicio) {
    erro('INTERVALO_INVERTIDO', 'O fim do agendamento precisa ser depois do início.', {
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
    })
  }
}

export interface AgendamentoExistente extends Intervalo {
  readonly id: string
  readonly profissionalId: string
  readonly cadeiraId: string | null
  readonly status: StatusAgendamento
}

export interface Candidato extends Intervalo {
  /** Preenchido ao reagendar, para o próprio agendamento não conflitar consigo. */
  readonly id?: string
  readonly profissionalId: string
  readonly cadeiraId: string | null
}

export type MotivoConflito = 'profissional' | 'cadeira'

export interface Conflito {
  readonly agendamentoId: string
  readonly motivo: MotivoConflito
}

/**
 * Conflitos de um candidato contra a agenda existente.
 *
 * Detecção antecipada, para dar mensagem boa ao usuário. A garantia real é a
 * EXCLUDE constraint no banco — sem ela, duas recepcionistas marcando ao mesmo
 * tempo passariam pelas duas checagens e criariam a sobreposição.
 */
export function encontrarConflitos(
  candidato: Candidato,
  existentes: readonly AgendamentoExistente[],
): Conflito[] {
  exigirIntervaloValido(candidato)

  const conflitos: Conflito[] = []

  for (const e of existentes) {
    if (e.id === candidato.id) continue
    if (!STATUS_OCUPAM_AGENDA.includes(e.status)) continue
    if (!conflita(candidato, e)) continue

    if (e.profissionalId === candidato.profissionalId) {
      conflitos.push({ agendamentoId: e.id, motivo: 'profissional' })
    } else if (candidato.cadeiraId !== null && e.cadeiraId === candidato.cadeiraId) {
      conflitos.push({ agendamentoId: e.id, motivo: 'cadeira' })
    }
  }

  return conflitos
}

export function exigirSemConflito(
  candidato: Candidato,
  existentes: readonly AgendamentoExistente[],
): void {
  const conflitos = encontrarConflitos(candidato, existentes)
  if (conflitos.length > 0) {
    const porMotivo = conflitos[0]!.motivo
    erro(
      'AGENDA_CONFLITO',
      porMotivo === 'profissional'
        ? 'O profissional já tem atendimento neste horário.'
        : 'A cadeira já está ocupada neste horário.',
      { conflitos },
    )
  }
}
