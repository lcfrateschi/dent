import { cn } from '@/lib/ui/cn'
import type { ButtonHTMLAttributes } from 'react'

type Variante = 'primario' | 'secundario' | 'fantasma' | 'perigo'
type Tamanho = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante
  tamanho?: Tamanho
  /** Estado ligado/desligado, para botões que funcionam como ferramenta. */
  ativo?: boolean
}

const VARIANTES: Record<Variante, string> = {
  primario: 'bg-primary text-primary-fg hover:bg-primary-hover border-transparent',
  secundario: 'bg-surface text-fg border-border hover:bg-surface-2',
  fantasma: 'bg-transparent text-fg-2 border-transparent hover:bg-surface-2 hover:text-fg',
  perigo: 'bg-critico text-white border-transparent hover:opacity-90',
}

const TAMANHOS: Record<Tamanho, string> = {
  // Alturas em múltiplos de 4, mínimo 36px; `lg` atinge o alvo de toque de 44px.
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
}

export function Button({
  variante = 'secundario',
  tamanho = 'md',
  ativo = false,
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={props['aria-pressed'] ?? (ativo ? true : undefined)}
      className={cn(
        'inline-flex items-center justify-center rounded-(--radius-controle) border font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        TAMANHOS[tamanho],
        VARIANTES[variante],
        // Ferramenta ativa: precisa ser óbvio qual está selecionada.
        ativo && 'border-primary bg-selecionado-fill text-fg ring-1 ring-primary',
        className,
      )}
      {...props}
    />
  )
}
