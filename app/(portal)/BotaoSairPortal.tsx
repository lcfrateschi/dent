'use client'

import { Button } from '@/components/ui/Button'
import { sairDoPortal } from '@/lib/portal/acoes'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

/**
 * Sair do portal.
 *
 * Componente próprio, não o `BotaoSair` do staff: aquele chama `signOut` do
 * Auth.js, que mexe no cookie do outro realm. Reaproveitar seria criar um caminho
 * em que um clique no portal interfere na sessão da clínica.
 */
export function BotaoSairPortal() {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()

  return (
    <Button
      tamanho="sm"
      variante="fantasma"
      disabled={pendente}
      onClick={() =>
        iniciar(async () => {
          await sairDoPortal()
          router.push('/meu/entrar')
          router.refresh()
        })
      }
    >
      {pendente ? 'Saindo…' : 'Sair'}
    </Button>
  )
}
