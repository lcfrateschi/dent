import { cn } from '@/lib/ui/cn'
import { Icone } from '@/components/ui/Icone'

export interface Alerta {
  readonly id: string
  readonly tipo: string
  readonly descricao: string
  readonly severidade: 'informativo' | 'atencao' | 'critico'
}

/**
 * Alertas clínicos no topo de TODA tela do paciente.
 *
 * Alergia a anestésico, uso de anticoagulante, diabetes descompensada e
 * gravidez mudam a conduta. Isto não é um aviso decorativo: é a informação que
 * precisa estar na frente de quem vai colocar a pessoa na cadeira, antes de
 * qualquer outra coisa da tela.
 *
 * Por isso a faixa é sempre a primeira coisa renderizada, usa `role="alert"`
 * quando há item crítico, e não é recolhível.
 */
export function FaixaAlertas({ alertas }: { alertas: readonly Alerta[] }) {
  if (alertas.length === 0) return null

  const temCritico = alertas.some((a) => a.severidade === 'critico')

  return (
    <div
      role={temCritico ? 'alert' : 'status'}
      className={cn(
        'rounded-(--radius-cartao) border-2 px-4 py-3',
        temCritico
          ? 'border-critico bg-critico/10'
          : 'border-atencao/50 bg-atencao/10',
      )}
    >
      <h2
        className={cn(
          'flex items-center gap-1.5 text-xs font-bold tracking-wide uppercase',
          temCritico ? 'text-critico' : 'text-atencao',
        )}
      >
        <Icone nome="alerta" tamanho={14} />
        {temCritico ? 'Atenção — alertas clínicos' : 'Alertas clínicos'}
      </h2>
      <ul className="mt-1.5 space-y-1">
        {alertas.map((a) => (
          <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span
              className={cn(
                'font-semibold',
                a.severidade === 'critico'
                  ? 'text-critico'
                  : a.severidade === 'atencao'
                    ? 'text-atencao'
                    : 'text-fg-2',
              )}
            >
              {a.tipo}
            </span>
            <span className="text-fg-2">{a.descricao}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
