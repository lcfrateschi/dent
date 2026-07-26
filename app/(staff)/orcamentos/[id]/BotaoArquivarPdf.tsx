'use client'

import { Button } from '@/components/ui/Button'
import { Icone } from '@/components/ui/Icone'
import { gerarPdfDoOrcamento } from '@/lib/documentos/acoesImpressos'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Arquiva o PDF do orçamento no prontuário.
 *
 * Diferente de "imprimir": imprimir gera um papel a partir da tela de hoje;
 * arquivar grava **um** arquivo com SHA-256, que é o que a clínica mostra se o
 * paciente aparecer meses depois com a via dele. O orçamento já é congelado no
 * banco (`drizzle/0004`); isto fecha a lacuna do artefato.
 *
 * Uma vez arquivado, não gera outro — `orcamento.pdf_key` já está preenchido.
 */
export function BotaoArquivarPdf({
  orcamentoId,
  jaArquivado,
}: {
  orcamentoId: string
  jaArquivado: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string; documentoId?: string } | null>(
    null,
  )

  if (jaArquivado && !aviso) {
    return (
      <span className="text-xs text-fg-3">
        <span aria-hidden>✓</span> PDF já arquivado no prontuário
      </span>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {aviso ? (
        <span className={aviso.ok ? 'text-xs text-sucesso' : 'text-xs text-critico'} role="status">
          <span aria-hidden>{aviso.ok ? '✓' : '✕'}</span> {aviso.texto}
        </span>
      ) : null}

      {aviso?.documentoId ? (
        <a
          href={`/api/documentos/${aviso.documentoId}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-primary hover:underline"
        >
          abrir o PDF
        </a>
      ) : null}

      {aviso?.ok ? null : (
        <Button
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await gerarPdfDoOrcamento(orcamentoId)
              setAviso(
                r.ok
                  ? { ok: true, texto: r.mensagem, documentoId: r.documentoId }
                  : { ok: false, texto: r.mensagem },
              )
              if (r.ok) router.refresh()
            })
          }
        >
          <Icone nome="documentos" tamanho={14} />
          {pendente ? 'Arquivando…' : 'Arquivar PDF no prontuário'}
        </Button>
      )}
    </div>
  )
}
