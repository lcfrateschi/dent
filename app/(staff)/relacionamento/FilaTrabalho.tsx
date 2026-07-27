'use client'

import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/ui/cn'
import { useState, useTransition } from 'react'
import { dispensarTarefa, registrarContato, resolverTarefa } from '@/lib/relacionamento/acoes'

export interface LinhaNaTela {
  id: string
  rotulo: string
  situacao: 'aberta' | 'em_andamento' | 'resolvida' | 'dispensada'
  urgencia: 'no_prazo' | 'vence_hoje' | 'atrasada'
  prazoBr: string
  pacienteId: string
  pacienteNome: string
  telefone: string | null
  detalhe: string
  tentativas: number
  ultimoContatoBr: string | null
  responsavelNome: string | null
  naoContatarAteBr: string | null
}

const CANAIS = [
  { valor: 'telefone', rotulo: 'Telefone' },
  { valor: 'whatsapp', rotulo: 'WhatsApp' },
  { valor: 'presencial', rotulo: 'Presencial' },
  { valor: 'email', rotulo: 'E-mail' },
] as const

/**
 * Os resultados, na ordem em que acontecem ao telefone.
 *
 * `nao_atendeu` primeiro porque é o mais frequente. E os dois que ENCERRAM a fila
 * vêm por último, separados, com o efeito escrito no rótulo: quem clica precisa
 * saber que "não quer" para de chamar o paciente — não é sinônimo de "não atendeu".
 */
const RESULTADOS = [
  { valor: 'nao_atendeu', rotulo: 'Não atendeu' },
  { valor: 'falou', rotulo: 'Falou, sem decidir' },
  { valor: 'remarcou', rotulo: 'Remarcou → resolve' },
  { valor: 'nao_quer', rotulo: 'Não quer → dispensa' },
  { valor: 'numero_errado', rotulo: 'Número errado → dispensa' },
] as const

const COR_URGENCIA: Record<LinhaNaTela['urgencia'], string> = {
  atrasada: 'bg-critico/10 text-critico',
  vence_hoje: 'bg-atencao/15 text-atencao',
  no_prazo: 'bg-surface-2 text-fg-2',
}

/**
 * A fila, trabalhável.
 *
 * ── O que faz dela uma fila e não um relatório ──────────────────────────────
 * Quatro coisas em cada linha, e nenhuma é opcional: **por que** ligar, **o
 * contexto** (para não abrir o cadastro em outra aba), **quantas vezes já se
 * tentou**, e **o que aconteceu na última**. Sem as duas últimas, duas pessoas
 * ligam para o mesmo paciente na mesma manhã.
 *
 * ── Registrar contato é um clique, não um formulário ───────────────────────
 * Canal + resultado, e o resultado já decide o destino da tarefa (o domínio sabe:
 * `remarcou` resolve, `nao_quer` dispensa). A alternativa — registrar e depois
 * clicar em "resolver" — perde o segundo clique, e a fila enche de tarefas em
 * andamento cujo último contato diz "paciente não quer".
 */
export function FilaTrabalho({
  linhas,
  podeTrabalhar,
}: {
  linhas: readonly LinhaNaTela[]
  podeTrabalhar: boolean
}) {
  const [aberta, setAberta] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  if (linhas.length === 0) {
    return (
      <p className="p-4 text-sm text-fg-2">
        Nenhuma tarefa aberta. As filas são geradas a cada passada do despachante — orçamento sem
        resposta, parcela vencida, aprovado e não executado, falta sem remarcar e retorno programado.
      </p>
    )
  }

  function executar(acao: () => Promise<{ ok: boolean; mensagem: string }>) {
    iniciar(async () => {
      const r = await acao()
      setAviso(r.mensagem)
      if (r.ok) setAberta(null)
    })
  }

  return (
    <div>
      {aviso !== null && (
        <p className="border-b border-border bg-surface-2 px-4 py-2 text-sm text-fg">{aviso}</p>
      )}
      <ul className="divide-y divide-border">
        {linhas.map((l) => (
          <li key={l.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-fg">{l.pacienteNome}</p>
                <p className="text-sm text-fg-2">
                  {l.rotulo} · {l.detalhe}
                </p>
                <p className="mt-1 text-xs text-fg-2">
                  {l.telefone ? l.telefone : 'sem telefone no cadastro'}
                  {' · '}
                  {l.tentativas === 0
                    ? 'nenhuma tentativa'
                    : `${l.tentativas} tentativa(s), última em ${l.ultimoContatoBr}`}
                  {l.responsavelNome ? ` · com ${l.responsavelNome}` : ''}
                </p>
                {/*
                  O opt-out aparece mesmo aqui: a tarefa foi criada antes do pedido, e
                  quem for ligar tem de ver o pedido ANTES de discar.
                */}
                {l.naoContatarAteBr !== null && (
                  <p className="mt-1 text-xs font-medium text-critico">
                    Não contatar até {l.naoContatarAteBr}
                  </p>
                )}
              </div>
              <span
                className={cn(
                  'shrink-0 rounded px-2 py-0.5 text-xs font-medium',
                  COR_URGENCIA[l.urgencia],
                )}
              >
                {l.urgencia === 'atrasada'
                  ? `atrasada · prazo ${l.prazoBr}`
                  : l.urgencia === 'vence_hoje'
                    ? 'vence hoje'
                    : `prazo ${l.prazoBr}`}
              </span>
            </div>

            {podeTrabalhar && (
              <div className="mt-2">
                {aberta === l.id ? (
                  <PainelDeContato
                    pendente={pendente}
                    onFechar={() => setAberta(null)}
                    onContato={(canal, resultado) =>
                      executar(() => registrarContato({ tarefaId: l.id, canal, resultado }))
                    }
                    onResolver={() => executar(() => resolverTarefa(l.id))}
                    onDispensar={(motivo, naoContatarAte) =>
                      executar(() =>
                        dispensarTarefa({ tarefaId: l.id, motivo, naoContatarAte }),
                      )
                    }
                  />
                ) : (
                  <Button variante="secundario" tamanho="sm" onClick={() => setAberta(l.id)}>
                    Registrar contato
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function PainelDeContato({
  pendente,
  onFechar,
  onContato,
  onResolver,
  onDispensar,
}: {
  pendente: boolean
  onFechar: () => void
  onContato: (
    canal: (typeof CANAIS)[number]['valor'],
    resultado: (typeof RESULTADOS)[number]['valor'],
  ) => void
  onResolver: () => void
  onDispensar: (motivo: string, naoContatarAte?: string) => void
}) {
  const [canal, setCanal] = useState<(typeof CANAIS)[number]['valor']>('telefone')
  const [dispensando, setDispensando] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [ate, setAte] = useState('')

  if (dispensando) {
    return (
      <div className="rounded border border-border bg-surface-2 p-3">
        {/*
          O motivo é OBRIGATÓRIO, e não por formalidade: "não insista" sem motivo é
          indistinguível de clique errado, e a diferença decide se a fila reabre no
          ano que vem. O domínio e o CHECK do banco cobram o mesmo.
        */}
        <label className="block text-sm font-medium text-fg" htmlFor="motivo">
          Por que dispensar? (obrigatório)
        </label>
        <input
          id="motivo"
          className="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Paciente vai fazer em outro lugar"
        />
        <label className="mt-3 block text-sm text-fg-2" htmlFor="ate">
          Não contatar até (opcional) — vale para <strong>todas</strong> as filas, não só esta
        </label>
        <input
          id="ate"
          type="date"
          className="mt-1 rounded border border-border bg-surface px-2 py-1 text-sm"
          value={ate}
          onChange={(e) => setAte(e.target.value)}
        />
        <div className="mt-3 flex gap-2">
          <Button
            tamanho="sm"
            disabled={pendente || motivo.trim().length < 3}
            onClick={() => onDispensar(motivo, ate || undefined)}
          >
            Dispensar
          </Button>
          <Button variante="secundario" tamanho="sm" onClick={() => setDispensando(false)}>
            Voltar
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border border-border bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-2">Canal:</span>
        {CANAIS.map((c) => (
          <button
            key={c.valor}
            type="button"
            onClick={() => setCanal(c.valor)}
            className={cn(
              'rounded px-2 py-0.5 text-xs',
              canal === c.valor ? 'bg-primary text-primary-fg' : 'bg-surface text-fg-2',
            )}
          >
            {c.rotulo}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {RESULTADOS.map((r) => (
          <Button
            key={r.valor}
            variante="secundario"
            tamanho="sm"
            disabled={pendente}
            onClick={() => onContato(canal, r.valor)}
          >
            {r.rotulo}
          </Button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button variante="secundario" tamanho="sm" disabled={pendente} onClick={onResolver}>
          Já marcou (resolver)
        </Button>
        <Button variante="secundario" tamanho="sm" onClick={() => setDispensando(true)}>
          Dispensar…
        </Button>
        <Button variante="secundario" tamanho="sm" onClick={onFechar}>
          Fechar
        </Button>
      </div>
    </div>
  )
}
