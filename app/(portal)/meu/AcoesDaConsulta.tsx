'use client'

import { Button } from '@/components/ui/Button'
import { Icone } from '@/components/ui/Icone'
import { avisarQueNaoVou, confirmarMinhaConsulta } from '@/lib/portal/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Confirmar ou avisar que não vem.
 *
 * "Não vou poder ir" **não cancela** a consulta: registra o aviso e a recepção
 * resolve. Duas razões: um toque errado no celular não pode custar o horário do
 * paciente, e a clínica precisa saber para remarcar em vez de descobrir a cadeira
 * vazia. O texto do botão diz exatamente isso, para ninguém achar que cancelou.
 */
export function AcoesDaConsulta({ agendamentoId }: { agendamentoId: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [avisando, setAvisando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [resultado, setResultado] = useState<{ ok: boolean; mensagem: string } | null>(null)

  if (resultado) {
    return (
      <p
        role="status"
        className={resultado.ok ? 'text-sm font-medium text-sucesso' : 'text-sm text-critico'}
      >
        <span aria-hidden>{resultado.ok ? '✓' : '✕'}</span> {resultado.mensagem}
      </p>
    )
  }

  if (avisando) {
    return (
      <div className="space-y-2">
        <label htmlFor={`motivo-${agendamentoId}`} className="block text-sm text-fg-2">
          Quer dizer o motivo? (opcional)
        </label>
        <input
          id={`motivo-${agendamentoId}`}
          value={motivo}
          onChange={(e) => setMotivo(e.currentTarget.value)}
          placeholder="Ex.: viagem de trabalho"
          className="h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg placeholder:text-fg-3"
        />
        <p className="text-xs text-fg-3">
          A consulta <strong>não é cancelada</strong> agora — a clínica vai falar com você para
          remarcar.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={pendente}
            onClick={() =>
              iniciar(async () => {
                const r = await avisarQueNaoVou(agendamentoId, motivo)
                setResultado(r)
                router.refresh()
              })
            }
          >
            {pendente ? 'Avisando…' : 'Avisar a clínica'}
          </Button>
          <Button variante="fantasma" onClick={() => setAvisando(false)}>
            Voltar
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variante="primario"
        tamanho="lg"
        disabled={pendente}
        onClick={() =>
          iniciar(async () => {
            const r = await confirmarMinhaConsulta(agendamentoId)
            setResultado(r)
            router.refresh()
          })
        }
      >
        <Icone nome="confirmado" tamanho={16} />
        {pendente ? 'Confirmando…' : 'Confirmar presença'}
      </Button>
      <Button tamanho="lg" variante="fantasma" onClick={() => setAvisando(true)}>
        Não vou poder ir
      </Button>
    </div>
  )
}
