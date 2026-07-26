'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { confirmarBaixaDaExecucao, proporBaixaDaExecucao } from '@/lib/estoque/acoes'
import type { PropostaDeBaixa } from '@/lib/estoque/acoes'
import { formatarQuantidade } from '@/lib/domain/quantidade'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

/**
 * Confirmação do consumo de uma execução.
 *
 * ── Por que confirmar, e não baixar sozinho ─────────────────────────────────
 * A ficha técnica é uma média: a mesma restauração usa mais gaze em dente
 * posterior que em anterior, e às vezes o dentista abriu dois anestésicos. Se o
 * sistema gravasse a média como fato, o estoque ficaria "controlado" e errado — e
 * a rastreabilidade afirmaria um lote que talvez não tenha sido o usado. Um clique
 * confirma; ajustar quantidade ou remover item é digitar em cima.
 *
 * ── O que a tela mostra que a proposta não tem ──────────────────────────────
 * De qual **lote** cada item vai sair, com validade. É o que permite a pessoa
 * discordar: se ela pegou outra caixa, o lote na tela está errado, e é aí que a
 * rastreabilidade se salva.
 */
export function PainelDeBaixa({
  execucaoId,
  aoConcluir,
  compacto = false,
}: {
  execucaoId: string
  aoConcluir?: () => void
  compacto?: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [proposta, setProposta] = useState<PropostaDeBaixa | null | 'carregando'>('carregando')
  const [quantidades, setQuantidades] = useState<Record<string, string>>({})
  const [removidos, setRemovidos] = useState<Set<string>>(new Set())
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)
  const [feito, setFeito] = useState(false)

  useEffect(() => {
    let vivo = true
    void proporBaixaDaExecucao(execucaoId).then((p) => {
      if (!vivo) return
      setProposta(p)
      if (p) {
        setQuantidades(Object.fromEntries(p.itens.map((i) => [i.materialId, i.quantidade])))
      }
    })
    return () => {
      vivo = false
    }
  }, [execucaoId])

  if (proposta === 'carregando') {
    return <p className="text-xs text-fg-3">Verificando o consumo deste procedimento…</p>
  }

  // Procedimento sem ficha técnica: não há o que propor, e um painel vazio só
  // treinaria a pessoa a ignorar o painel.
  if (proposta === null) return null

  if (feito) {
    return (
      <Alerta tipo="sucesso">
        {aviso?.mensagem ?? 'Consumo lançado.'}{' '}
        <span className="text-fg-2">O material saiu do lote que vence primeiro.</span>
      </Alerta>
    )
  }

  if (proposta.jaLancada) {
    return (
      <p className="text-xs text-fg-3">
        O consumo desta execução já foi lançado.
      </p>
    )
  }

  const selecionados = proposta.itens.filter((i) => !removidos.has(i.materialId))

  return (
    <div className="space-y-3 rounded-(--radius-controle) border border-border bg-surface-2 p-3">
      <div>
        <p className="text-sm font-medium text-fg">Lançar o material usado</p>
        <p className="text-xs text-fg-3">
          {proposta.procedimentoNome}
          {proposta.denteFdi ? ` · dente ${proposta.denteFdi}` : null} · {proposta.pacienteNome}
        </p>
      </div>

      {aviso && !aviso.ok ? <Alerta tipo="critico">{aviso.mensagem}</Alerta> : null}

      {proposta.temFalta ? (
        <Alerta tipo="atencao">
          Falta saldo de algum insumo. Pode lançar assim mesmo — o que houver é baixado e o resto
          fica registrado na mensagem. Estoque incompleto é comum; desistir de lançar é o que
          arruína a contagem.
        </Alerta>
      ) : null}

      <ul className="space-y-1">
        {proposta.itens.map((i) => {
          const fora = removidos.has(i.materialId)
          return (
            <li
              key={i.materialId}
              className={`flex flex-wrap items-center gap-2 text-sm ${fora ? 'opacity-50' : ''}`}
            >
              <span className="min-w-48 flex-1">
                <span className={fora ? 'line-through' : ''}>{i.nome}</span>
                {i.controlado ? (
                  <span className="ml-2 rounded bg-atencao/15 px-1.5 py-0.5 text-[11px] text-atencao">
                    controlado
                  </span>
                ) : null}
                <span className="block text-xs text-fg-3">
                  {i.alocacoes.length === 0 ? (
                    <span className="text-critico">sem saldo</span>
                  ) : (
                    i.alocacoes
                      .map(
                        (a) =>
                          `lote ${a.codigoFabricante ?? a.loteId.slice(0, 8)}${
                            a.validade ? ` (vence ${a.validade})` : ''
                          }: ${formatarQuantidade(a.quantidade)}`,
                      )
                      .join(' + ')
                  )}
                  {i.vencidosIgnorados > 0
                    ? ` · ${i.vencidosIgnorados} lote(s) vencido(s) ignorado(s)`
                    : null}
                </span>
              </span>
              <input
                value={quantidades[i.materialId] ?? i.quantidade}
                aria-label={`Quantidade de ${i.nome}`}
                disabled={fora}
                onChange={(e) =>
                  setQuantidades({ ...quantidades, [i.materialId]: e.currentTarget.value })
                }
                className="h-8 w-20 rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg"
              />
              <span className="w-14 text-xs text-fg-3">{i.unidade}</span>
              <Button
                tamanho="sm"
                variante="fantasma"
                onClick={() => {
                  const novo = new Set(removidos)
                  if (fora) novo.delete(i.materialId)
                  else novo.add(i.materialId)
                  setRemovidos(novo)
                }}
              >
                {fora ? 'Incluir' : 'Não usei'}
              </Button>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button
          variante="primario"
          tamanho={compacto ? 'sm' : 'md'}
          disabled={pendente || selecionados.length === 0}
          onClick={() =>
            iniciar(async () => {
              const r = await confirmarBaixaDaExecucao(
                execucaoId,
                selecionados.map((i) => ({
                  materialId: i.materialId,
                  quantidade: quantidades[i.materialId] ?? i.quantidade,
                })),
              )
              setAviso(r)
              if (r.ok) {
                setFeito(true)
                router.refresh()
                aoConcluir?.()
              }
            })
          }
        >
          {pendente ? 'Lançando…' : `Lançar ${selecionados.length} item(ns)`}
        </Button>
        <Button
          variante="fantasma"
          tamanho={compacto ? 'sm' : 'md'}
          onClick={() => {
            setProposta(null)
            aoConcluir?.()
          }}
        >
          Depois
        </Button>
      </div>
      <p className="text-xs text-fg-3">
        Quem não lançar agora encontra este atendimento na fila de <strong>consumo a lançar</strong>,
        na tela de estoque — nada se perde por fechar a janela.
      </p>
    </div>
  )
}
