import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { acharCobranca, hojeDaClinica } from '@/lib/financeiro/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CobrancaCliente } from './CobrancaCliente'

export const metadata: Metadata = { title: 'Cobrança' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('cobranca', 'ler')
  const { id } = await params

  const [c, hoje] = await Promise.all([acharCobranca(ator, id), hojeDaClinica()])
  if (!c) notFound()

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href="/financeiro" className="text-fg-2 hover:text-fg">
          Financeiro
        </Link>
        <Link href={`/pacientes/${c.pacienteId}`} className="text-fg-2 hover:text-fg">
          {c.pacienteNome}
        </Link>
        <span className="font-medium text-fg">Cobrança</span>
      </nav>

      <div>
        <h1 className="text-xl font-semibold text-fg">{c.pacienteNome}</h1>
        <p className="text-sm text-fg-3">
          {c.orcamentoNumero ? (
            <>
              Orçamento{' '}
              <Link href={`/orcamentos/${c.orcamentoId}`} className="text-primary hover:underline">
                #{c.orcamentoNumero}
              </Link>{' '}
              ·{' '}
            </>
          ) : null}
          {c.qtdParcelas}× · {c.forma} · criada em {c.criadoEm.toLocaleDateString('pt-BR')}
          {c.criadoPorNome ? ` por ${c.criadoPorNome}` : ''}
        </p>
        {c.observacao ? <p className="mt-1 text-sm text-fg-2">{c.observacao}</p> : null}
      </div>

      {/*
        Dentista tem `cobranca:ler` mas NÃO `pagamento:criar` — vê o que foi
        cobrado do paciente dele sem poder mexer no caixa. Ver lib/authz.
      */}
      <CobrancaCliente
        cobranca={c}
        podeReceber={pode(ator.perfil, 'pagamento', 'criar')}
        podeCancelar={pode(ator.perfil, 'cobranca', 'excluir')}
        hojeIso={hoje}
      />

      <p className="text-xs text-fg-3">Este acesso foi registrado na trilha de auditoria.</p>
    </div>
  )
}
