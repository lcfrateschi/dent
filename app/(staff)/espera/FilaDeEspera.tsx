'use client'

import { Button } from '@/components/ui/Button'
import { encerrarEspera } from '@/lib/autoatendimento/acoes'
import { cn } from '@/lib/ui/cn'
import Link from 'next/link'
import { useState, useTransition } from 'react'

export interface LinhaNaTela {
  id: string
  pacienteId: string
  pacienteNome: string
  telefone: string | null
  procedimentoNome: string | null
  turnoRotulo: string
  observacao: string | null
  validoAteBr: string
  pediuEmBr: string
  vencida: boolean
}

/**
 * A fila de espera, trabalhável.
 *
 * ── Encerrar exige motivo; atender não ─────────────────────────────────────
 * "Atendido" se explica sozinho. "Encerrado" é a linha que responde, três meses
 * depois, por que aquele paciente nunca foi chamado — e o CHECK do banco cobra o
 * motivo de todo modo. Pedir aqui só serve para a mensagem ser legível em vez de vir
 * do Postgres.
 *
 * ── "Atendido" não agenda, e o botão diz isso ──────────────────────────────
 * Marcar aqui não cria agendamento: quem marca é a agenda, com a EXCLUDE constraint
 * que impede duas pessoas no mesmo horário. Um botão que fizesse as duas coisas
 * seria um segundo caminho para gravar agenda — e o segundo caminho é o que esquece
 * uma trava. O rótulo é "Agendei — marcar como atendido", na ordem em que acontece.
 */
export function FilaDeEspera({
  linhas,
  podeTrabalhar,
}: {
  linhas: readonly LinhaNaTela[]
  podeTrabalhar: boolean
}) {
  const [encerrando, setEncerrando] = useState<string | null>(null)
  const [motivo, setMotivo] = useState('')
  const [aviso, setAviso] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  function executar(entrada: {
    id: string
    situacao: 'atendida' | 'encerrada'
    motivo?: string
  }): void {
    iniciar(async () => {
      const r = await encerrarEspera(entrada)
      setAviso(r.mensagem)
      if (r.ok) {
        setEncerrando(null)
        setMotivo('')
      }
    })
  }

  return (
    <div>
      {aviso ? (
        <p className="border-b border-border bg-surface-2 px-4 py-2 text-sm text-fg-2" role="status">
          {aviso}
        </p>
      ) : null}

      <ul className="divide-y divide-border">
        {linhas.map((l) => (
          <li key={l.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Link
                href={`/pacientes/${l.pacienteId}`}
                className="font-medium text-fg underline-offset-2 hover:underline"
              >
                {l.pacienteNome}
              </Link>

              <span
                className={cn(
                  'rounded-(--radius-controle) px-2 py-0.5 text-xs',
                  l.vencida ? 'bg-atencao/15 text-atencao' : 'bg-surface-2 text-fg-2',
                )}
              >
                {l.turnoRotulo}
              </span>

              {l.telefone ? (
                <a href={`tel:${l.telefone}`} className="text-sm text-fg-2 hover:text-fg">
                  {l.telefone}
                </a>
              ) : (
                <span className="text-sm text-fg-3">sem telefone</span>
              )}
            </div>

            <p className="mt-1 text-sm text-fg-2">
              {l.procedimentoNome ?? 'Qualquer atendimento'} · pediu em {l.pediuEmBr} ·{' '}
              {l.vencida ? (
                <span className="text-atencao">esperava até {l.validoAteBr} (vencido)</span>
              ) : (
                <>espera até {l.validoAteBr}</>
              )}
            </p>

            {l.observacao ? (
              <p className="mt-1 text-sm text-fg-3">“{l.observacao}”</p>
            ) : null}

            {podeTrabalhar ? (
              encerrando === l.id ? (
                <div className="mt-2 space-y-2">
                  <label htmlFor={`motivo-${l.id}`} className="block text-sm text-fg-2">
                    Por que saiu da fila sem ser atendido?
                  </label>
                  <input
                    id={`motivo-${l.id}`}
                    value={motivo}
                    onChange={(e) => setMotivo(e.currentTarget.value)}
                    placeholder="Desistiu, não respondeu, prazo venceu…"
                    className="h-9 w-full max-w-md rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg"
                  />
                  <div className="flex gap-2">
                    <Button
                      tamanho="sm"
                      variante="primario"
                      disabled={pendente || motivo.trim().length === 0}
                      onClick={() =>
                        executar({ id: l.id, situacao: 'encerrada', motivo: motivo.trim() })
                      }
                    >
                      {pendente ? 'Encerrando…' : 'Encerrar'}
                    </Button>
                    <Button
                      tamanho="sm"
                      variante="fantasma"
                      disabled={pendente}
                      onClick={() => {
                        setEncerrando(null)
                        setMotivo('')
                      }}
                    >
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    tamanho="sm"
                    disabled={pendente}
                    onClick={() => executar({ id: l.id, situacao: 'atendida' })}
                  >
                    Agendei — marcar como atendido
                  </Button>
                  <Button
                    tamanho="sm"
                    variante="fantasma"
                    disabled={pendente}
                    onClick={() => {
                      setEncerrando(l.id)
                      setMotivo('')
                      setAviso(null)
                    }}
                  >
                    Encerrar sem atender
                  </Button>
                </div>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
