import { cn } from '@/lib/ui/cn'
import type { HTMLAttributes, ReactNode } from 'react'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-(--radius-cartao) border border-border bg-surface shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({
  titulo,
  descricao,
  acoes,
  className,
}: {
  titulo: ReactNode
  descricao?: ReactNode
  acoes?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">{titulo}</h2>
        {descricao ? <p className="mt-0.5 text-sm text-fg-3">{descricao}</p> : null}
      </div>
      {acoes ? <div className="flex shrink-0 flex-wrap gap-2">{acoes}</div> : null}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4', className)} {...props} />
}
