'use client'

import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { lancarBiologico, registrarCiclo } from '@/lib/periodontal/acoes'
import { useState } from 'react'

export function NovaCarga({
  autoclaves,
  numeroSugerido,
}: {
  readonly autoclaves: readonly { id: string; nome: string }[]
  readonly numeroSugerido: number
}) {
  const [autoclaveId, setAutoclaveId] = useState(autoclaves[0]?.id ?? '')
  const [numero, setNumero] = useState(String(numeroSugerido))
  const [conteudo, setConteudo] = useState('')
  const [programa, setPrograma] = useState('')
  const [quimico, setQuimico] = useState<'aprovado' | 'reprovado'>('aprovado')
  const [estado, setEstado] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setOcupado(true)
        const r = await registrarCiclo({
          autoclaveId,
          numero: Number(numero),
          conteudo,
          indicadorQuimico: quimico,
          programa: programa || undefined,
        })
        setEstado(r.mensagem)
        if (r.ok) {
          setConteudo('')
          // O número sobe sozinho: quem registra três cargas seguidas não deve
          // redigitar. É sugestão — o índice único recusa se a etiqueta divergir.
          setNumero(String(Number(numero) + 1))
        }
        setOcupado(false)
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          id="carga-autoclave"
          rotulo="Autoclave"
          obrigatorio
          value={autoclaveId}
          onChange={(e) => setAutoclaveId(e.target.value)}
        >
          {autoclaves.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nome}
            </option>
          ))}
        </Select>
        <Input
          id="carga-numero"
          rotulo="Número da carga"
          ajuda="O que está na etiqueta. Reinicia a cada dia."
          obrigatorio
          inputMode="numeric"
          value={numero}
          onChange={(e) => setNumero(e.target.value.replace(/[^0-9]/g, ''))}
        />
        <Input
          id="carga-programa"
          rotulo="Programa"
          ajuda='Como o equipamento o chama ("134 °C embalado").'
          value={programa}
          onChange={(e) => setPrograma(e.target.value)}
        />
      </div>

      <Input
        id="carga-conteudo"
        rotulo="Conteúdo"
        ajuda="⚠️ Texto livre — descreva o que dá para conferir depois. Não é rastreabilidade até o paciente."
        obrigatorio
        value={conteudo}
        onChange={(e) => setConteudo(e.target.value)}
      />

      <Select
        id="carga-quimico"
        rotulo="Indicador químico"
        ajuda="Sai junto com a carga. O biológico é lançado depois."
        obrigatorio
        value={quimico}
        onChange={(e) => setQuimico(e.target.value as 'aprovado' | 'reprovado')}
      >
        <option value="aprovado">aprovado</option>
        <option value="reprovado">reprovado</option>
      </Select>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variante="primario" disabled={ocupado || conteudo.trim() === ''}>
          Registrar carga
        </Button>
        {estado && <span className="text-sm text-fg-2">{estado}</span>}
      </div>
    </form>
  )
}

/**
 * Lança o resultado do biológico.
 *
 * Não há "editar resultado": a ação só aceita ciclo `pendente`. Um biológico positivo
 * é justamente o que ninguém pode reescrever em silêncio — corrigir uma leitura errada
 * é assunto de registro novo com justificativa, não de um clique que apaga o anterior.
 */
export function LancarBiologico({ id }: { readonly id: string }) {
  const [estado, setEstado] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  const lancar = async (r: 'negativo' | 'positivo') => {
    setOcupado(true)
    const res = await lancarBiologico(id, r)
    setEstado(res.mensagem)
    setOcupado(false)
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Button tamanho="sm" disabled={ocupado} onClick={() => void lancar('negativo')}>
          Negativo
        </Button>
        <Button tamanho="sm" disabled={ocupado} onClick={() => void lancar('positivo')}>
          Positivo
        </Button>
      </div>
      {estado && <p className="text-xs text-fg-2">{estado}</p>}
    </div>
  )
}
