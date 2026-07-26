'use client'

import { Button } from '@/components/ui/Button'
import { Alerta, Input } from '@/components/ui/Input'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function FormularioEntrada({ proximo }: { proximo: string }) {
  const router = useRouter()
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function enviar(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    setErro(null)
    setEnviando(true)

    const dados = new FormData(e.currentTarget)
    const r = await signIn('credentials', {
      email: String(dados.get('email') ?? ''),
      senha: String(dados.get('senha') ?? ''),
      codigo: String(dados.get('codigo') ?? ''),
      redirect: false,
    })

    if (r?.error) {
      // Mensagem única de propósito: distinguir "e-mail não existe" de "senha
      // errada" entregaria a lista de usuários da clínica.
      setErro('E-mail, senha ou código incorretos.')
      setEnviando(false)
      return
    }

    router.replace(proximo)
    router.refresh()
  }

  return (
    <form onSubmit={enviar} className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <Input
        id="email"
        name="email"
        type="email"
        rotulo="E-mail"
        autoComplete="username"
        autoFocus
        obrigatorio
      />

      <Input
        id="senha"
        name="senha"
        type="password"
        rotulo="Senha"
        autoComplete="current-password"
        obrigatorio
      />

      <Input
        id="codigo"
        name="codigo"
        type="text"
        rotulo="Código do autenticador"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        placeholder="000000"
        ajuda="Deixe em branco se ainda não configurou a verificação em duas etapas."
      />

      <Button type="submit" variante="primario" tamanho="lg" className="w-full" disabled={enviando}>
        {enviando ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  )
}
