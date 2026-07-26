'use client'

import { SessionProvider } from 'next-auth/react'
import type { ReactNode } from 'react'

/**
 * Só onde o cliente precisa de `useSession` — hoje, na tela de MFA, que atualiza
 * o token depois de ativar o segundo fator. O resto do app lê a sessão no
 * servidor, via `atorAtual()`: dado de sessão que não vai ao cliente não vaza.
 */
export function SessaoProvider({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
