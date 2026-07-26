import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'dent',
    template: '%s · dent',
  },
  description: 'Sistema de gestão para consultório odontológico',
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
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/*
          Tema aplicado antes da primeira pintura, para não haver flash de tema
          claro em quem usa escuro. Script mínimo, sem dependência.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('dent-tema');if(t==='escuro'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
