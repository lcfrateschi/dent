import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { addDias } from '@/lib/domain/datas'
import { ROTULO_BASE, explicarBase } from '@/lib/domain/comissao'
import { comissaoDoPeriodo, hojeDaClinica } from '@/lib/financeiro/consultas'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Comissões' }

type Busca = { de?: string; ate?: string }

export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  const ator = await exigirPermissaoPagina('relatorio_financeiro', 'ler')
  const { de, ate } = await searchParams

  const hoje = await hojeDaClinica()
  const valida = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)

  const deIso = valida(de) ?? `${hoje.slice(0, 7)}-01`
  const ateIso = valida(ate) ?? hoje

  const r = await comissaoDoPeriodo(ator, deIso, ateIso)

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <nav className="flex gap-3 text-sm">
        <Link href="/financeiro" className="text-fg-2 hover:text-fg">
          Financeiro
        </Link>
        <span className="font-medium text-fg">Comissões</span>
      </nav>

      <div>
        <h1 className="text-xl font-semibold text-fg">Comissões</h1>
        <p className="text-sm text-fg-3">
          {ROTULO_BASE[r.base]} · {dataBr(r.deIso)} a {dataBr(r.ateIso)}
        </p>
      </div>

      <div className="rounded-(--radius-controle) border-l-2 border-primary bg-surface-2 px-3 py-2.5 text-sm text-fg-2">
        {explicarBase(r.base)}
      </div>

      <form method="get" className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="de" className="mb-1 block text-sm font-medium text-fg-2">
            De
          </label>
          <input
            id="de"
            name="de"
            type="date"
            defaultValue={r.deIso}
            className="h-10 rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
          />
        </div>
        <div>
          <label htmlFor="ate" className="mb-1 block text-sm font-medium text-fg-2">
            Até
          </label>
          <input
            id="ate"
            name="ate"
            type="date"
            defaultValue={r.ateIso}
            className="h-10 rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
          />
        </div>
        <button
          type="submit"
          className="h-10 rounded-(--radius-controle) border border-border bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-2"
        >
          Filtrar
        </button>
        <Link
          href={`/financeiro/comissoes?de=${addDias(r.deIso, -30)}&ate=${addDias(r.deIso, -1)}`}
          className="h-10 rounded-(--radius-controle) px-3 text-sm leading-10 text-fg-2 hover:text-fg"
        >
          Período anterior
        </Link>
      </form>

      <Card>
        <CardHeader
          titulo="Por profissional"
          descricao={`${r.cobrancasConsideradas} cobrança(s) com pagamento conciliado no período`}
        />
        <CardBody className="p-0">
          {r.porProfissional.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">
              Nenhum pagamento conciliado neste período. Comissão só entra quando o dinheiro é
              confirmado.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Profissional</th>
                    <th className="px-4 py-2 text-center font-semibold">%</th>
                    <th className="px-4 py-2 text-center font-semibold">Cobranças</th>
                    <th className="px-4 py-2 text-right font-semibold">Base (recebido)</th>
                    <th className="px-4 py-2 text-right font-semibold">Comissão</th>
                  </tr>
                </thead>
                <tbody>
                  {r.porProfissional.map((p) => (
                    <tr key={p.profissionalId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 font-medium text-fg">{p.profissionalNome}</td>
                      <td className="px-4 py-2 text-center text-fg-2">{p.comissaoPct}%</td>
                      <td className="px-4 py-2 text-center text-fg-2">{p.cobrancas}</td>
                      <td className="px-4 py-2 text-right text-fg-2">{reais(p.baseDeCalculo)}</td>
                      <td className="px-4 py-2 text-right font-semibold text-fg">
                        {reais(p.comissao)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border-forte">
                    <td colSpan={3} className="px-4 py-2 font-semibold text-fg">
                      Total
                    </td>
                    <td className="px-4 py-2 text-right text-fg-2">{reais(r.totalBase)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-primary">
                      {reais(r.totalComissao)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        A base é rateada entre os profissionais na proporção do valor que cada um executou na
        cobrança. Um pagamento parcial gera comissão parcial.
      </p>
    </div>
  )
}
