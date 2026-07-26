'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import {
  aceitarWhatsappNoPortal,
  revogarMeuConsentimentoWhatsapp,
  trocarMinhaSenha,
} from '@/lib/portal/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Autorizar e revogar o contato por WhatsApp.
 *
 * O termo integral fica visível antes do aceite, igual à versão que a recepção lê
 * em voz alta. Consentimento escondido atrás de "li e concordo" é o que a LGPD
 * chama de consentimento e um juiz não.
 */
export function ControlesDeConsentimento({
  autorizado,
  termo,
}: {
  autorizado: boolean
  termo: string
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [lendo, setLendo] = useState(false)
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  function executar(fn: () => Promise<{ ok: boolean; mensagem: string }>): void {
    iniciar(async () => {
      const r = await fn()
      setAviso(r)
      setLendo(false)
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        {autorizado ? (
          <span className="font-medium text-sucesso">
            <span aria-hidden>✓</span> Você autoriza lembretes por WhatsApp
          </span>
        ) : (
          <span className="font-medium text-fg-2">
            <span aria-hidden>○</span> Você não autoriza lembretes por WhatsApp
          </span>
        )}
      </p>

      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      {autorizado ? (
        <Button
          disabled={pendente}
          onClick={() => executar(revogarMeuConsentimentoWhatsapp)}
        >
          {pendente ? 'Revogando…' : 'Não quero mais receber'}
        </Button>
      ) : lendo ? (
        <div className="space-y-2">
          <blockquote className="rounded-(--radius-controle) border border-border bg-surface-2 px-3 py-2 text-xs text-fg-2">
            {termo}
          </blockquote>
          <div className="flex flex-wrap gap-2">
            <Button
              variante="primario"
              disabled={pendente}
              onClick={() => executar(aceitarWhatsappNoPortal)}
            >
              {pendente ? 'Registrando…' : 'Autorizo'}
            </Button>
            <Button variante="fantasma" onClick={() => setLendo(false)}>
              Fechar
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setLendo(true)}>Ler o termo e autorizar</Button>
      )}
    </div>
  )
}

/**
 * Troca de senha.
 *
 * Avisa antes que vai desconectar tudo. A troca derruba todas as sessões de
 * propósito — é o cenário do celular perdido: sem isso, quem já estava dentro
 * continuaria dentro depois da troca.
 */
export function FormularioTrocarSenha() {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [senhaAtual, setSenhaAtual] = useState('')
  const [nova, setNova] = useState('')
  const [repetir, setRepetir] = useState('')
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  if (aviso?.ok) {
    return (
      <div className="space-y-2">
        <Alerta tipo="sucesso">{aviso.mensagem}</Alerta>
        <Button variante="primario" onClick={() => router.push('/meu/entrar')}>
          Entrar de novo
        </Button>
      </div>
    )
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        iniciar(async () => {
          const r = await trocarMinhaSenha({ senhaAtual, nova, repetir })
          setAviso(r)
          if (r.ok) router.refresh()
        })
      }}
    >
      <div>
        <label htmlFor="atual" className="mb-1 block text-sm font-medium text-fg-2">
          Senha atual
        </label>
        <input
          id="atual"
          type="password"
          autoComplete="current-password"
          required
          value={senhaAtual}
          onChange={(e) => setSenhaAtual(e.currentTarget.value)}
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
      </div>

      <div>
        <label htmlFor="nova" className="mb-1 block text-sm font-medium text-fg-2">
          Nova senha
        </label>
        <input
          id="nova"
          type="password"
          autoComplete="new-password"
          required
          value={nova}
          onChange={(e) => setNova(e.currentTarget.value)}
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
        <p className="mt-1 text-xs text-fg-3">
          Pelo menos 10 caracteres. Não use sua data de nascimento, nome ou CPF.
        </p>
      </div>

      <div>
        <label htmlFor="repetir" className="mb-1 block text-sm font-medium text-fg-2">
          Repita a nova senha
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

      {aviso && !aviso.ok ? <Alerta>{aviso.mensagem}</Alerta> : null}

      <Button type="submit" disabled={pendente}>
        {pendente ? 'Trocando…' : 'Trocar senha'}
      </Button>
    </form>
  )
}
