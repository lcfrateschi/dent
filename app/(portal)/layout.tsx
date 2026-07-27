import { Icone } from '@/components/ui/Icone'
import { cn } from '@/lib/ui/cn'
import type { Metadata } from 'next'
import Link from 'next/link'
import { BotaoSairPortal } from './BotaoSairPortal'
import { sessaoAtual } from '@/lib/portal/sessao'
import { SimboloFacilident } from '@/components/ui/Marca'

export const metadata: Metadata = {
  title: { default: 'Meu atendimento', template: '%s · Meu atendimento' },
  // O portal não deve ser indexado: a URL não é segredo, mas página de paciente
  // em resultado de busca é convite para engenharia social.
  robots: { index: false, follow: false },
}

/**
 * Casca do realm do PACIENTE.
 *
 * Separado de `app/(staff)` por decisão de segurança — CLAUDE.md, decisão 2. O que
 * este arquivo **não** faz é tão importante quanto o que faz:
 *
 * - não importa nada de `app/(staff)`;
 * - não usa `atorAtual()` nem `Ator`;
 * - não tem menu de recurso de clínica, porque não existe permissão de paciente
 *   sobre recurso — ele vê o que é dele, e ponto.
 *
 * O visual é mais espaçado que o do staff de propósito: quem usa isto entra três
 * vezes por ano, de celular, e não conhece o sistema.
 */

const MENU = [
  { href: '/meu', rotulo: 'Início', icone: 'agenda' as const },
  { href: '/meu/orcamentos', rotulo: 'Orçamentos', icone: 'cobranca' as const },
  { href: '/meu/financeiro', rotulo: 'Pagamentos', icone: 'financeiro' as const },
  { href: '/meu/documentos', rotulo: 'Documentos', icone: 'documentos' as const },
  { href: '/meu/dados', rotulo: 'Meus dados', icone: 'pacientes' as const },
]

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // Pode ser nulo: as telas de entrar e de convite ficam dentro deste layout.
  const sessao = await sessaoAtual()

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          {/*
            No portal a marca acompanha, mas não manda: o rótulo que orienta o
            paciente é "Meu atendimento". Quem entra ali quer ver a própria
            consulta, não o nome do software.
          */}
          <Link
            href={sessao ? '/meu' : '/meu/entrar'}
            className="flex items-center gap-2 font-semibold text-fg"
          >
            <SimboloFacilident tamanho={24} id="portal" />
            Meu atendimento
          </Link>

          <div className="ml-auto flex items-center gap-3">
            {sessao ? (
              <>
                <span className="text-sm text-fg-2">{primeiroNome(sessao.nome)}</span>
                <BotaoSairPortal />
              </>
            ) : null}
          </div>
        </div>

        {sessao ? (
          <nav className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4 pb-2">
            {MENU.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-(--radius-controle) px-3 py-2 text-sm text-fg-2',
                  'hover:bg-surface-2 hover:text-fg',
                )}
              >
                <Icone nome={i.icone} tamanho={15} />
                {i.rotulo}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>

      <footer className="mx-auto max-w-3xl px-4 pb-8 text-xs text-fg-3">
        Este acesso é registrado. Se você não reconhece algum acesso à sua conta, avise a clínica.
      </footer>
    </div>
  )
}

function primeiroNome(nome: string): string {
  return nome.trim().split(' ')[0] ?? nome
}
