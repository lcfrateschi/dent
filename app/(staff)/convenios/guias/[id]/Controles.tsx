'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { ROTULO_CLASSE_GLOSA, type ClasseGlosa } from '@/lib/domain/convenio'
import { cancelarGuia, enviarGuia, recorrerDaGlosa, registrarRetornoDeItem } from '@/lib/tiss/acoes'
import { reais } from '@/lib/ui/moeda'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/** Enviar ou cancelar a guia. */
export function AcoesDaGuia({
  guiaId,
  numero,
  emRascunho,
  temPendencias,
}: {
  guiaId: string
  numero: string
  emRascunho: boolean
  temPendencias: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [modo, setModo] = useState<'nada' | 'enviar' | 'cancelar'>('nada')
  const [lote, setLote] = useState('')
  const [motivo, setMotivo] = useState('')
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  if (!emRascunho) {
    return aviso ? (
      <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta>
    ) : null
  }

  return (
    <div className="space-y-2 rounded-(--radius-controle) border border-border bg-surface-2 p-3">
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      {modo === 'enviar' ? (
        <div className="space-y-2">
          <label htmlFor="lote" className="block text-sm font-medium text-fg-2">
            Número do lote
          </label>
          <input
            id="lote"
            value={lote}
            onChange={(e) => setLote(e.currentTarget.value)}
            placeholder="LOTE-2026-07"
            className="h-9 w-full max-w-xs rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
          />
          <p className="text-xs text-fg-3">
            É como a operadora identifica o protocolo. Depois de enviar, o que foi apresentado não
            muda mais — para corrigir, seria preciso cancelar e emitir outra guia.
          </p>
          {temPendencias ? (
            <p className="text-xs font-medium text-atencao">
              <span aria-hidden>⚠</span> Há pendências acima. Enviar assim provavelmente vai gerar
              glosa.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              variante="primario"
              disabled={pendente}
              onClick={() =>
                iniciar(async () => {
                  const r = await enviarGuia(guiaId, lote)
                  setAviso(r)
                  if (r.ok) {
                    setModo('nada')
                    router.refresh()
                  }
                })
              }
            >
              {pendente ? 'Enviando…' : `Confirmar envio da guia ${numero}`}
            </Button>
            <Button variante="fantasma" onClick={() => setModo('nada')}>
              Voltar
            </Button>
          </div>
        </div>
      ) : modo === 'cancelar' ? (
        <div className="space-y-2">
          <label htmlFor="motivo" className="block text-sm font-medium text-fg-2">
            Por que está cancelando?
          </label>
          <input
            id="motivo"
            value={motivo}
            onChange={(e) => setMotivo(e.currentTarget.value)}
            placeholder="Ex.: procedimento errado na seleção"
            className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
          />
          <p className="text-xs text-fg-3">
            Os procedimentos voltam para a fila de faturamento.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={pendente}
              onClick={() =>
                iniciar(async () => {
                  const r = await cancelarGuia(guiaId, motivo)
                  setAviso(r)
                  if (r.ok) router.push('/convenios')
                })
              }
            >
              {pendente ? 'Cancelando…' : 'Confirmar cancelamento'}
            </Button>
            <Button variante="fantasma" onClick={() => setModo('nada')}>
              Voltar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variante="primario" onClick={() => setModo('enviar')}>
            Enviar à operadora
          </Button>
          <Button variante="fantasma" onClick={() => setModo('cancelar')}>
            Cancelar guia
          </Button>
        </div>
      )}
    </div>
  )
}

const CLASSES: readonly ClasseGlosa[] = [
  'erro_de_envio',
  'nao_coberto',
  'elegibilidade',
  'valor',
  'falta_documento',
  'prazo',
  'outro',
]

/**
 * Registra o retorno da operadora para um item.
 *
 * O campo é **quanto a operadora pagou** — a glosa é calculada daí. Pedir o valor
 * da glosa levaria a dois números digitados que podem discordar, e conciliação que
 * não fecha é o que mais consome tempo no faturamento de convênio.
 */
export function RetornoDoItem({
  itemGuiaId,
  valorApresentado,
}: {
  itemGuiaId: string
  valorApresentado: string
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [valorPago, setValorPago] = useState(valorApresentado)
  const [classe, setClasse] = useState<ClasseGlosa>('erro_de_envio')
  const [motivo, setMotivo] = useState('')
  const [codigo, setCodigo] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const glosa = Math.max(
    0,
    Math.round(Number(valorApresentado) * 100) - Math.round(Number(valorPago) * 100),
  )
  const houveGlosa = glosa > 0

  if (!aberto) {
    return (
      <Button tamanho="sm" onClick={() => setAberto(true)}>
        Retorno
      </Button>
    )
  }

  return (
    <div className="w-64 space-y-2">
      <label htmlFor={`pago-${itemGuiaId}`} className="block text-xs font-medium text-fg-2">
        Quanto a operadora pagou
      </label>
      <input
        id={`pago-${itemGuiaId}`}
        value={valorPago}
        onChange={(e) => setValorPago(e.currentTarget.value)}
        className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg"
      />

      {houveGlosa ? (
        <>
          <p className="text-xs font-medium text-critico">
            Glosa de {reais((glosa / 100).toFixed(2))}
          </p>
          <select
            value={classe}
            onChange={(e) => setClasse(e.currentTarget.value as ClasseGlosa)}
            aria-label="Classe da glosa"
            className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-1 text-xs text-fg"
          >
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {ROTULO_CLASSE_GLOSA[c]}
              </option>
            ))}
          </select>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.currentTarget.value)}
            placeholder="Motivo que a operadora deu"
            aria-label="Motivo da glosa"
            className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-xs text-fg placeholder:text-fg-3"
          />
          <input
            value={codigo}
            onChange={(e) => setCodigo(e.currentTarget.value)}
            placeholder="Código da operadora (opcional)"
            aria-label="Código da glosa na operadora"
            className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-xs text-fg placeholder:text-fg-3"
          />
        </>
      ) : null}

      {erro ? <p className="text-xs text-critico">{erro}</p> : null}

      <div className="flex gap-1">
        <Button
          tamanho="sm"
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await registrarRetornoDeItem({
                itemGuiaId,
                valorPago,
                classeGlosa: houveGlosa ? classe : undefined,
                motivoGlosa: houveGlosa ? motivo : undefined,
                codigoOperadora: codigo || undefined,
              })
              if (r.ok) {
                setAberto(false)
                router.refresh()
              } else {
                setErro(r.mensagem)
              }
            })
          }
        >
          {pendente ? '…' : 'Registrar'}
        </Button>
        <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(false)}>
          Fechar
        </Button>
      </div>
    </div>
  )
}

/** Recorre de uma glosa. */
export function RecursoDaGlosa({ glosaId }: { glosaId: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [argumento, setArgumento] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  if (!aberto) {
    return (
      <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(true)}>
        Recorrer
      </Button>
    )
  }

  return (
    <div className="space-y-1">
      <textarea
        value={argumento}
        onChange={(e) => setArgumento(e.currentTarget.value)}
        rows={3}
        placeholder="O que a operadora vai analisar: o dado correto, o documento anexado, a cláusula do contrato…"
        aria-label="Argumento do recurso"
        className="w-full rounded-(--radius-controle) border border-border bg-surface px-2 py-1 text-xs text-fg placeholder:text-fg-3"
      />
      {erro ? <p className="text-xs text-critico">{erro}</p> : null}
      <div className="flex gap-1">
        <Button
          tamanho="sm"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await recorrerDaGlosa(glosaId, argumento)
              if (r.ok) {
                setAberto(false)
                router.refresh()
              } else {
                setErro(r.mensagem)
              }
            })
          }
        >
          {pendente ? '…' : 'Enviar recurso'}
        </Button>
        <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(false)}>
          Fechar
        </Button>
      </div>
    </div>
  )
}
