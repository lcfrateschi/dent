'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { registrarPedidoDeExportacao } from './acoes'
import { useState, useTransition } from 'react'

const MOTIVOS = [
  'Pedido do próprio paciente',
  'Pedido do responsável legal',
  'Encaminhamento a outro profissional',
  'Requisição judicial',
  'Requisição de conselho profissional ou perícia',
  'Solicitação de convênio',
] as const

/**
 * Registra o motivo ANTES de abrir o documento.
 *
 * A ordem importa: se a impressão abrisse primeiro e o registro viesse depois,
 * fechar a aba deixaria uma exportação sem rastro. O motivo é gravado, e só
 * então a nova aba abre.
 */
export function FormularioExportacao({ pacienteId }: { pacienteId: string }) {
  const [motivo, setMotivo] = useState<string>(MOTIVOS[0])
  const [detalhe, setDetalhe] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  function exportar(): void {
    setErro(null)
    const completo = detalhe.trim() ? `${motivo} — ${detalhe.trim()}` : motivo

    iniciar(async () => {
      const r = await registrarPedidoDeExportacao(pacienteId, completo)
      if (!r.ok) {
        setErro(r.mensagem ?? 'Não foi possível registrar a exportação.')
        return
      }
      // Só depois de registrado.
      window.open(`/pacientes/${pacienteId}/prontuario/imprimir`, '_blank', 'noopener')
    })
  }

  return (
    <div className="space-y-3">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <div>
        <label htmlFor="motivo" className="mb-1 block text-sm font-medium text-fg-2">
          Motivo da exportação <span className="text-critico">*</span>
        </label>
        <select
          id="motivo"
          value={motivo}
          onChange={(e) => setMotivo(e.currentTarget.value)}
          className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        >
          {MOTIVOS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="detalhe" className="mb-1 block text-sm font-medium text-fg-2">
          Complemento
        </label>
        <input
          id="detalhe"
          value={detalhe}
          onChange={(e) => setDetalhe(e.currentTarget.value)}
          placeholder="Ex.: processo nº 0001234-56, ou nome do profissional destinatário"
          className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
        />
        <p className="mt-1 text-xs text-fg-3">
          Vai junto na trilha de auditoria. Numa requisição judicial, o número do processo é o que
          torna o registro defensável.
        </p>
      </div>

      <Button variante="primario" tamanho="lg" disabled={pendente} onClick={exportar}>
        {pendente ? 'Registrando…' : 'Registrar e abrir para impressão'}
      </Button>
    </div>
  )
}
