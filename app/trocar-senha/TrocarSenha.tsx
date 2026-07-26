'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { trocarPropriaSenha } from '@/lib/admin/acoes'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const campo =
  'h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3'

/**
 * Formulário de troca de senha.
 *
 * Três decisões de interface:
 *
 * - **Pede a senha atual.** Sem isso, uma sessão esquecida aberta no balcão
 *   permite tomar a conta. É a mesma exigência do portal do paciente.
 * - **Confirma a nova.** Erro de digitação numa senha que a pessoa acabou de
 *   inventar produz bloqueio no próximo login, e a recuperação depende de um
 *   admin — custo alto para um campo a mais.
 * - **Atualiza a sessão ao terminar.** O token carrega `senhaTemporaria`; sem
 *   atualizá-lo, o middleware devolveria a pessoa para esta mesma tela.
 */
export function TrocarSenha() {
  const router = useRouter()
  const { update } = useSession()
  const [pendente, iniciar] = useTransition()
  const [atual, setAtual] = useState('')
  const [nova, setNova] = useState('')
  const [confirmacao, setConfirmacao] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [pronto, setPronto] = useState(false)

  const divergem = confirmacao.length > 0 && nova !== confirmacao

  if (pronto) {
    return (
      <div className="space-y-3">
        <Alerta tipo="sucesso">Senha trocada. Bem-vindo ao sistema.</Alerta>
        <Button variante="primario" onClick={() => router.push('/pacientes')}>
          Continuar
        </Button>
      </div>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        setErro(null)
        if (nova !== confirmacao) {
          setErro('A confirmação não é igual à nova senha.')
          return
        }
        iniciar(async () => {
          const r = await trocarPropriaSenha(atual, nova)
          if (!r.ok) {
            setErro(r.mensagem)
            return
          }
          // Sem isto o middleware traria a pessoa de volta para cá.
          await update({ senhaTemporaria: false })
          setPronto(true)
          router.refresh()
        })
      }}
    >
      {erro ? <Alerta tipo="critico">{erro}</Alerta> : null}

      <div>
        <label htmlFor="atual" className="block text-sm font-medium text-fg-2">
          Senha que você recebeu
        </label>
        <input
          id="atual"
          type="password"
          autoComplete="current-password"
          value={atual}
          onChange={(e) => setAtual(e.currentTarget.value)}
          className={`${campo} mt-1`}
          required
        />
      </div>

      <div>
        <label htmlFor="nova" className="block text-sm font-medium text-fg-2">
          Nova senha
        </label>
        <input
          id="nova"
          type="password"
          autoComplete="new-password"
          value={nova}
          onChange={(e) => setNova(e.currentTarget.value)}
          className={`${campo} mt-1`}
          required
        />
        <p className="mt-1 text-xs text-fg-3">
          Pelo menos 12 caracteres. Uma frase que só você diria funciona melhor que
          <code className="mx-1 font-mono">S3nh@!</code>e é mais fácil de lembrar.
        </p>
      </div>

      <div>
        <label htmlFor="confirmacao" className="block text-sm font-medium text-fg-2">
          Repita a nova senha
        </label>
        <input
          id="confirmacao"
          type="password"
          autoComplete="new-password"
          value={confirmacao}
          onChange={(e) => setConfirmacao(e.currentTarget.value)}
          className={`${campo} mt-1`}
          required
        />
        {divergem ? (
          <p className="mt-1 text-xs text-critico">As duas não são iguais.</p>
        ) : null}
      </div>

      <Button
        type="submit"
        variante="primario"
        disabled={pendente || divergem || nova.length === 0}
      >
        {pendente ? 'Trocando…' : 'Trocar senha'}
      </Button>
    </form>
  )
}
