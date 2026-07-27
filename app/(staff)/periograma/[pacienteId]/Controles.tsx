'use client'

import { Button } from '@/components/ui/Button'
import { abrirPeriograma, concluirPeriograma } from '@/lib/periodontal/acoes'
import { useState } from 'react'
import { GradeDeSondagem, type DenteNaTela, type MedidaGravada } from './GradeDeSondagem'

/**
 * Os controles do exame, separados da grade.
 *
 * A grade é o componente que ganha e perde foco 192 vezes; abrir e concluir são dois
 * botões que mudam a página. Juntá-los faria um estado de botão re-renderizar a
 * grade inteira — e re-render no meio de um ditado é foco perdido, que é o custo mais
 * alto que esta tela pode ter.
 */

export function AbrirExame({ pacienteId }: { readonly pacienteId: string }) {
  const [estado, setEstado] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        variante="primario"
        disabled={ocupado}
        onClick={async () => {
          setOcupado(true)
          const r = await abrirPeriograma(pacienteId)
          setEstado(r.mensagem)
          setOcupado(false)
        }}
      >
        Abrir exame
      </Button>
      {estado && <span className="text-sm text-fg-2">{estado}</span>}
    </div>
  )
}

export function GradeComConclusao({
  periogramaId,
  dentes,
  gravadas,
  achados,
  somenteLeitura,
}: {
  readonly periogramaId: string
  readonly dentes: readonly DenteNaTela[]
  readonly gravadas: readonly MedidaGravada[]
  readonly achados: readonly { denteFdi: number; mobilidade: number | null; furca: number | null }[]
  readonly somenteLeitura: boolean
}) {
  const [estado, setEstado] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  return (
    <div className="space-y-4">
      <GradeDeSondagem
        periogramaId={periogramaId}
        dentes={dentes}
        gravadas={gravadas}
        achados={achados}
        somenteLeitura={somenteLeitura}
      />
      {!somenteLeitura && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button
            variante="secundario"
            disabled={ocupado}
            onClick={async () => {
              setOcupado(true)
              const r = await concluirPeriograma(periogramaId)
              setEstado(r.mensagem)
              setOcupado(false)
            }}
          >
            Concluir exame
          </Button>
          <span className="text-xs text-fg-2">
            Concluir fecha o exame para edição. Os dentes já gravados não dependem disto.
          </span>
          {estado && <span className="text-sm text-fg-2">{estado}</span>}
        </div>
      )}
    </div>
  )
}
