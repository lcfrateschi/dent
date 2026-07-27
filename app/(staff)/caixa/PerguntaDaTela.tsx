import Link from 'next/link'
import { cn } from '@/lib/ui/cn'

/**
 * O cabeçalho das três telas do caixa, e ele carrega uma garantia.
 *
 * ── Por que a pergunta vem escrita, e não só o título ───────────────────────
 * As três telas mostram números diferentes para o mesmo mês, e **as três estão
 * certas**. Aluguel de R$ 3.200 com competência julho, pago em 5 de agosto:
 *
 *   • "Fluxo de caixa" de julho não o inclui — o dinheiro saiu em agosto;
 *   • "Custo por competência" de julho o inclui — julho consumiu o aluguel;
 *   • "Contas a pagar" o mostrava até 5 de agosto — era dívida em aberto.
 *
 * Sem a pergunta escrita, quem abre as duas primeiras em julho vê R$ 850 numa e
 * R$ 4.050 na outra e conclui, razoavelmente, que o sistema está errado. Depois pede
 * para a contadora conferir, e a contadora recusa o relatório — não porque o número
 * está errado, mas porque não sabe qual regime ele usa.
 *
 * É por isso que a frase não é decoração e **não deve ser abreviada por estética**: ela
 * é a única coisa na tela que distingue regime de caixa de regime de competência. O
 * mesmo cuidado que faz `lib/caixa/consultas.ts` ter a tabela dos três regimes no topo
 * do arquivo.
 *
 * A navegação entre as três fica aqui junto, e nomeada pela pergunta: quem procura
 * "quanto eu devo" acha "o que eu ainda devo", não "Contas".
 */

export type Aba = 'caixa' | 'custos' | 'contas' | 'conciliacao'

const ABAS: readonly { readonly aba: Aba; readonly href: string; readonly rotulo: string }[] = [
  { aba: 'caixa', href: '/caixa', rotulo: 'Entrou e saiu do banco' },
  { aba: 'custos', href: '/caixa/custos', rotulo: 'Quanto o mês custou' },
  { aba: 'contas', href: '/caixa/contas', rotulo: 'O que ainda devo' },
  { aba: 'conciliacao', href: '/caixa/conciliacao', rotulo: 'Conciliação do Pix' },
]

export function PerguntaDaTela({
  titulo,
  pergunta,
  regime,
  ativa,
}: {
  titulo: string
  /** A pergunta que ESTA tela responde, em português de quem trabalha na clínica. */
  pergunta: string
  /** Qual data manda no número. Escrito porque é o que a contadora vai perguntar. */
  regime: string
  ativa: Aba
}) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">{titulo}</h1>
        <p className="mt-1 text-sm text-fg-2">
          Responde: <strong className="font-medium text-fg">{pergunta}</strong>
        </p>
        <p className="mt-0.5 text-xs text-fg-3">{regime}</p>
      </div>

      <nav aria-label="Telas do caixa" className="flex flex-wrap gap-2">
        {ABAS.map((a) => (
          <Link
            key={a.href}
            href={a.href}
            aria-current={a.aba === ativa ? 'page' : undefined}
            className={cn(
              'rounded-(--radius-controle) border px-3 py-1.5 text-sm',
              a.aba === ativa
                ? 'border-primary bg-primary text-primary-fg'
                : 'border-border bg-surface text-fg-2 hover:bg-surface-2',
            )}
          >
            {a.rotulo}
          </Link>
        ))}
      </nav>
    </div>
  )
}
