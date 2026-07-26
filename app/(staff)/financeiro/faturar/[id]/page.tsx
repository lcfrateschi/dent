import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { hojeDaClinica } from '@/lib/financeiro/consultas'
import { acharOrcamento } from '@/lib/orcamento/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FormularioFaturar } from './FormularioFaturar'

export const metadata: Metadata = { title: 'Faturar orçamento' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('cobranca', 'criar')
  const { id } = await params

  const [o, hoje] = await Promise.all([acharOrcamento(ator, id), hojeDaClinica()])
  if (!o) notFound()

  // O trigger `cobranca_valida_orcamento` também barra, mas chegar até o
  // formulário para descobrir isso é experiência ruim.
  if (o.status !== 'aprovado') {
    return (
      <div className="mx-auto max-w-2xl py-8">
        <h1 className="text-xl font-semibold text-fg">Orçamento não faturável</h1>
        <p className="mt-1 text-sm text-fg-2">
          O orçamento #{o.numero} está em <strong>{o.status}</strong>. Só orçamento aprovado gera
          cobrança.
        </p>
        <Link
          href={`/orcamentos/${o.id}`}
          className="mt-3 inline-block text-sm font-medium text-primary underline underline-offset-2"
        >
          Abrir o orçamento →
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <nav className="flex gap-3 text-sm">
        <Link href="/financeiro" className="text-fg-2 hover:text-fg">
          Financeiro
        </Link>
        <span className="font-medium text-fg">Faturar #{o.numero}</span>
      </nav>

      <FormularioFaturar
        orcamentoId={o.id}
        orcamentoNumero={o.numero}
        pacienteNome={o.pacienteNome}
        valorTotal={o.valorTotal}
        hojeIso={hoje}
      />
    </div>
  )
}
