'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { gerarParcelas } from '@/lib/domain/parcelamento'
import { faturarOrcamento } from '@/lib/financeiro/acoes'
import { dataBr, reais } from '@/lib/ui/moeda'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'

const FORMAS = [
  { valor: 'pix', rotulo: 'PIX' },
  { valor: 'dinheiro', rotulo: 'Dinheiro' },
  { valor: 'debito', rotulo: 'Cartão de débito' },
  { valor: 'credito', rotulo: 'Cartão de crédito' },
  { valor: 'boleto', rotulo: 'Boleto' },
  { valor: 'transferencia', rotulo: 'Transferência' },
] as const

/**
 * Fatura um orçamento aprovado.
 *
 * As parcelas são calculadas **na tela** pela mesma função pura que o servidor
 * usa (`gerarParcelas`), então a recepção vê os valores e as datas exatas antes
 * de confirmar. Dizer "3× de 33,34, 33,33 e 33,33" ao paciente é diferente de
 * dizer "dividido em 3".
 */
export function FormularioFaturar({
  orcamentoId,
  orcamentoNumero,
  pacienteNome,
  valorTotal,
  hojeIso,
}: {
  orcamentoId: string
  orcamentoNumero: number
  pacienteNome: string
  valorTotal: string
  hojeIso: string
}) {
  const router = useRouter()
  const [forma, setForma] = useState<(typeof FORMAS)[number]['valor']>('pix')
  const [quantidade, setQuantidade] = useState(1)
  const [primeiroVencimento, setPrimeiroVencimento] = useState(hojeIso)
  const [intervalo, setIntervalo] = useState(1)
  const [observacao, setObservacao] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  const previa = useMemo(() => {
    try {
      return {
        parcelas: gerarParcelas({
          total: valorTotal,
          quantidade,
          primeiroVencimento,
          intervaloMeses: intervalo,
        }),
        erro: null as string | null,
      }
    } catch (e) {
      return { parcelas: [], erro: e instanceof Error ? e.message : 'Parcelamento inválido.' }
    }
  }, [valorTotal, quantidade, primeiroVencimento, intervalo])

  function confirmar(): void {
    setErro(null)
    iniciar(async () => {
      const r = await faturarOrcamento({
        orcamentoId,
        forma,
        quantidade,
        primeiroVencimento,
        intervaloMeses: intervalo,
        observacao: observacao.trim() || undefined,
      })
      if (!r.ok) {
        setErro(r.mensagem)
        return
      }
      router.push(`/financeiro/cobrancas/${r.id}`)
    })
  }

  return (
    <div className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <Card>
        <CardHeader
          titulo={`Faturar orçamento #${orcamentoNumero}`}
          descricao={`${pacienteNome} · ${reais(valorTotal)}`}
        />
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="forma" className="mb-1 block text-sm font-medium text-fg-2">
                Forma de pagamento
              </label>
              <select
                id="forma"
                value={forma}
                onChange={(e) => setForma(e.currentTarget.value as typeof forma)}
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-fg"
              >
                {FORMAS.map((f) => (
                  <option key={f.valor} value={f.valor}>
                    {f.rotulo}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="qtd" className="mb-1 block text-sm font-medium text-fg-2">
                Parcelas
              </label>
              <input
                id="qtd"
                type="number"
                min={1}
                max={60}
                value={quantidade}
                onChange={(e) => setQuantidade(Number(e.currentTarget.value) || 1)}
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
              />
            </div>
            <div>
              <label htmlFor="venc" className="mb-1 block text-sm font-medium text-fg-2">
                1º vencimento
              </label>
              <input
                id="venc"
                type="date"
                value={primeiroVencimento}
                onChange={(e) => setPrimeiroVencimento(e.currentTarget.value)}
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
              />
            </div>
            <div>
              <label htmlFor="int" className="mb-1 block text-sm font-medium text-fg-2">
                Intervalo (meses)
              </label>
              <select
                id="int"
                value={intervalo}
                onChange={(e) => setIntervalo(Number(e.currentTarget.value))}
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-fg"
              >
                <option value={1}>Mensal</option>
                <option value={2}>Bimestral</option>
                <option value={3}>Trimestral</option>
              </select>
            </div>
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
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Prévia das parcelas"
          descricao="A soma é exatamente o total; a sobra do arredondamento vai na primeira."
        />
        <CardBody className="p-0">
          {previa.erro ? (
            <div className="px-4 py-4">
              <Alerta tipo="atencao">{previa.erro}</Alerta>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Nº</th>
                    <th className="px-4 py-2 font-semibold">Vencimento</th>
                    <th className="px-4 py-2 text-right font-semibold">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {previa.parcelas.map((p) => (
                    <tr key={p.numero} className="border-b border-border last:border-0">
                      <td className="px-4 py-1.5 text-fg-2">{p.numero}</td>
                      <td className="px-4 py-1.5 text-fg-2">{dataBr(p.vencimento)}</td>
                      <td className="px-4 py-1.5 text-right font-medium text-fg">
                        {reais(p.valor)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border-forte">
                    <td colSpan={2} className="px-4 py-2 text-right font-semibold text-fg">
                      Total
                    </td>
                    <td className="px-4 py-2 text-right font-semibold text-primary">
                      {reais(valorTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <Button
          variante="primario"
          tamanho="lg"
          disabled={pendente || previa.erro !== null}
          onClick={confirmar}
        >
          {pendente ? 'Faturando…' : 'Gerar cobrança'}
        </Button>
        <Button tamanho="lg" variante="fantasma" onClick={() => router.push('/financeiro')}>
          Cancelar
        </Button>
      </div>

      <p className="text-xs text-fg-3">
        O valor vem do orçamento aprovado e não é recalculado — é o que o paciente aceitou.
      </p>
    </div>
  )
}
