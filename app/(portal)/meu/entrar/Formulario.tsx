'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { entrarNoPortal } from '@/lib/portal/acoes'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Formulário de entrada do paciente.
 *
 * O erro que aparece é sempre o que o servidor devolveu, sem enfeite: a mensagem é
 * deliberadamente única para não revelar se o e-mail existe (ver
 * `MENSAGEM_CREDENCIAL_INVALIDA`). Uma tela "prestativa" que dissesse "e-mail não
 * cadastrado" desfaria a proteção do servidor.
 */
export function FormularioEntrar() {
  const router = useRouter()
  const busca = useSearchParams()
  const [pendente, iniciar] = useTransition()
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const proximo = busca.get('proximo')
  const destino = proximo?.startsWith('/meu') ? proximo : '/meu'

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        setErro(null)
        iniciar(async () => {
          const r = await entrarNoPortal({ email, senha })
          if (r.ok) {
            router.push(destino)
            router.refresh()
          } else {
            setErro(r.mensagem)
          }
        })
      }}
    >
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium text-fg-2">
          E-mail
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
      </div>

      <div>
        <label htmlFor="senha" className="mb-1 block text-sm font-medium text-fg-2">
          Senha
        </label>
        <input
          id="senha"
          type="password"
          autoComplete="current-password"
          required
          value={senha}
          onChange={(e) => setSenha(e.currentTarget.value)}
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
      </div>

      {erro ? <Alerta>{erro}</Alerta> : null}

      <Button type="submit" variante="primario" tamanho="lg" disabled={pendente}>
        {pendente ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  )
}
