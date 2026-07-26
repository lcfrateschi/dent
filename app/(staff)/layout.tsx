import { AlternarTema } from '@/components/ui/AlternarTema'
import { BotaoSair } from '@/components/ui/BotaoSair'
import { ROTULO_PERFIL, type Recurso, podeVer } from '@/lib/authz/politicas'
import { atorAtual } from '@/lib/authz/sessao'
import { cn } from '@/lib/ui/cn'
import Link from 'next/link'
import { redirect } from 'next/navigation'

/**
 * Casca do realm de STAFF.
 *
 * `app/(staff)` e o futuro `app/(portal)` são realms separados por decisão de
 * segurança (CLAUDE.md, decisão 2): sessão, layout e consultas distintos.
 * Nada aqui dentro pode ser reaproveitado no portal do paciente.
 *
 * O menu só mostra o que o perfil pode ver — mas isso é conveniência, não
 * proteção: quem garante o acesso é `exigirPermissao` em cada action e page.
 */

interface ItemMenu {
  href: string
  rotulo: string
  recurso: Recurso
  /** Fase que constrói a tela. Ausente = já existe. */
  fase?: number
}

const MENU: readonly ItemMenu[] = [
  { href: '/pacientes', rotulo: 'Pacientes', recurso: 'paciente' },
  { href: '/agenda', rotulo: 'Agenda', recurso: 'agenda' },
  { href: '/financeiro', rotulo: 'Financeiro', recurso: 'cobranca', fase: 8 },
  { href: '/convenios', rotulo: 'Convênios', recurso: 'convenio', fase: 13 },
  { href: '/usuarios', rotulo: 'Usuários', recurso: 'usuario', fase: 3 },
  { href: '/auditoria', rotulo: 'Auditoria', recurso: 'auditoria', fase: 11 },
]

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const ator = await atorAtual()
  // O middleware já barra; esta é a segunda tranca, caso o matcher mude.
  if (!ator) redirect('/entrar')

  const itens = MENU.filter((i) => podeVer(ator.perfil, i.recurso))

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
          <Link href="/pacientes" className="text-sm font-semibold text-fg">
            dent
          </Link>

          <nav className="flex flex-wrap gap-1">
            {itens.map((i) =>
              // Item de fase futura fica visível mas inerte: mostra o caminho do
              // produto sem levar a um 404.
              i.fase ? (
                <span
                  key={i.href}
                  title={`Construído na Fase ${i.fase} — ver ROADMAP.md`}
                  aria-disabled
                  className="cursor-not-allowed rounded-(--radius-controle) px-2.5 py-1.5 text-sm text-fg-3/60"
                >
                  {i.rotulo}
                </span>
              ) : (
                <Link
                  key={i.href}
                  href={i.href}
                  className={cn(
                    'rounded-(--radius-controle) px-2.5 py-1.5 text-sm text-fg-2',
                    'hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {i.rotulo}
                </Link>
              ),
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="text-right leading-tight">
              <div className="text-sm font-medium text-fg">{ator.nome}</div>
              <div className="text-xs text-fg-3">{ROTULO_PERFIL[ator.perfil]}</div>
            </div>
            <AlternarTema />
            <BotaoSair />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
    </div>
  )
}
