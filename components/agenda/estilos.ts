import type { StatusAgendamento } from '@/lib/domain/agendamento'

/**
 * Aparência por status do agendamento.
 *
 * **Dupla codificação, como no odontograma:** cada status tem cor E marca
 * textual. A recepção lê a agenda de longe e sob reflexo de janela; e quem não
 * distingue vermelho de verde precisa da mesma informação.
 *
 * A escolha de cores segue a leitura de urgência da recepção:
 *   agendado    → neutro, ainda não confirmado
 *   confirmado  → verde, o paciente disse que vem
 *   atendendo   → primária, está acontecendo agora
 *   concluído   → apagado, já resolvido
 *   faltou      → vermelho, é a métrica que dói
 *   cancelado   → riscado e apagado, o horário está livre
 */

export interface EstiloStatus {
  readonly rotulo: string
  /** Marca curta no canto do cartão — a parte não-cromática da codificação. */
  readonly marca: string
  readonly cartao: string
  readonly barra: string
  readonly texto: string
}

export const ESTILO_STATUS: Readonly<Record<StatusAgendamento, EstiloStatus>> = {
  agendado: {
    rotulo: 'Agendado',
    marca: '•',
    cartao: 'bg-surface border-border-forte',
    barra: 'bg-fg-3',
    texto: 'text-fg',
  },
  confirmado: {
    rotulo: 'Confirmado',
    marca: '✓',
    cartao: 'bg-sucesso/10 border-sucesso/45',
    barra: 'bg-sucesso',
    texto: 'text-fg',
  },
  em_atendimento: {
    rotulo: 'Em atendimento',
    marca: '▶',
    cartao: 'bg-primary/12 border-primary ring-1 ring-primary/40',
    barra: 'bg-primary',
    texto: 'text-fg',
  },
  concluido: {
    rotulo: 'Concluído',
    marca: '✓✓',
    cartao: 'bg-surface-2 border-border',
    barra: 'bg-border-forte',
    texto: 'text-fg-3',
  },
  faltou: {
    rotulo: 'Faltou',
    marca: '✗',
    cartao: 'bg-critico/10 border-critico/45',
    barra: 'bg-critico',
    texto: 'text-fg-2',
  },
  cancelado: {
    rotulo: 'Cancelado',
    marca: '—',
    cartao: 'bg-surface-2 border-border opacity-70',
    barra: 'bg-border-forte',
    texto: 'text-fg-3 line-through',
  },
}

export const ROTULO_ORIGEM: Readonly<Record<string, string>> = {
  recepcao: 'Recepção',
  telefone: 'Telefone',
  whatsapp: 'WhatsApp',
  portal: 'Portal',
  encaixe: 'Encaixe',
}

/** Próximos passos possíveis, na ordem em que a recepção costuma usar. */
export const PROXIMOS_STATUS: Readonly<Record<StatusAgendamento, readonly StatusAgendamento[]>> = {
  agendado: ['confirmado', 'em_atendimento', 'faltou', 'cancelado'],
  confirmado: ['em_atendimento', 'faltou', 'cancelado'],
  em_atendimento: ['concluido', 'cancelado'],
  concluido: [],
  faltou: [],
  cancelado: [],
}
