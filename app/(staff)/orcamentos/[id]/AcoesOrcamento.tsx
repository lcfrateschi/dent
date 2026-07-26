'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { excluirRascunho, mudarStatusOrcamento } from '@/lib/orcamento/acoes'
import type { StatusOrcamento } from '@/lib/domain/orcamento'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Botões de decisão do orçamento.
 *
 * O aviso de congelamento aparece ANTES de enviar, não depois. Depois de
 * enviado o banco recusa qualquer alteração de conteúdo — e descobrir isso
 * tentando editar é uma experiência ruim que dá para evitar com uma frase.
 */
export function AcoesOrcamento({
  id,
  status,
  numero,
  pacienteId,
  temLinhas,
}: {
  id: string
  status: StatusOrcamento
  numero: number
  pacienteId: string
  temLinhas: boolean
}) {
  const router = useRouter()
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  function mudar(para: StatusOrcamento, confirmacao?: string): void {
    if (confirmacao && !window.confirm(confirmacao)) return
    setErro(null)
    iniciar(async () => {
      const r = await mudarStatusOrcamento(id, para)
      if (!r.ok) {
        setErro(r.mensagem)
        return
      }
      router.refresh()
    })
  }

  function excluir(): void {
    if (!window.confirm(`Excluir o rascunho #${numero}?`)) return
    setErro(null)
    iniciar(async () => {
      const r = await excluirRascunho(id)
      if (!r.ok) {
        setErro(r.mensagem)
        return
      }
      router.push(`/pacientes/${pacienteId}/plano`)
    })
  }

  return (
    <div className="space-y-2">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <div className="flex flex-wrap gap-2">
        {status === 'rascunho' ? (
          <>
            <Button
              variante="primario"
              disabled={pendente || !temLinhas}
              onClick={() =>
                mudar(
                  'enviado',
                  'Marcar como enviado ao paciente?\n\nDepois disso o conteúdo fica congelado: valor, itens e validade não podem mais ser alterados. Para mudar algo, gere um novo orçamento.',
                )
              }
            >
              {pendente ? 'Enviando…' : 'Marcar como enviado'}
            </Button>
            <Button variante="fantasma" disabled={pendente} onClick={excluir}>
              Excluir rascunho
            </Button>
          </>
        ) : null}

        {status === 'enviado' ? (
          <>
            <Button
              variante="primario"
              disabled={pendente}
              onClick={() =>
                mudar(
                  'aprovado',
                  'Registrar aprovação do paciente?\n\nOs itens do plano que estão neste orçamento passam de "proposto" para "aprovado".',
                )
              }
            >
              Paciente aprovou
            </Button>
            <Button
              disabled={pendente}
              onClick={() => mudar('recusado', 'Registrar recusa do paciente?')}
            >
              Paciente recusou
            </Button>
            <Button
              variante="fantasma"
              disabled={pendente}
              onClick={() => mudar('expirado', 'Encerrar este orçamento como expirado?')}
            >
              Marcar expirado
            </Button>
          </>
        ) : null}
      </div>

      {status === 'rascunho' ? (
        <p className="text-xs text-fg-3">
          Enquanto é rascunho, o orçamento pode ser excluído e regerado. Depois de enviado, o
          conteúdo é imutável — garantido pelo banco, não só pela tela.
        </p>
      ) : null}
    </div>
  )
}
