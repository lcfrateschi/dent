'use client'

import { PainelDeBaixa } from '@/components/estoque/PainelDeBaixa'
import { Button } from '@/components/ui/Button'
import { useState } from 'react'

export interface PendenteNaTela {
  execucaoId: string
  executadoEmIso: string
  pacienteId: string
  pacienteNome: string
  procedimentoNome: string
  denteFdi: number | null
  profissionalNome: string | null
  diasAtras: number
}

/**
 * Fila de consumo a lançar.
 *
 * Cada linha é um atendimento cujo procedimento tem ficha técnica e cujo material
 * não foi baixado. Abre o mesmo painel do odontograma, com o lote FEFO já
 * escolhido.
 *
 * A **idade** de cada pendência está à vista de propósito: consumo esquecido há
 * duas semanas é o que mais distorce o saldo, e é o que a pessoa lembra pior.
 * Depois de muitos dias, confirmar a média da ficha é menos exato — mas continua
 * melhor que deixar o saldo mentindo.
 */
export function ConsumoPendente({ pendentes }: { pendentes: readonly PendenteNaTela[] }) {
  const [aberta, setAberta] = useState<string | null>(null)

  if (pendentes.length === 0) {
    return (
      <p className="p-4 text-sm text-fg-2">
        Nenhum consumo pendente: todo atendimento com ficha técnica teve o material lançado.
      </p>
    )
  }

  return (
    <div className="divide-y divide-border">
      {pendentes.map((p) => (
        <div key={p.execucaoId} className="px-4 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span className="font-medium text-fg">{p.procedimentoNome}</span>
              {p.denteFdi ? <span className="ml-2 text-fg-2">dente {p.denteFdi}</span> : null}
              <span className="block text-xs text-fg-3">
                {p.pacienteNome}
                {p.profissionalNome ? ` · ${p.profissionalNome}` : null} ·{' '}
                {p.diasAtras === 0
                  ? 'hoje'
                  : p.diasAtras === 1
                    ? 'ontem'
                    : `há ${p.diasAtras} dias`}
              </span>
            </div>
            <Button
              tamanho="sm"
              variante={aberta === p.execucaoId ? 'fantasma' : 'secundario'}
              onClick={() => setAberta(aberta === p.execucaoId ? null : p.execucaoId)}
            >
              {aberta === p.execucaoId ? 'Fechar' : 'Lançar material'}
            </Button>
          </div>
          {aberta === p.execucaoId ? (
            <div className="mt-2">
              <PainelDeBaixa
                execucaoId={p.execucaoId}
                compacto
                aoConcluir={() => setAberta(null)}
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
