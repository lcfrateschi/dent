'use client'

import { Button } from '@/components/ui/Button'
import { Icone } from '@/components/ui/Icone'
import {
  registrarConsentimentoWhatsapp,
  revogarConsentimentoWhatsapp,
} from '@/lib/mensageria/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Autorização de contato por WhatsApp na ficha do paciente.
 *
 * Mostra o **texto integral do termo** antes de registrar, e não uma frase do
 * tipo "aceita receber mensagens?". A recepção lê isso em voz alta para o
 * paciente; se o termo estiver escondido atrás de um link, ninguém lê, e o
 * consentimento perde a validade que era todo o objetivo dele.
 */
export function ConsentimentoWhatsapp({
  pacienteId,
  autorizado,
  temCelular,
  termo,
  versao,
  podeEditar,
}: {
  pacienteId: string
  autorizado: boolean
  temCelular: boolean
  termo: string
  versao: string
  podeEditar: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean } | null>(null)

  function executar(fn: () => Promise<{ ok: boolean; mensagem: string }>): void {
    iniciar(async () => {
      const r = await fn()
      setAviso({ texto: r.mensagem, ok: r.ok })
      if (r.ok) setAberto(false)
      router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className={autorizado ? 'font-medium text-sucesso' : 'font-medium text-fg-2'}>
          <span aria-hidden>{autorizado ? '✓' : '○'}</span>{' '}
          {autorizado ? 'Autorizado a receber lembretes' : 'Sem autorização para WhatsApp'}
        </span>
        {autorizado ? (
          <span className="text-xs text-fg-3">termo v{versao}</span>
        ) : null}
      </p>

      {!temCelular ? (
        <p className="text-xs text-atencao">
          <span aria-hidden>⚠</span> O telefone cadastrado não é celular — mesmo autorizado, não
          há para onde enviar.
        </p>
      ) : null}

      {aviso ? (
        <p className={aviso.ok ? 'text-xs text-sucesso' : 'text-xs text-critico'} role="status">
          <span aria-hidden>{aviso.ok ? '✓' : '✕'}</span> {aviso.texto}
        </p>
      ) : null}

      {!podeEditar ? null : autorizado ? (
        <Button
          tamanho="sm"
          variante="fantasma"
          disabled={pendente}
          onClick={() => executar(() => revogarConsentimentoWhatsapp(pacienteId))}
        >
          {pendente ? 'Revogando…' : 'Revogar autorização'}
        </Button>
      ) : (
        <div className="space-y-2">
          {aberto ? (
            <>
              <blockquote className="rounded-(--radius-controle) border border-border bg-surface-2 px-3 py-2 text-xs text-fg-2">
                {termo}
              </blockquote>
              <div className="flex gap-2">
                <Button
                  tamanho="sm"
                  variante="primario"
                  disabled={pendente}
                  onClick={() => executar(() => registrarConsentimentoWhatsapp(pacienteId))}
                >
                  <Icone nome="whatsapp" tamanho={14} />
                  {pendente ? 'Registrando…' : 'O paciente autorizou'}
                </Button>
                <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(false)}>
                  Fechar
                </Button>
              </div>
            </>
          ) : (
            <Button tamanho="sm" onClick={() => setAberto(true)}>
              Ler o termo e autorizar
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
