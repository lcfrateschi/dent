'use client'

import { Button } from '@/components/ui/Button'
import { promoverProposta } from '@/lib/periodontal/acoes'
import { useState } from 'react'

/**
 * Comparação A/B de propostas de tratamento.
 *
 * ── Por que promover é uma operação e não um clique em cascata ──────────────
 * A trava `plano_um_ativo_por_paciente` **não foi afrouxada**: continua havendo no
 * máximo um plano ativo por paciente, porque com dois fica indefinido qual está sendo
 * executado. Então promover a proposta B significa, na mesma transação, cancelar as
 * irmãs em rascunho e ativar a escolhida. Fora de transação, o índice recusaria a
 * segunda perna e o paciente ficaria sem plano nenhum — ver `promoverProposta`.
 *
 * ── O que esta tela deliberadamente NÃO faz ────────────────────────────────
 * Não grava "qual proposta o paciente escolheu" como campo próprio. Isso já está no
 * **orçamento**, que é documento congelado: se o plano mudar, o orçamento enviado não
 * muda — gera-se outro. Duplicar a escolha aqui criaria duas versões da mesma verdade,
 * e a que vale é a que o paciente assinou.
 */
export interface PropostaNaTela {
  readonly id: string
  readonly status: 'rascunho' | 'ativo' | 'concluido' | 'cancelado'
  readonly itens: number
  readonly totalBr: string
  readonly criadoEmBr: string
  readonly observacao: string | null
}

const LETRA = ['A', 'B', 'C', 'D', 'E', 'F']

export function Propostas({
  propostas,
  podeEditar,
}: {
  readonly propostas: readonly PropostaNaTela[]
  readonly podeEditar: boolean
}) {
  const [estado, setEstado] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {propostas.map((p, i) => (
          <div
            key={p.id}
            className={`rounded border p-3 ${
              p.status === 'ativo' ? 'border-primary bg-surface-2' : 'border-border'
            }`}
          >
            <div className="flex items-baseline justify-between">
              <p className="font-medium text-fg">Proposta {LETRA[i] ?? i + 1}</p>
              <span className="text-xs text-fg-2">{p.status}</span>
            </div>
            <p className="mt-1 text-lg tabular-nums text-fg">{p.totalBr}</p>
            <p className="text-xs text-fg-2">
              {p.itens} item(ns) · criada em {p.criadoEmBr}
            </p>
            {p.observacao && <p className="mt-1 text-xs text-fg-2">{p.observacao}</p>}

            {podeEditar && p.status === 'rascunho' && (
              <Button
                tamanho="sm"
                className="mt-2"
                disabled={ocupado !== null}
                onClick={async () => {
                  setOcupado(p.id)
                  const r = await promoverProposta(p.id)
                  setEstado(r.mensagem)
                  setOcupado(null)
                }}
              >
                {ocupado === p.id ? 'promovendo…' : 'Tornar o plano ativo'}
              </Button>
            )}
            {p.status === 'ativo' && (
              <p className="mt-2 text-xs text-primary">É o plano em execução.</p>
            )}
          </div>
        ))}
      </div>

      {podeEditar && (
        <p className="text-xs text-fg-2">
          Promover uma proposta <strong>cancela as outras do grupo</strong>: o paciente tem no
          máximo um plano em execução, senão fica indefinido qual está sendo feito.
        </p>
      )}
      {estado && <p className="text-sm text-fg-2">{estado}</p>}
    </div>
  )
}
