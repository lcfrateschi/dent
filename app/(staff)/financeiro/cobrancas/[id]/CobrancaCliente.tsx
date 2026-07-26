'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import { ROTULO_SITUACAO, type SituacaoParcela } from '@/lib/domain/cobranca'
import {
  cancelarCobranca,
  conciliarPagamento,
  estornarPagamento,
  registrarPagamento,
} from '@/lib/financeiro/acoes'
import type { CobrancaCompleta, ParcelaNaTela } from '@/lib/financeiro/consultas'
import { cn } from '@/lib/ui/cn'
import { dataBr, reais } from '@/lib/ui/moeda'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const MEIOS = [
  { valor: 'pix', rotulo: 'PIX', conciliaNaHora: true },
  { valor: 'dinheiro', rotulo: 'Dinheiro', conciliaNaHora: true },
  { valor: 'debito', rotulo: 'Débito', conciliaNaHora: true },
  { valor: 'credito', rotulo: 'Crédito', conciliaNaHora: false },
  { valor: 'boleto', rotulo: 'Boleto', conciliaNaHora: false },
  { valor: 'transferencia', rotulo: 'Transferência', conciliaNaHora: false },
] as const

/**
 * Cobrança com baixa de pagamento.
 *
 * O campo "conciliado" vem pré-marcado conforme o meio: dinheiro, PIX e débito
 * são dinheiro na hora; crédito, boleto e transferência esperam o extrato. Isso
 * não é conveniência — é o que separa recebido de conciliado, e conciliado é o
 * que libera comissão.
 */
export function CobrancaCliente({
  cobranca,
  podeReceber,
  podeCancelar,
  hojeIso,
}: {
  cobranca: CobrancaCompleta
  podeReceber: boolean
  podeCancelar: boolean
  hojeIso: string
}) {
  const router = useRouter()
  const [recebendo, setRecebendo] = useState<ParcelaNaTela | null>(null)
  const [msg, setMsg] = useState<{ tipo: 'erro' | 'ok'; texto: string } | null>(null)
  const [pendente, iniciar] = useTransition()

  function agir(acao: () => Promise<{ ok: boolean; mensagem?: string }>): void {
    setMsg(null)
    iniciar(async () => {
      const r = await acao()
      if (!r.ok) {
        setMsg({ tipo: 'erro', texto: r.mensagem ?? 'Não foi possível concluir.' })
        return
      }
      if (r.mensagem) setMsg({ tipo: 'ok', texto: r.mensagem })
      setRecebendo(null)
      router.refresh()
    })
  }

  const cancelada = cobranca.canceladoEm !== null

  return (
    <div className="space-y-4">
      {msg ? (
        <Alerta tipo={msg.tipo === 'erro' ? 'critico' : 'sucesso'}>{msg.texto}</Alerta>
      ) : null}

      {cancelada ? (
        <Alerta tipo="atencao">
          Esta cobrança foi cancelada em {cobranca.canceladoEm!.toLocaleDateString('pt-BR')}. Os
          pagamentos já registrados permanecem no histórico.
        </Alerta>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <Numero rotulo="Total" valor={reais(cobranca.resumo.total)} />
        <Numero rotulo="Recebido" valor={reais(cobranca.resumo.pago)} tom="sucesso" />
        <Numero
          rotulo="A receber"
          valor={reais(cobranca.resumo.aReceber)}
          apoio={
            Number(cobranca.resumo.emAtraso) > 0
              ? `${reais(cobranca.resumo.emAtraso)} em atraso`
              : undefined
          }
          tom={Number(cobranca.resumo.emAtraso) > 0 ? 'critico' : 'neutro'}
        />
        <Numero
          rotulo="Conciliado"
          valor={reais(cobranca.resumo.conciliado)}
          apoio="Base da comissão"
        />
      </div>

      <Card>
        <CardHeader
          titulo="Parcelas"
          descricao={`${cobranca.resumo.parcelasPagas} de ${cobranca.resumo.parcelas} paga(s)${cobranca.resumo.quitada ? ' — quitada' : ''}`}
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2">
                <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                  <th className="px-4 py-2 font-semibold">Nº</th>
                  <th className="px-4 py-2 font-semibold">Vencimento</th>
                  <th className="px-4 py-2 font-semibold">Situação</th>
                  <th className="px-4 py-2 text-right font-semibold">Valor</th>
                  <th className="px-4 py-2 text-right font-semibold">Recebido</th>
                  <th className="px-4 py-2 text-right font-semibold">Saldo</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {cobranca.parcelas.map((p) => (
                  <>
                    <tr key={p.id} className="border-b border-border">
                      <td className="px-4 py-2 text-fg-2">{p.numero}</td>
                      <td className="px-4 py-2 text-fg-2">
                        {dataBr(p.vencimento)}
                        {p.diasAtraso > 0 ? (
                          <span className="ml-1.5 text-xs text-critico">
                            +{p.diasAtraso}d
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        <PilulaSituacao situacao={p.situacao} />
                      </td>
                      <td className="px-4 py-2 text-right text-fg">{reais(p.valor)}</td>
                      <td className="px-4 py-2 text-right text-fg-2">{reais(p.pago)}</td>
                      <td className="px-4 py-2 text-right font-semibold text-fg">
                        {reais(p.saldo)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {podeReceber && !cancelada && Number(p.saldo) > 0 && p.situacao !== 'cancelada' ? (
                          <Button tamanho="sm" onClick={() => setRecebendo(p)}>
                            Receber
                          </Button>
                        ) : null}
                      </td>
                    </tr>

                    {p.pagamentos.map((pg) => (
                      <tr key={pg.id} className="border-b border-border bg-surface-2/50 text-xs">
                        <td className="px-4 py-1.5" />
                        <td colSpan={3} className="px-4 py-1.5 text-fg-2">
                          {dataBr(pg.pagoEm)} · {pg.meio}
                          {pg.estornadoEm ? (
                            <span className="ml-1.5 font-semibold text-critico">
                              ESTORNADO — {pg.motivoEstorno}
                            </span>
                          ) : pg.conciliado ? (
                            <span className="ml-1.5 text-sucesso">conciliado</span>
                          ) : (
                            <span className="ml-1.5 text-atencao">aguardando conciliação</span>
                          )}
                          {pg.registradoPorNome ? (
                            <span className="ml-1.5 text-fg-3">por {pg.registradoPorNome}</span>
                          ) : null}
                        </td>
                        <td
                          className={cn(
                            'px-4 py-1.5 text-right',
                            pg.estornadoEm ? 'text-fg-3 line-through' : 'text-fg-2',
                          )}
                        >
                          {reais(pg.valor)}
                        </td>
                        <td className="px-4 py-1.5" />
                        <td className="px-4 py-1.5 text-right">
                          {podeReceber && !pg.estornadoEm ? (
                            <span className="flex justify-end gap-1">
                              <Button
                                tamanho="sm"
                                variante="fantasma"
                                disabled={pendente}
                                onClick={() => agir(() => conciliarPagamento(pg.id, !pg.conciliado))}
                              >
                                {pg.conciliado ? 'Desconciliar' : 'Conciliar'}
                              </Button>
                              <Button
                                tamanho="sm"
                                variante="fantasma"
                                disabled={pendente}
                                onClick={() => {
                                  const motivo = window.prompt('Motivo do estorno:')
                                  if (motivo === null) return
                                  agir(() => estornarPagamento(pg.id, motivo))
                                }}
                              >
                                Estornar
                              </Button>
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {recebendo ? (
        <FormularioRecebimento
          parcela={recebendo}
          hojeIso={hojeIso}
          pendente={pendente}
          onCancelar={() => setRecebendo(null)}
          onConfirmar={(dados) => agir(() => registrarPagamento({ parcelaId: recebendo.id, ...dados }))}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Link href={`/pacientes/${cobranca.pacienteId}/plano`}>
          <Button variante="fantasma">
            <Icone nome="cobranca" tamanho={14} />
            Plano e orçamentos
          </Button>
        </Link>
        {podeCancelar && !cancelada ? (
          <Button
            variante="fantasma"
            disabled={pendente}
            onClick={() => {
              const motivo = window.prompt(
                'Motivo do cancelamento da cobrança?\n\nOs pagamentos já registrados permanecem no histórico.',
              )
              if (motivo === null) return
              agir(() => cancelarCobranca(cobranca.id, motivo))
            }}
          >
            Cancelar cobrança
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function FormularioRecebimento({
  parcela,
  hojeIso,
  pendente,
  onCancelar,
  onConfirmar,
}: {
  parcela: ParcelaNaTela
  hojeIso: string
  pendente: boolean
  onCancelar: () => void
  onConfirmar: (dados: {
    valor: string
    pagoEm: string
    meio: (typeof MEIOS)[number]['valor']
    conciliado: boolean
    observacao?: string
  }) => void
}) {
  const [valor, setValor] = useState(parcela.saldo)
  const [pagoEm, setPagoEm] = useState(hojeIso)
  const [meio, setMeio] = useState<(typeof MEIOS)[number]['valor']>('pix')
  const [conciliado, setConciliado] = useState(true)
  const [observacao, setObservacao] = useState('')

  function trocarMeio(novo: (typeof MEIOS)[number]['valor']): void {
    setMeio(novo)
    // Dinheiro, PIX e débito já são dinheiro; o resto espera o extrato.
    setConciliado(MEIOS.find((m) => m.valor === novo)?.conciliaNaHora ?? false)
  }

  return (
    <Card>
      <CardHeader
        titulo={`Receber parcela ${parcela.numero}`}
        descricao={`Saldo de ${reais(parcela.saldo)} · vencimento ${dataBr(parcela.vencimento)}`}
        acoes={
          <Button tamanho="sm" variante="fantasma" onClick={onCancelar}>
            <Icone nome="fechar" tamanho={14} />
            Fechar
          </Button>
        }
      />
      <CardBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="valor" className="mb-1 block text-sm font-medium text-fg-2">
              Valor
            </label>
            <input
              id="valor"
              value={valor}
              onChange={(e) => setValor(e.currentTarget.value)}
              inputMode="decimal"
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
            />
          </div>
          <div>
            <label htmlFor="pagoEm" className="mb-1 block text-sm font-medium text-fg-2">
              Data
            </label>
            <input
              id="pagoEm"
              type="date"
              value={pagoEm}
              onChange={(e) => setPagoEm(e.currentTarget.value)}
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
            />
          </div>
          <div>
            <label htmlFor="meio" className="mb-1 block text-sm font-medium text-fg-2">
              Meio
            </label>
            <select
              id="meio"
              value={meio}
              onChange={(e) => trocarMeio(e.currentTarget.value as typeof meio)}
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-fg"
            >
              {MEIOS.map((m) => (
                <option key={m.valor} value={m.valor}>
                  {m.rotulo}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium text-fg-2">Conciliação</span>
            <label className="flex h-10 items-center gap-2 text-sm text-fg-2">
              <input
                type="checkbox"
                checked={conciliado}
                onChange={(e) => setConciliado(e.currentTarget.checked)}
                className="size-4"
              />
              Já confirmado
            </label>
          </div>
        </div>

        <div>
          <label htmlFor="obsPag" className="mb-1 block text-sm font-medium text-fg-2">
            Observação
          </label>
          <input
            id="obsPag"
            value={observacao}
            onChange={(e) => setObservacao(e.currentTarget.value)}
            className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
          />
        </div>

        {!conciliado ? (
          <p className="text-xs text-atencao">
            Sem conciliação, o valor entra como recebido mas <strong>não</strong> conta para
            comissão até ser confirmado no extrato.
          </p>
        ) : null}

        <Button
          variante="primario"
          disabled={pendente || Number(valor) <= 0}
          onClick={() =>
            onConfirmar({
              valor,
              pagoEm,
              meio,
              conciliado,
              ...(observacao.trim() ? { observacao: observacao.trim() } : {}),
            })
          }
        >
          {pendente ? 'Registrando…' : 'Registrar pagamento'}
        </Button>
      </CardBody>
    </Card>
  )
}

function PilulaSituacao({ situacao }: { situacao: SituacaoParcela }) {
  const estilo = {
    aberta: 'border-border bg-surface-3 text-fg-3',
    parcial: 'border-primary/40 bg-primary/10 text-primary',
    paga: 'border-sucesso/40 bg-sucesso/12 text-sucesso',
    vencida: 'border-critico/40 bg-critico/12 text-critico',
    cancelada: 'border-border bg-surface-3 text-fg-3 line-through',
  }[situacao]

  return (
    <span className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', estilo)}>
      {ROTULO_SITUACAO[situacao]}
    </span>
  )
}

function Numero({
  rotulo,
  valor,
  apoio,
  tom = 'neutro',
}: {
  rotulo: string
  valor: string
  apoio?: string | undefined
  tom?: 'neutro' | 'sucesso' | 'critico'
}) {
  const cor = { neutro: 'text-fg', sucesso: 'text-sucesso', critico: 'text-critico' }[tom]
  return (
    <div className="rounded-(--radius-cartao) border border-border bg-surface px-4 py-3">
      <span className="block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
        {rotulo}
      </span>
      <span className={cn('mt-0.5 block text-lg font-semibold', cor)}>{valor}</span>
      {apoio ? <span className="mt-0.5 block text-xs text-fg-3">{apoio}</span> : null}
    </div>
  )
}
