'use client'

import { Button } from '@/components/ui/Button'
import { Icone } from '@/components/ui/Icone'
import { decidirOrcamento } from '@/lib/portal/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Aprovar ou recusar o orçamento.
 *
 * Aprovar pede confirmação em duas etapas. Não é fricção gratuita: é um aceite
 * comercial com valor, e um toque errado na tela do celular não deve virar
 * compromisso de mil reais.
 */
export function DecisaoDoOrcamento({ orcamentoId }: { orcamentoId: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [confirmando, setConfirmando] = useState(false)
  const [resultado, setResultado] = useState<{ ok: boolean; mensagem: string } | null>(null)

  function decidir(decisao: 'aprovado' | 'recusado'): void {
    iniciar(async () => {
      const r = await decidirOrcamento(orcamentoId, decisao)
      setResultado(r)
      router.refresh()
    })
  }

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

  if (confirmando) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-fg-2">
          Confirma a aprovação deste orçamento? Isso vale como aceite do valor.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variante="primario" tamanho="lg" disabled={pendente} onClick={() => decidir('aprovado')}>
            {pendente ? 'Aprovando…' : 'Sim, aprovo'}
          </Button>
          <Button tamanho="lg" variante="fantasma" onClick={() => setConfirmando(false)}>
            Voltar
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variante="primario" tamanho="lg" onClick={() => setConfirmando(true)}>
        <Icone nome="confirmado" tamanho={16} />
        Aprovar orçamento
      </Button>
      <Button tamanho="lg" variante="fantasma" disabled={pendente} onClick={() => decidir('recusado')}>
        Não quero agora
      </Button>
    </div>
  )
}
