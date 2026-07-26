import { signOut } from '@/lib/auth/config'
import { Button } from './Button'

/**
 * Sair via formulário POST, não link.
 *
 * Logout por GET pode ser disparado por um `<img src>` de outro site, e
 * derrubar a sessão de quem está no meio de um atendimento. É CSRF de baixo
 * impacto, mas gratuito de evitar.
 */
export function BotaoSair() {
  return (
    <form
      action={async () => {
        'use server'
        await signOut({ redirectTo: '/entrar' })
      }}
    >
      <Button type="submit" tamanho="sm" variante="fantasma">
        Sair
      </Button>
    </form>
  )
}
