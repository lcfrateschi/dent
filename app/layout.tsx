import type { Metadata, Viewport } from 'next'
import { Poppins } from 'next/font/google'
import './globals.css'

/**
 * Poppins — a tipografia do manual da marca.
 *
 * `next/font/google` baixa a fonte **no build** e a serve do próprio domínio: não
 * há requisição ao Google em runtime (o que também evita mandar o IP de cada
 * paciente do portal para um terceiro) e não há salto de layout, porque o Next
 * gera o `@font-face` com `size-adjust`.
 *
 * Pesos: 400 para texto, 500/600 para rótulo e título. 700 fica de fora — o
 * manual usa semibold no logotipo, e cada peso extra é um arquivo a baixar.
 */
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--fonte-marca',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'Facilident',
    template: '%s · Facilident',
  },
  description: 'Facilident — software de gestão odontológica: simples, inteligente e humana',
  robots: {
    // Sistema de prontuário não vai para índice de busca.
    index: false,
    follow: false,
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // O odontograma se beneficia de zoom no tablet; não travar.
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={poppins.variable} suppressHydrationWarning>
      <head>
        {/*
          Tema aplicado antes da primeira pintura, para não haver flash de tema
          claro em quem usa escuro. Script mínimo, sem dependência.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('facilident-tema');if(t==='escuro'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
