import { cn } from '@/lib/ui/cn'
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

const BASE =
  'w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg ' +
  'placeholder:text-fg-3 disabled:opacity-60 aria-[invalid=true]:border-critico'

export interface CampoProps {
  rotulo: ReactNode
  /** Texto de apoio. Some quando há erro, para não competir com ele. */
  ajuda?: ReactNode
  erro?: string | undefined
  obrigatorio?: boolean
  className?: string
}

export function Campo({
  rotulo,
  ajuda,
  erro,
  obrigatorio,
  className,
  id,
  children,
}: CampoProps & { id: string; children: ReactNode }) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-fg-2">
        {rotulo}
        {obrigatorio ? (
          <span className="ml-0.5 text-critico" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {erro ? (
        <p id={`${id}-erro`} className="mt-1 text-sm text-critico">
          {erro}
        </p>
      ) : ajuda ? (
        <p id={`${id}-ajuda`} className="mt-1 text-xs text-fg-3">
          {ajuda}
        </p>
      ) : null}
    </div>
  )
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, CampoProps {
  id: string
}

export function Input({ rotulo, ajuda, erro, obrigatorio, className, ...props }: InputProps) {
  return (
    <Campo
      id={props.id}
      rotulo={rotulo}
      ajuda={ajuda}
      erro={erro}
      obrigatorio={obrigatorio}
      className={className}
    >
      <input
        {...props}
        required={obrigatorio}
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? `${props.id}-erro` : ajuda ? `${props.id}-ajuda` : undefined}
        className={cn(BASE, 'h-10')}
      />
    </Campo>
  )
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, CampoProps {
  id: string
}

export function Select({
  rotulo,
  ajuda,
  erro,
  obrigatorio,
  className,
  children,
  ...props
}: SelectProps) {
  return (
    <Campo
      id={props.id}
      rotulo={rotulo}
      ajuda={ajuda}
      erro={erro}
      obrigatorio={obrigatorio}
      className={className}
    >
      <select
        {...props}
        required={obrigatorio}
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? `${props.id}-erro` : ajuda ? `${props.id}-ajuda` : undefined}
        className={cn(BASE, 'h-10')}
      >
        {children}
      </select>
    </Campo>
  )
}

export function Textarea({
  rotulo,
  ajuda,
  erro,
  obrigatorio,
  className,
  ...props
}: InputHTMLAttributes<HTMLTextAreaElement> & CampoProps & { id: string }) {
  return (
    <Campo
      id={props.id}
      rotulo={rotulo}
      ajuda={ajuda}
      erro={erro}
      obrigatorio={obrigatorio}
      className={className}
    >
      <textarea
        {...props}
        required={obrigatorio}
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? `${props.id}-erro` : ajuda ? `${props.id}-ajuda` : undefined}
        className={cn(BASE, 'min-h-24 py-2')}
      />
    </Campo>
  )
}

/** Faixa de erro do formulário inteiro. */
export function Alerta({
  tipo = 'critico',
  children,
}: {
  tipo?: 'critico' | 'atencao' | 'sucesso'
  children: ReactNode
}) {
  const cores = {
    critico: 'border-critico/40 bg-critico/10 text-critico',
    atencao: 'border-atencao/40 bg-atencao/10 text-atencao',
    sucesso: 'border-sucesso/40 bg-sucesso/10 text-sucesso',
  }
  return (
    <div
      role={tipo === 'critico' ? 'alert' : 'status'}
      className={cn('rounded-(--radius-controle) border px-3 py-2 text-sm', cores[tipo])}
    >
      {children}
    </div>
  )
}
