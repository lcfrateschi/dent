'use client'

import { Legenda } from '@/components/odontograma/Legenda'
import { Odontograma } from '@/components/odontograma/Odontograma'
import type { MarcacoesDente, MarcacoesFace, SelecaoFaces } from '@/components/odontograma/tipos'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import {
  cancelarItem,
  definirEstadoDente,
  planejarProcedimento,
  registrarExecucao,
} from '@/lib/odontograma/acoes'
import type { EstadoDenteRegistrado, ItemDoOdontograma } from '@/lib/odontograma/consultas'
import { type Denticao, type Face, exigirDente } from '@/lib/domain/dentes'
import { descreverFaces } from '@/lib/domain/faces'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'

export interface ProcedimentoOpcao {
  readonly id: string
  readonly nome: string
  readonly valorParticular: string
  readonly requerFace: boolean
  readonly especialidade: string | null
}

const ESTADOS_DENTE: readonly { valor: EstadoDenteRegistrado | null; rotulo: string }[] = [
  { valor: null, rotulo: 'Presente' },
  { valor: 'ausente', rotulo: 'Ausente' },
  { valor: 'coroa', rotulo: 'Coroa' },
  { valor: 'implante', rotulo: 'Implante' },
  { valor: 'raiz_residual', rotulo: 'Raiz residual' },
]

/**
 * Odontograma clínico, ligado ao banco.
 *
 * Diferença central em relação ao protótipo da Fase 2: **cada marca tem
 * consequência**. Selecionar faces e escolher um procedimento cria um
 * `item_plano`, que vira orçamento na Fase 6 e cobrança na Fase 8. Por isso o
 * fluxo é de duas etapas — selecionar, depois confirmar — e não um clique que
 * grava direto: o dentista precisa ver o que vai ser lançado antes de lançar.
 */
export function OdontogramaClinico({
  pacienteId,
  pacienteNome,
  marcacoesFace,
  marcacoesDente,
  itens,
  procedimentos,
  podePlanejar,
  podeExecutar,
}: {
  pacienteId: string
  pacienteNome: string
  marcacoesFace: MarcacoesFace
  marcacoesDente: MarcacoesDente
  itens: readonly ItemDoOdontograma[]
  procedimentos: readonly ProcedimentoOpcao[]
  podePlanejar: boolean
  podeExecutar: boolean
}) {
  const router = useRouter()
  const [denticao, setDenticao] = useState<Denticao | 'mista'>('permanente')
  const [tamanho, setTamanho] = useState<'compacto' | 'confortavel'>('compacto')
  const [modo, setModo] = useState<'planejar' | 'estado'>('planejar')
  const [selecao, setSelecao] = useState<SelecaoFaces>({})
  const [procedimentoId, setProcedimentoId] = useState('')
  const [observacao, setObservacao] = useState('')
  const [mensagem, setMensagem] = useState<{ tipo: 'erro' | 'ok'; texto: string } | null>(null)
  const [pendente, iniciar] = useTransition()

  const procedimento = procedimentos.find((p) => p.id === procedimentoId)

  const denteSelecionado = useMemo(() => {
    const chaves = Object.keys(selecao)
    return chaves.length === 1 ? Number(chaves[0]) : null
  }, [selecao])

  const facesSelecionadas = denteSelecionado ? (selecao[denteSelecionado] ?? []) : []

  function alternarFace(fdi: number, face: Face): void {
    if (modo === 'estado') return
    setMensagem(null)
    setSelecao((s) => {
      // Um dente por vez: um item de plano é sempre de um dente só, e seleção
      // multi-dente daria a impressão de que um clique cria vários itens.
      const atuais = fdi in s ? (s[fdi] ?? []) : []
      const proximas = atuais.includes(face) ? atuais.filter((f) => f !== face) : [...atuais, face]
      return proximas.length > 0 ? { [fdi]: proximas } : {}
    })
  }

  function clicarDente(fdi: number): void {
    setMensagem(null)
    if (modo === 'planejar') {
      // Enter no dente seleciona todas as faces válidas.
      const faces = exigirDente(fdi).facesValidas
      setSelecao((s) => ((s[fdi]?.length ?? 0) === faces.length ? {} : { [fdi]: [...faces] }))
      return
    }
    setSelecao({ [fdi]: [] })
  }

  function confirmarPlanejamento(): void {
    if (!denteSelecionado || !procedimento) return
    setMensagem(null)
    iniciar(async () => {
      const r = await planejarProcedimento({
        pacienteId,
        procedimentoId: procedimento.id,
        denteFdi: denteSelecionado,
        faces: procedimento.requerFace ? facesSelecionadas : [],
        observacao: observacao.trim() || undefined,
      })
      if (!r.ok) {
        setMensagem({ tipo: 'erro', texto: r.mensagem })
        return
      }
      setMensagem({ tipo: 'ok', texto: `Planejado: ${r.mensagem ?? ''}` })
      setSelecao({})
      setObservacao('')
      router.refresh()
    })
  }

  function aplicarEstado(estado: EstadoDenteRegistrado | null): void {
    if (!denteSelecionado) return
    setMensagem(null)
    iniciar(async () => {
      const r = await definirEstadoDente({ pacienteId, denteFdi: denteSelecionado, estado })
      if (!r.ok) {
        setMensagem({ tipo: 'erro', texto: r.mensagem })
        return
      }
      setSelecao({})
      router.refresh()
    })
  }

  function executar(itemId: string): void {
    setMensagem(null)
    iniciar(async () => {
      const r = await registrarExecucao(itemId, pacienteId)
      if (!r.ok) setMensagem({ tipo: 'erro', texto: r.mensagem })
      else router.refresh()
    })
  }

  function cancelar(itemId: string): void {
    setMensagem(null)
    iniciar(async () => {
      const r = await cancelarItem(itemId, pacienteId)
      if (!r.ok) setMensagem({ tipo: 'erro', texto: r.mensagem })
      else router.refresh()
    })
  }

  const planejados = itens.filter((i) => !i.executado && i.status !== 'cancelado')
  const executados = itens.filter((i) => i.executado)

  return (
    <div className="space-y-4">
      {mensagem ? (
        <Alerta tipo={mensagem.tipo === 'erro' ? 'critico' : 'sucesso'}>{mensagem.texto}</Alerta>
      ) : null}

      <Card>
        <CardHeader
          titulo="Odontograma"
          descricao={pacienteNome}
          acoes={
            <>
              <div className="flex gap-1">
                {(['permanente', 'deciduo', 'mista'] as const).map((d) => (
                  <Button key={d} tamanho="sm" ativo={denticao === d} onClick={() => setDenticao(d)}>
                    {d === 'permanente' ? 'Permanente' : d === 'deciduo' ? 'Decídua' : 'Mista'}
                  </Button>
                ))}
              </div>
              <div className="flex gap-1">
                {(['compacto', 'confortavel'] as const).map((t) => (
                  <Button key={t} tamanho="sm" ativo={tamanho === t} onClick={() => setTamanho(t)}>
                    {t === 'compacto' ? 'Compacto' : 'Confortável'}
                  </Button>
                ))}
              </div>
            </>
          }
        />

        {podePlanejar ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-4 py-2.5">
            <span className="text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
              Modo
            </span>
            <Button
              tamanho="sm"
              ativo={modo === 'planejar'}
              onClick={() => {
                setModo('planejar')
                setSelecao({})
              }}
            >
              Planejar procedimento
            </Button>
            <Button
              tamanho="sm"
              ativo={modo === 'estado'}
              onClick={() => {
                setModo('estado')
                setSelecao({})
              }}
            >
              Constatar estado do dente
            </Button>
            <span className="ml-auto text-xs text-fg-3">
              {modo === 'planejar'
                ? 'Clique nas faces; Enter no dente seleciona todas.'
                : 'Clique no dente e escolha o estado.'}
            </span>
          </div>
        ) : null}

        <CardBody>
          <Odontograma
            denticao={denticao}
            tamanho={tamanho}
            marcacoesFace={marcacoesFace}
            marcacoesDente={marcacoesDente}
            selecao={selecao}
            onFaceClick={alternarFace}
            onDenteClick={clicarDente}
            somenteLeitura={!podePlanejar}
          />
        </CardBody>
      </Card>

      {podePlanejar && denteSelecionado ? (
        <Card>
          <CardHeader
            titulo={
              modo === 'planejar'
                ? `Planejar — ${descreverFaces(denteSelecionado, facesSelecionadas)}`
                : `Dente ${denteSelecionado} — estado`
            }
            descricao={exigirDente(denteSelecionado).nome}
            acoes={
              <Button tamanho="sm" variante="fantasma" onClick={() => setSelecao({})}>
                <Icone nome="fechar" tamanho={14} />
                Limpar
              </Button>
            }
          />
          <CardBody className="space-y-3">
            {modo === 'estado' ? (
              <div className="flex flex-wrap gap-2">
                {ESTADOS_DENTE.map((e) => (
                  <Button
                    key={e.rotulo}
                    tamanho="sm"
                    disabled={pendente}
                    ativo={(marcacoesDente[denteSelecionado] ?? 'presente') === (e.valor ?? 'presente')}
                    onClick={() => aplicarEstado(e.valor)}
                  >
                    {e.rotulo}
                  </Button>
                ))}
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="procedimento"
                      className="mb-1 block text-sm font-medium text-fg-2"
                    >
                      Procedimento <span className="text-critico">*</span>
                    </label>
                    <select
                      id="procedimento"
                      value={procedimentoId}
                      onChange={(e) => setProcedimentoId(e.currentTarget.value)}
                      className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
                    >
                      <option value="">— selecione —</option>
                      {procedimentos.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.nome} — R$ {p.valorParticular}
                        </option>
                      ))}
                    </select>
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

                {procedimento?.requerFace && facesSelecionadas.length === 0 ? (
                  <Alerta tipo="atencao">
                    {procedimento.nome} exige indicar as faces. Clique nas faces do dente.
                  </Alerta>
                ) : null}

                <div className="flex items-center gap-2">
                  <Button
                    variante="primario"
                    disabled={
                      pendente ||
                      !procedimento ||
                      (procedimento.requerFace && facesSelecionadas.length === 0)
                    }
                    onClick={confirmarPlanejamento}
                  >
                    {pendente ? 'Salvando…' : 'Adicionar ao plano'}
                  </Button>
                  {procedimento ? (
                    <span className="text-sm text-fg-3">
                      Será lançado como <strong className="text-planejado">planejado</strong>, valor
                      R$ {procedimento.valorParticular}
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </CardBody>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            titulo="Planejado"
            descricao={`${planejados.length} ${planejados.length === 1 ? 'item' : 'itens'} — vira orçamento na Fase 6`}
          />
          <CardBody>
            {planejados.length === 0 ? (
              <p className="text-sm text-fg-3">Nenhum procedimento planejado.</p>
            ) : (
              <ul className="divide-y divide-border">
                {planejados.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-fg">{i.procedimentoNome}</span>
                      <span className="block text-xs text-fg-3">
                        {i.denteFdi ? descreverFaces(i.denteFdi, i.faces) : 'Geral'} · R$ {i.valor} ·{' '}
                        {i.status}
                      </span>
                    </span>
                    {podeExecutar ? (
                      <Button tamanho="sm" disabled={pendente} onClick={() => executar(i.id)}>
                        Executar
                      </Button>
                    ) : null}
                    {podePlanejar ? (
                      <Button
                        tamanho="sm"
                        variante="fantasma"
                        disabled={pendente}
                        onClick={() => cancelar(i.id)}
                      >
                        Cancelar
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader titulo="Executado" descricao={`${executados.length} registrado(s)`} />
          <CardBody>
            {executados.length === 0 ? (
              <p className="text-sm text-fg-3">Nenhum procedimento executado ainda.</p>
            ) : (
              <ul className="divide-y divide-border">
                {executados.map((i) => (
                  <li key={i.id} className="py-2 text-sm">
                    <span className="block font-medium text-fg">{i.procedimentoNome}</span>
                    <span className="block text-xs text-fg-3">
                      {i.denteFdi ? descreverFaces(i.denteFdi, i.faces) : 'Geral'} · R$ {i.valor}
                      {i.executadoEm
                        ? ` · ${i.executadoEm.toLocaleDateString('pt-BR')}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader titulo="Legenda e convenções" />
        <CardBody>
          <Legenda />
        </CardBody>
      </Card>
    </div>
  )
}
