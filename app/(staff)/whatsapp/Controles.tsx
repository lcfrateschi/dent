'use client'

import { Button } from '@/components/ui/Button'
import { Icone } from '@/components/ui/Icone'
import {
  despacharAgora,
  enviarLembrete,
  resolverManualmente,
  tratarResposta,
} from '@/lib/mensageria/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Controles da tela de WhatsApp.
 *
 * Nenhum deles é "reenviar". Isso é decisão de projeto, não omissão: uma
 * mensagem travada pode ter sido entregue, e o botão que parece inofensivo é o
 * que manda dois lembretes para o mesmo paciente. Ver
 * drizzle/0009_mensageria_travas.sql.
 */

function Aviso({ texto, ok }: { texto: string; ok: boolean }) {
  return (
    <span
      role="status"
      className={ok ? 'text-xs font-medium text-sucesso' : 'text-xs font-medium text-critico'}
    >
      <span aria-hidden>{ok ? '✓' : '✕'}</span> {texto}
    </span>
  )
}

export function BotaoDespachar() {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean } | null>(null)

  return (
    <div className="flex items-center gap-2">
      {aviso ? <Aviso {...aviso} /> : null}
      <Button
        disabled={pendente}
        onClick={() =>
          iniciar(async () => {
            const r = await despacharAgora()
            setAviso({ texto: r.mensagem, ok: r.ok })
            router.refresh()
          })
        }
      >
        <Icone nome="enviar" tamanho={14} />
        {pendente ? 'Enviando…' : 'Enviar fila agora'}
      </Button>
    </div>
  )
}

export function BotaoEnviarLembrete({ agendamentoId }: { agendamentoId: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [erro, setErro] = useState<string | null>(null)

  return (
    <div className="flex items-center justify-end gap-2">
      {erro ? <Aviso texto={erro} ok={false} /> : null}
      <Button
        tamanho="sm"
        disabled={pendente}
        onClick={() =>
          iniciar(async () => {
            const r = await enviarLembrete(agendamentoId)
            setErro(r.ok ? null : r.mensagem)
            router.refresh()
          })
        }
      >
        {pendente ? '…' : 'Enfileirar'}
      </Button>
    </div>
  )
}

/**
 * Resolve uma resposta não interpretada.
 *
 * Sempre exige escrever o que foi feito. Um "OK" que só faz o item desaparecer
 * deixa a próxima pessoa sem saber se alguém ligou para o paciente.
 */
export function ResolverResposta({
  respostaId,
  temAgendamento,
  statusAgendamento,
}: {
  respostaId: string
  temAgendamento: boolean
  statusAgendamento: string | null
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [observacao, setObservacao] = useState('')
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean } | null>(null)

  const podeMexerNaAgenda =
    temAgendamento && (statusAgendamento === 'agendado' || statusAgendamento === 'confirmado')

  function executar(fn: () => Promise<{ ok: boolean; mensagem: string }>): void {
    iniciar(async () => {
      const r = await fn()
      setAviso({ texto: r.mensagem, ok: r.ok })
      if (r.ok) setObservacao('')
      router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      <label htmlFor={`obs-${respostaId}`} className="sr-only">
        O que foi feito
      </label>
      <input
        id={`obs-${respostaId}`}
        value={observacao}
        onChange={(e) => setObservacao(e.currentTarget.value)}
        placeholder="O que foi feito? Ex.: liguei, paciente confirmou para as 14h"
        className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
      />

      <div className="flex flex-wrap items-center gap-2">
        {podeMexerNaAgenda ? (
          <>
            <Button
              tamanho="sm"
              variante="primario"
              disabled={pendente}
              onClick={() => executar(() => resolverManualmente(respostaId, 'confirmar', observacao))}
            >
              <Icone nome="confirmado" tamanho={14} />
              Confirmar consulta
            </Button>
            <Button
              tamanho="sm"
              disabled={pendente}
              onClick={() => executar(() => resolverManualmente(respostaId, 'cancelar', observacao))}
            >
              <Icone nome="cancelado" tamanho={14} />
              Cancelar consulta
            </Button>
          </>
        ) : (
          <span className="text-xs text-fg-3">
            {temAgendamento
              ? 'O atendimento não está em estado que aceite confirmação ou cancelamento.'
              : 'Sem consulta vinculada — resolva pela agenda se for o caso.'}
          </span>
        )}

        <Button
          tamanho="sm"
          variante="fantasma"
          disabled={pendente}
          onClick={() => executar(() => tratarResposta(respostaId, observacao))}
        >
          Só marcar como tratada
        </Button>

        {aviso ? <Aviso {...aviso} /> : null}
      </div>
    </div>
  )
}
