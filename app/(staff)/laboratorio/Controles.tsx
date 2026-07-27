'use client'

import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { criarOrdem, mudarSituacaoDaOrdem } from '@/lib/periodontal/acoes'
import { useState } from 'react'

/** Formulário da ordem. O prazo padrão do laboratório pré-preenche a data. */
export function NovaOrdem({
  laboratorios,
  itens,
}: {
  readonly laboratorios: readonly { id: string; nome: string; prazoPadraoDias: number }[]
  readonly itens: readonly { id: string; rotulo: string }[]
}) {
  const [laboratorioId, setLaboratorioId] = useState(laboratorios[0]?.id ?? '')
  const [itemPlanoId, setItemPlanoId] = useState('')
  const [especificacao, setEspecificacao] = useState('')
  const [cor, setCor] = useState('')
  const [custo, setCusto] = useState('')
  const [prazoEm, setPrazoEm] = useState(() => sugerirPrazo(laboratorios[0]?.prazoPadraoDias ?? 7))
  const [estado, setEstado] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setOcupado(true)
        const r = await criarOrdem({
          laboratorioId,
          itemPlanoId,
          especificacao,
          cor: cor || undefined,
          custo: custo || undefined,
          prazoEm: prazoEm || undefined,
        })
        setEstado(r.mensagem)
        if (r.ok) {
          setEspecificacao('')
          setCor('')
          setCusto('')
          setItemPlanoId('')
        }
        setOcupado(false)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          id="ordem-item"
          rotulo="Item do plano"
          obrigatorio
          value={itemPlanoId}
          onChange={(e) => setItemPlanoId(e.target.value)}
        >
          <option value="">Escolha o item</option>
          {itens.map((i) => (
            <option key={i.id} value={i.id}>
              {i.rotulo}
            </option>
          ))}
        </Select>
        <Select
          id="ordem-lab"
          rotulo="Laboratório"
          obrigatorio
          value={laboratorioId}
          onChange={(e) => {
            setLaboratorioId(e.target.value)
            const lab = laboratorios.find((l) => l.id === e.target.value)
            if (lab) setPrazoEm(sugerirPrazo(lab.prazoPadraoDias))
          }}
        >
          {laboratorios.map((l) => (
            <option key={l.id} value={l.id}>
              {l.nome}
            </option>
          ))}
        </Select>
      </div>

      <Input
        id="ordem-especificacao"
        rotulo="Especificação"
        ajuda="O que o laboratório deve fazer. É o texto que vai na ordem."
        obrigatorio
        value={especificacao}
        onChange={(e) => setEspecificacao(e.target.value)}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          id="ordem-cor"
          rotulo="Cor"
          ajuda="Escala Vita (A2, B1…). Cor errada volta como refação."
          value={cor}
          onChange={(e) => setCor(e.target.value)}
        />
        <Input
          id="ordem-prazo"
          rotulo="Prazo combinado"
          type="date"
          value={prazoEm}
          onChange={(e) => setPrazoEm(e.target.value)}
        />
        <Input
          id="ordem-custo"
          rotulo="Custo combinado"
          ajuda="Não é despesa — é o que confere a nota do mês."
          inputMode="decimal"
          value={custo}
          onChange={(e) => setCusto(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variante="primario" disabled={ocupado || !itemPlanoId}>
          Criar ordem
        </Button>
        {estado && <span className="text-sm text-fg-2">{estado}</span>}
      </div>
    </form>
  )
}

/** `prazoPadraoDias` do laboratório em data — só sugestão, a ordem pode divergir. */
function sugerirPrazo(dias: number): string {
  const d = new Date()
  d.setDate(d.getDate() + dias)
  return d.toISOString().slice(0, 10)
}

/**
 * Muda a situação, e **a data vai junto**.
 *
 * Não existe "marcar como recebida" sem registrar quando: o CHECK
 * `ordem_laboratorio_situacao_com_evidencia` recusa estado sem fato, e a interface
 * não tenta contornar a trava — ela obedece.
 */
export function SituacaoDaOrdem({
  id,
  situacao,
  podeEditar,
}: {
  readonly id: string
  readonly situacao: 'aberta' | 'enviada' | 'recebida' | 'cancelada'
  readonly podeEditar: boolean
}) {
  const [estado, setEstado] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const mudar = async (para: 'enviada' | 'recebida' | 'cancelada') => {
    setOcupado(true)
    const r = await mudarSituacaoDaOrdem(id, para)
    setEstado(r.ok ? null : r.mensagem)
    setOcupado(false)
  }

  return (
    <div className="space-y-1">
      <span className="text-xs text-fg-2">{situacao}</span>
      {podeEditar && situacao !== 'recebida' && situacao !== 'cancelada' && (
        <div className="flex flex-wrap gap-1">
          {situacao === 'aberta' && (
            <Button tamanho="sm" disabled={ocupado} onClick={() => void mudar('enviada')}>
              Enviei
            </Button>
          )}
          <Button tamanho="sm" disabled={ocupado} onClick={() => void mudar('recebida')}>
            Voltou
          </Button>
          <Button tamanho="sm" disabled={ocupado} onClick={() => void mudar('cancelada')}>
            Cancelar
          </Button>
        </div>
      )}
      {estado && <p className="text-xs text-critico">{estado}</p>}
    </div>
  )
}
