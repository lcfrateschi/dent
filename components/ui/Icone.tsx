import { cn } from '@/lib/ui/cn'
import {
  Activity,
  Ban,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardList,
  Clock,
  CreditCard,
  type LucideIcon,
  Minus,
  Pencil,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
  UserCog,
  UserX,
  Users,
  Wallet,
  X,
} from 'lucide-react'

/**
 * Ícones do sistema.
 *
 * ── Regra que não se negocia ────────────────────────────────────────────────
 * **Ícone acompanha texto; nunca substitui.** As únicas exceções são controles
 * cujo significado é universal e que têm `aria-label`: as setas de navegação de
 * período. Todo o resto leva rótulo.
 *
 * O motivo é o mesmo da dupla codificação do odontograma: a recepção tem
 * rotatividade, e ícone sem rótulo obriga cada pessoa nova a decorar um
 * vocabulário. Rótulo custa 40px de largura e economiza treinamento.
 *
 * ── Por que Lucide ──────────────────────────────────────────────────────────
 * São componentes SVG inline. Qualquer set baseado em **fonte de ícone**
 * quebraria os previews do design system, porque a CSP bloqueia recurso
 * externo — e deixaria a interface com caixinhas até a fonte carregar.
 *
 * Aqui há um mapa fechado de propósito: importar Lucide direto nas telas faria
 * o vocabulário visual crescer sem revisão.
 */

export const ICONES = {
  // Navegação
  pacientes: Users,
  agenda: CalendarDays,
  financeiro: Wallet,
  convenios: ShieldCheck,
  usuarios: UserCog,
  auditoria: ScrollText,
  odontograma: Stethoscope,
  anamnese: ClipboardList,

  // Ações
  novo: Plus,
  editar: Pencil,
  buscar: Search,
  anterior: ChevronLeft,
  proximo: ChevronRight,
  cobranca: CreditCard,

  // Status de agendamento — pareados com as marcas Unicode de estilos.ts
  agendado: Circle,
  confirmado: Check,
  em_atendimento: Activity,
  concluido: CheckCheck,
  faltou: UserX,
  cancelado: Minus,

  // Semânticos
  alerta: TriangleAlert,
  fechar: X,
  bloqueio: Ban,
  horario: Clock,
} as const

export type NomeIcone = keyof typeof ICONES

export interface IconeProps {
  nome: NomeIcone
  /** Tamanho em px. 16 acompanha texto de 14px; 14, texto de 12px. */
  tamanho?: number
  className?: string
  /**
   * Rótulo para leitor de tela. **Só use quando o ícone estiver sozinho** —
   * junto de texto ele deve ficar decorativo, senão o leitor lê duas vezes.
   */
  rotulo?: string
}

export function Icone({ nome, tamanho = 16, className, rotulo }: IconeProps) {
  const Componente: LucideIcon = ICONES[nome]
  return (
    <Componente
      size={tamanho}
      strokeWidth={2}
      className={cn('shrink-0', className)}
      aria-hidden={rotulo ? undefined : true}
      aria-label={rotulo}
      role={rotulo ? 'img' : undefined}
    />
  )
}
