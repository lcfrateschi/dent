import { AlternarTema } from '@/components/ui/AlternarTema'
import Link from 'next/link'

/**
 * Layout do playground do design system. Serve dois propósitos: revisar
 * componentes com o dentista e, depois, gerar os previews para o Claude Design.
 */
export default function DesignLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="text-sm font-semibold text-fg">
            dent
          </Link>
          <span className="text-xs text-fg-3">Design system</span>
          <nav className="flex gap-4 text-sm">
            <Link href="/design/odontograma" className="text-fg-2 hover:text-fg">
              Odontograma
            </Link>
          </nav>
          <div className="ml-auto">
            <AlternarTema />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
    </div>
  )
}
