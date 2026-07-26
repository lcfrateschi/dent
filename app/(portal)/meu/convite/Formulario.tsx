'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { definirSenhaComConvite } from '@/lib/portal/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Definição da primeira senha.
 *
 * A dica de senha aparece **antes** de a pessoa tentar, e lista o que não pode em
 * vez de só o mínimo de caracteres. O paciente vai tentar a data de nascimento — é
 * o palpite universal —, e avisar antes evita três tentativas recusadas seguidas.
 */
export function FormularioConvite({ codigoInicial }: { codigoInicial: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [codigo, setCodigo] = useState(codigoInicial)
  const [senha, setSenha] = useState('')
  const [repetir, setRepetir] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        setErro(null)
        iniciar(async () => {
          const r = await definirSenhaComConvite({ token: codigo, senha, repetirSenha: repetir })
          if (r.ok) {
            router.push('/meu')
            router.refresh()
          } else {
            setErro(r.mensagem)
          }
        })
      }}
    >
      <div>
        <label htmlFor="codigo" className="mb-1 block text-sm font-medium text-fg-2">
          Código de convite
        </label>
        <input
          id="codigo"
          required
          value={codigo}
          onChange={(e) => setCodigo(e.currentTarget.value)}
          placeholder="A3F7-K92M-XY4B-..."
          // Maiúsculas e hífen são aceitos como vierem: `normalizar` no servidor
          // tolera espaço, hífen e minúscula.
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 font-mono text-fg placeholder:text-fg-3"
        />
      </div>

      <div>
        <label htmlFor="senha" className="mb-1 block text-sm font-medium text-fg-2">
          Crie sua senha
        </label>
        <input
          id="senha"
          type="password"
          autoComplete="new-password"
          required
          value={senha}
          onChange={(e) => setSenha(e.currentTarget.value)}
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
        <ul className="mt-1.5 space-y-0.5 text-xs text-fg-3">
          <li>Pelo menos 10 caracteres — uma frase curta funciona bem.</li>
          <li>Não use sua data de nascimento, seu nome nem seu CPF.</li>
          <li>Não use só números.</li>
        </ul>
      </div>

      <div>
        <label htmlFor="repetir" className="mb-1 block text-sm font-medium text-fg-2">
          Repita a senha
        </label>
        <input
          id="repetir"
          type="password"
          autoComplete="new-password"
          required
          value={repetir}
          onChange={(e) => setRepetir(e.currentTarget.value)}
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
      </div>

      {erro ? <Alerta>{erro}</Alerta> : null}

      <Button type="submit" variante="primario" tamanho="lg" disabled={pendente}>
        {pendente ? 'Criando…' : 'Criar senha e entrar'}
      </Button>
    </form>
  )
}
