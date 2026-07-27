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
      {/*
        O tema escuro está DESLIGADO por enquanto, por decisão: a marca é aplicada
        na cor original, e sobre fundo escuro a palavra #0D3B66 precisaria de chapa
        clara — um retângulo claro no cabeçalho escuro. Enquanto essa decisão não
        estiver fechada, o app fica no claro.

        Aqui morava um script que aplicava `.dark` antes da primeira pintura,
        lendo `localStorage` e `prefers-color-scheme`. Ele saiu com o alternador.

        **Para religar:** devolver o script abaixo, recolocar `<AlternarTema />`
        nas três cascas (staff, portal, design) e conferir a chapa da marca no
        escuro (`--marca-chapa` em app/globals.css).

            <script dangerouslySetInnerHTML={{ __html:
              `try{var t=localStorage.getItem('facilident-tema');`
              + `if(t==='escuro'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))`
              + `document.documentElement.classList.add('dark')}catch(e){}` }} />

        Os tokens do bloco `.dark` continuam em app/globals.css, vivos e cobertos
        pelo teste de tokens: apagá-los faria o catálogo do design system divergir
        do código, e religar o tema viraria um trabalho de arqueologia.
      */}
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
