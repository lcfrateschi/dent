'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import { ajustarValorItem, gerarOrcamento } from '@/lib/orcamento/acoes'
import type { ItemDoPlano, PlanoCompleto, ResumoOrcamento } from '@/lib/orcamento/consultas'
import { calcularTotais } from '@/lib/domain/orcamento'
import { ROTULO_STATUS_ORCAMENTO } from '@/lib/domain/orcamento'
import { cn } from '@/lib/ui/cn'
import { dataBr, reais } from '@/lib/ui/moeda'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'

/**
 * Plano de tratamento e geração de orçamento.
 *
 * O total aparece **enquanto** se marca os itens, calculado pela mesma função
 * pura que o servidor usa (`calcularTotais`). Quem atende precisa dizer o valor
 * ao paciente antes de confirmar — mostrar só depois de salvar obrigaria a
 * gerar e descartar documentos para descobrir o preço.
 */
export function PlanoCliente({
  plano,
  orcamentos,
  podeOrcar,
  podeEditar,
}: {
  plano: PlanoCompleto
  orcamentos: readonly ResumoOrcamento[]
  podeOrcar: boolean
  podeEditar: boolean
}) {
  const router = useRouter()
  const [selecionados, setSelecionados] = useState<Set<string>>(
    // Padrão: tudo que ainda não foi executado. É o caso comum do balcão.
    () => new Set(plano.itens.filter((i) => !i.executado).map((i) => i.id)),
  )
  const [tipoDesconto, setTipoDesconto] = useState<'valor' | 'percentual'>('valor')
  const [desconto, setDesconto] = useState('0')
  const [dias, setDias] = useState(30)
  const [observacao, setObservacao] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  const itensSelecionados = plano.itens.filter((i) => selecionados.has(i.id))

  const totais = useMemo(() => {
    const linhas = itensSelecionados.map((i) => ({
      descricao: i.descricao,
      quantidade: 1,
      valorUnitario: i.valorPaciente,
    }))
    try {
      return calcularTotais(
        linhas,
        tipoDesconto === 'valor'
          ? { tipo: 'valor', valor: desconto || '0' }
          : { tipo: 'percentual', pct: desconto || '0' },
      )
    } catch {
      // Desconto inválido enquanto se digita: mostra o bruto e o servidor recusa.
      return { valorBruto: linhas.reduce((a, l) => a, '0.00'), desconto: '—', valorTotal: '—' }
    }
  }, [itensSelecionados, tipoDesconto, desconto])

  function alternar(id: string): void {
    setSelecionados((s) => {
      const proximo = new Set(s)
      if (proximo.has(id)) proximo.delete(id)
      else proximo.add(id)
      return proximo
    })
  }

  function gerar(): void {
    setErro(null)
    iniciar(async () => {
      const r = await gerarOrcamento({
        pacienteId: plano.pacienteId,
        planoId: plano.id,
        itemIds: [...selecionados],
        desconto:
          tipoDesconto === 'valor'
            ? { tipo: 'valor', valor: desconto || '0' }
            : { tipo: 'percentual', pct: desconto || '0' },
        diasValidade: dias,
        observacao: observacao.trim() || undefined,
      })
      if (!r.ok) {
        setErro(r.mensagem)
        return
      }
      router.push(`/orcamentos/${r.orcamentoId}`)
    })
  }

  return (
    <div className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <Card>
        <CardHeader
          titulo={plano.titulo}
          descricao={`${plano.itens.length} item(ns) · ${plano.profissionalNome}${plano.diagnostico ? ` · ${plano.diagnostico}` : ''}`}
          acoes={
            <Link href={`/pacientes/${plano.pacienteId}/odontograma`}>
              <Button tamanho="sm">
                <Icone nome="odontograma" tamanho={14} />
                Odontograma
              </Button>
            </Link>
          }
        />
        <CardBody className="p-0">
          {plano.itens.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-fg-3">
              Nenhum item no plano. Marque procedimentos no odontograma.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2 font-semibold">Procedimento</th>
                    <th className="px-3 py-2 font-semibold">Dente e faces</th>
                    <th className="px-3 py-2 font-semibold">Cobertura</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 text-right font-semibold">Paciente paga</th>
                  </tr>
                </thead>
                <tbody>
                  {plano.itens.map((i) => (
                    <LinhaItem
                      key={i.id}
                      item={i}
                      marcado={selecionados.has(i.id)}
                      onAlternar={() => alternar(i.id)}
                      podeOrcar={podeOrcar}
                      podeEditar={podeEditar}
                      onSalvo={() => router.refresh()}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {podeOrcar && plano.itens.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Gerar orçamento"
            descricao="O documento é congelado na emissão: se o plano mudar depois, ele não muda."
          />
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <label htmlFor="tipoDesc" className="mb-1 block text-sm font-medium text-fg-2">
                  Desconto
                </label>
                <select
                  id="tipoDesc"
                  value={tipoDesconto}
                  onChange={(e) => setTipoDesconto(e.currentTarget.value as 'valor' | 'percentual')}
                  className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-fg"
                >
                  <option value="valor">Em reais</option>
                  <option value="percentual">Em percentual</option>
                </select>
              </div>
              <div>
                <label htmlFor="desc" className="mb-1 block text-sm font-medium text-fg-2">
                  {tipoDesconto === 'valor' ? 'Valor (R$)' : 'Percentual (%)'}
                </label>
                <input
                  id="desc"
                  value={desconto}
                  onChange={(e) => setDesconto(e.currentTarget.value)}
                  inputMode="decimal"
                  className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
                />
              </div>
              <div>
                <label htmlFor="dias" className="mb-1 block text-sm font-medium text-fg-2">
                  Validade (dias)
                </label>
                <input
                  id="dias"
                  type="number"
                  min={1}
                  max={365}
                  value={dias}
                  onChange={(e) => setDias(Number(e.currentTarget.value) || 30)}
                  className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
                />
              </div>
              <div>
                <label htmlFor="obs" className="mb-1 block text-sm font-medium text-fg-2">
                  Observação
                </label>
                <input
                  id="obs"
                  value={observacao}
                  onChange={(e) => setObservacao(e.currentTarget.value)}
                  className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-4 rounded-(--radius-controle) bg-surface-2 px-4 py-3">
              <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-3">Itens selecionados</dt>
                <dd className="text-right font-medium text-fg">{itensSelecionados.length}</dd>
                <dt className="text-fg-3">Subtotal</dt>
                <dd className="text-right text-fg">{reais(totais.valorBruto)}</dd>
                <dt className="text-fg-3">Desconto</dt>
                <dd className="text-right text-fg">
                  {totais.desconto === '—' ? '—' : reais(totais.desconto)}
                </dd>
                <dt className="font-semibold text-fg">Total</dt>
                <dd className="text-right text-lg font-semibold text-primary">
                  {totais.valorTotal === '—' ? '—' : reais(totais.valorTotal)}
                </dd>
              </dl>

              <Button
                variante="primario"
                tamanho="lg"
                disabled={pendente || selecionados.size === 0 || totais.valorTotal === '—'}
                onClick={gerar}
              >
                {pendente ? 'Gerando…' : 'Gerar orçamento'}
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo="Orçamentos"
          descricao={`${orcamentos.length} documento(s) emitido(s)`}
        />
        <CardBody className="p-0">
          {orcamentos.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Nenhum orçamento emitido ainda.</p>
          ) : (
            <ul className="divide-y divide-border">
              {orcamentos.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <Link
                    href={`/orcamentos/${o.id}`}
                    className="font-mono font-semibold text-fg hover:text-primary hover:underline"
                  >
                    #{o.numero}
                  </Link>
                  <EtiquetaStatus status={o.statusVisivel} />
                  <span className="text-fg-3">
                    {o.linhas} item(ns) · válido até {dataBr(o.validadeAte)}
                  </span>
                  <span className="ml-auto font-semibold text-fg">{reais(o.valorTotal)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function LinhaItem({
  item,
  marcado,
  onAlternar,
  podeOrcar,
  podeEditar,
  onSalvo,
}: {
  item: ItemDoPlano
  marcado: boolean
  onAlternar: () => void
  podeOrcar: boolean
  podeEditar: boolean
  onSalvo: () => void
}) {
  const [editando, setEditando] = useState(false)
  const [valor, setValor] = useState(item.valor)
  const [pendente, iniciar] = useTransition()
  const [erro, setErro] = useState<string | null>(null)

  // Item já no financeiro não tem valor editável: mexer descasaria o caixa.
  const travado = ['faturado', 'recebido', 'glosado'].includes(item.status)

  function salvar(): void {
    setErro(null)
    iniciar(async () => {
      const r = await ajustarValorItem(item.id, valor)
      if (!r.ok) {
        setErro(r.mensagem ?? 'Não foi possível ajustar.')
        return
      }
      setEditando(false)
      onSalvo()
    })
  }

  return (
    <tr className={cn('border-b border-border last:border-0', marcado && 'bg-primary/5')}>
      <td className="px-3 py-2">
        {podeOrcar ? (
          <input
            type="checkbox"
            checked={marcado}
            onChange={onAlternar}
            aria-label={`Incluir ${item.procedimentoNome} no orçamento`}
            className="size-4"
          />
        ) : null}
      </td>
      <td className="px-3 py-2">
        <span className="font-medium text-fg">{item.procedimentoNome}</span>
        {item.observacao ? (
          <span className="block text-xs text-fg-3">{item.observacao}</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-fg-2">{item.detalhe ?? '—'}</td>
      <td className="px-3 py-2 text-fg-2">
        {item.cobertura === 'convenio' ? (
          <span>
            {item.convenioNome ?? 'Convênio'}
            <span className="block text-xs text-fg-3">valor cheio {reais(item.valor)}</span>
          </span>
        ) : (
          'Particular'
        )}
      </td>
      <td className="px-3 py-2">
        <span
          className={cn(
            'text-xs font-medium',
            item.executado ? 'text-executado' : 'text-fg-2',
          )}
        >
          {item.executado ? 'executado' : item.status}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        {editando ? (
          <span className="flex items-center justify-end gap-1">
            <input
              value={valor}
              onChange={(e) => setValor(e.currentTarget.value)}
              inputMode="decimal"
              aria-label="Novo valor"
              className="h-8 w-24 rounded border border-border bg-surface px-2 text-right text-sm text-fg"
            />
            <Button tamanho="sm" disabled={pendente} onClick={salvar}>
              OK
            </Button>
            <Button tamanho="sm" variante="fantasma" onClick={() => setEditando(false)}>
              ✕
            </Button>
          </span>
        ) : (
          <span className="flex items-center justify-end gap-2">
            <span className="font-semibold text-fg">{reais(item.valorPaciente)}</span>
            {podeEditar && !travado ? (
              <button
                type="button"
                onClick={() => setEditando(true)}
                aria-label={`Ajustar valor de ${item.procedimentoNome}`}
                className="text-fg-3 hover:text-primary"
              >
                <Icone nome="editar" tamanho={13} />
              </button>
            ) : null}
          </span>
        )}
        {erro ? <span className="block text-xs text-critico">{erro}</span> : null}
      </td>
    </tr>
  )
}

export function EtiquetaStatus({
  status,
}: {
  status: 'rascunho' | 'enviado' | 'aprovado' | 'recusado' | 'expirado'
}) {
  const estilo = {
    rascunho: 'border-border bg-surface-3 text-fg-3',
    enviado: 'border-primary/40 bg-primary/10 text-primary',
    aprovado: 'border-sucesso/40 bg-sucesso/12 text-sucesso',
    recusado: 'border-critico/40 bg-critico/12 text-critico',
    expirado: 'border-atencao/40 bg-atencao/12 text-atencao',
  }[status]

  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', estilo)}>
      {ROTULO_STATUS_ORCAMENTO[status]}
    </span>
  )
}
