'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { apagarPreco, fecharVigencia, salvarPreco } from '@/lib/convenios/acoes'
import { reais } from '@/lib/ui/moeda'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const campo =
  'h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg placeholder:text-fg-3'

interface Procedimento {
  id: string
  codigo: string
  nome: string
  valorParticular: string
}

/**
 * Cadastro de preço negociado.
 *
 * O seletor mostra **dois grupos**: procedimentos sem preço vigente (o trabalho a
 * fazer) e os que já têm (para reajuste). A separação é a diferença entre
 * "cadastrar o que falta" e "reajustar o que existe" — duas intenções que se
 * confundem quando a lista é única, e confundir aqui produz preço sobreposto.
 */
export function NovoPreco({
  convenioId,
  hoje,
  procedimentos,
  comPrecoVigente,
}: {
  convenioId: string
  hoje: string
  procedimentos: readonly Procedimento[]
  comPrecoVigente: readonly Procedimento[]
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [procedimentoId, setProcedimentoId] = useState(procedimentos[0]?.id ?? comPrecoVigente[0]?.id ?? '')
  const [valor, setValor] = useState('')
  const [cobertura, setCobertura] = useState('100')
  const [carencia, setCarencia] = useState('0')
  const [inicio, setInicio] = useState(hoje)
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  const escolhido =
    procedimentos.find((p) => p.id === procedimentoId) ??
    comPrecoVigente.find((p) => p.id === procedimentoId)
  const ehReajuste = comPrecoVigente.some((p) => p.id === procedimentoId)

  const coparticipacao =
    valor && Number(cobertura) < 100
      ? (Number(valor) * (1 - Number(cobertura) / 100)).toFixed(2)
      : null

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        iniciar(async () => {
          const r = await salvarPreco({
            convenioId,
            procedimentoId,
            valor,
            coberturaPct: cobertura,
            carenciaDias: Number(carencia),
            vigenciaInicio: inicio,
          })
          setAviso(r)
          if (r.ok) {
            setValor('')
            router.refresh()
          }
        })
      }}
    >
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="sm:col-span-2">
          <label htmlFor="p-proc" className="block text-xs font-medium text-fg-2">
            Procedimento
          </label>
          <select
            id="p-proc"
            value={procedimentoId}
            onChange={(e) => setProcedimentoId(e.currentTarget.value)}
            className={`${campo} mt-1`}
          >
            {procedimentos.length > 0 ? (
              <optgroup label="Sem preço vigente">
                {procedimentos.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome} ({p.codigo})
                  </option>
                ))}
              </optgroup>
            ) : null}
            {comPrecoVigente.length > 0 ? (
              <optgroup label="Reajustar (já tem preço)">
                {comPrecoVigente.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome} ({p.codigo})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {escolhido ? (
            <p className="mt-1 text-xs text-fg-3">
              Particular: {reais(escolhido.valorParticular)}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="p-valor" className="block text-xs font-medium text-fg-2">
            Convênio paga
          </label>
          <input
            id="p-valor"
            value={valor}
            onChange={(e) => setValor(e.currentTarget.value)}
            placeholder="120.00"
            className={`${campo} mt-1`}
            required
          />
        </div>

        <div>
          <label htmlFor="p-cob" className="block text-xs font-medium text-fg-2">
            Cobertura (%)
          </label>
          <input
            id="p-cob"
            value={cobertura}
            onChange={(e) => setCobertura(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
          {coparticipacao ? (
            <p className="mt-1 text-xs text-fg-3">
              Paciente paga {reais(coparticipacao)}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="p-inicio" className="block text-xs font-medium text-fg-2">
            Vigência a partir de
          </label>
          <input
            id="p-inicio"
            type="date"
            value={inicio}
            onChange={(e) => setInicio(e.currentTarget.value)}
            className={`${campo} mt-1`}
            required
          />
        </div>

        <div>
          <label htmlFor="p-car" className="block text-xs font-medium text-fg-2">
            Carência (dias)
          </label>
          <input
            id="p-car"
            value={carencia}
            onChange={(e) => setCarencia(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
          <p className="mt-1 text-xs text-fg-3">Contada da adesão do paciente.</p>
        </div>
      </div>

      {ehReajuste ? (
        <p className="text-xs text-atencao">
          <span aria-hidden>⚠</span> Este procedimento já tem preço vigente. Ao salvar, a vigência
          atual será <strong>fechada no dia anterior</strong> a {inicio} — o que já foi faturado
          continua valendo o preço da época.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" variante="primario" disabled={pendente || !procedimentoId}>
          {pendente ? 'Salvando…' : 'Cadastrar preço'}
        </Button>
      </div>
    </form>
  )
}

export function PrecoControles({
  preco,
  convenioId,
  hoje,
}: {
  preco: { id: string; procedimentoNome: string; vigenciaFim: string | null; usosEmGuia: number }
  convenioId: string
  hoje: string
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [modo, setModo] = useState<'nada' | 'fechar'>('nada')
  const [em, setEm] = useState(hoje)
  const [aviso, setAviso] = useState<string | null>(null)

  if (modo === 'fechar') {
    return (
      <div className="w-56 space-y-2">
        <label htmlFor={`fim-${preco.id}`} className="block text-xs font-medium text-fg-2">
          Vigora até
        </label>
        <input
          id={`fim-${preco.id}`}
          type="date"
          value={em}
          onChange={(e) => setEm(e.currentTarget.value)}
          className={campo}
        />
        <p className="text-xs text-fg-3">
          Depois desta data o procedimento fica sem preço nesta operadora, e não poderá ser
          faturado por convênio.
        </p>
        {aviso ? <p className="text-xs text-critico">{aviso}</p> : null}
        <div className="flex gap-1">
          <Button
            tamanho="sm"
            variante="primario"
            disabled={pendente}
            onClick={() =>
              iniciar(async () => {
                const r = await fecharVigencia(preco.id, em, convenioId)
                if (r.ok) {
                  setModo('nada')
                  router.refresh()
                } else {
                  setAviso(r.mensagem)
                }
              })
            }
          >
            {pendente ? '…' : 'Fechar'}
          </Button>
          <Button tamanho="sm" variante="fantasma" onClick={() => setModo('nada')}>
            Voltar
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {aviso ? <p className="text-xs text-critico">{aviso}</p> : null}
      <div className="flex flex-wrap gap-1">
        {preco.vigenciaFim === null ? (
          <Button tamanho="sm" variante="fantasma" onClick={() => setModo('fechar')}>
            Fechar vigência
          </Button>
        ) : null}

        {/*
          Apagar só aparece quando nada foi faturado sob este preço. Mostrar o
          botão sempre e deixá-lo falhar na trava do banco faria a regra parecer
          bug — e a regra é boa: preço faturado é o histórico do que foi
          apresentado à operadora.
        */}
        {preco.usosEmGuia === 0 ? (
          <Button
            tamanho="sm"
            variante="fantasma"
            disabled={pendente}
            title="Só enquanto nada foi faturado sob este preço."
            onClick={() =>
              iniciar(async () => {
                const r = await apagarPreco(preco.id, convenioId)
                if (r.ok) router.refresh()
                else setAviso(r.mensagem)
              })
            }
          >
            Apagar
          </Button>
        ) : (
          <span className="text-xs text-fg-3" title="Preço já usado em guia: é histórico.">
            faturado
          </span>
        )}
      </div>
    </div>
  )
}
