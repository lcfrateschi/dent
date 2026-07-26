import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import {
  financeiroDoPortal,
  pagamentosDoPortal,
  registrarAcessoDoPortal,
} from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import { cn } from '@/lib/ui/cn'
import { reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = { title: 'Pagamentos' }

const ROTULO_MEIO: Readonly<Record<string, string>> = {
  dinheiro: 'Dinheiro',
  pix: 'PIX',
  debito: 'Cartão de débito',
  credito: 'Cartão de crédito',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  convenio: 'Convênio',
}

/**
 * Financeiro do paciente.
 *
 * Mostra o que ele deve e o que já pagou. **Em aberto e em atraso aparecem
 * separados** — a mesma separação da Fase 8, e pela mesma razão: somar os dois faria
 * o paciente achar que está mais devedor do que está.
 *
 * O que NÃO aparece: comissão do profissional, custo da clínica, valor de convênio.
 * São números da clínica, não dele.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const hoje = await hojeDaClinica()
  const [financeiro, pagamentos] = await Promise.all([
    financeiroDoPortal(sessao, hoje),
    pagamentosDoPortal(sessao),
  ])

  await registrarAcessoDoPortal(sessao, 'financeiro', {
    parcelas: financeiro.parcelas.length,
  })

  const temAtraso = Number(financeiro.totalVencido) > 0

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Pagamentos</h1>
        <p className="text-sm text-fg-3">Suas parcelas e o que já foi pago.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-(--radius-cartao) border border-border bg-surface px-4 py-3">
          <span className="block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
            Em aberto
          </span>
          <span className="mt-0.5 block text-xl font-semibold text-fg">
            {reais(financeiro.totalEmAberto)}
          </span>
          <span className="mt-0.5 block text-xs text-fg-3">Tudo que ainda falta pagar</span>
        </div>
        <div className="rounded-(--radius-cartao) border border-border bg-surface px-4 py-3">
          <span className="block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
            Em atraso
          </span>
          <span
            className={cn(
              'mt-0.5 block text-xl font-semibold',
              temAtraso ? 'text-critico' : 'text-fg',
            )}
          >
            {reais(financeiro.totalVencido)}
          </span>
          <span className="mt-0.5 block text-xs text-fg-3">
            {temAtraso ? 'Parcela com vencimento passado' : 'Nada atrasado'}
          </span>
        </div>
      </div>

      <Card>
        <CardHeader titulo="Suas parcelas" />
        <CardBody className="p-0">
          {financeiro.parcelas.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Você não tem parcelas registradas.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Nº</th>
                    <th className="px-4 py-2 font-semibold">Vencimento</th>
                    <th className="px-4 py-2 text-right font-semibold">Valor</th>
                    <th className="px-4 py-2 text-right font-semibold">Falta</th>
                  </tr>
                </thead>
                <tbody>
                  {financeiro.parcelas.map((p) => {
                    const quitada = Number(p.saldo) <= 0
                    return (
                      <tr key={p.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 text-fg-2">{p.numero}</td>
                        <td className="px-4 py-2">
                          <span className={p.vencida ? 'text-critico' : 'text-fg-2'}>
                            {formatar(p.vencimento)}
                          </span>
                          {p.vencida ? (
                            <span className="ml-1.5 text-xs font-medium text-critico">
                              <span aria-hidden>⚠</span> atrasada
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-2 text-right text-fg-2">{reais(p.valor)}</td>
                        <td className="px-4 py-2 text-right">
                          {quitada ? (
                            <span className="text-sm font-medium text-sucesso">
                              <span aria-hidden>✓</span> paga
                            </span>
                          ) : (
                            <span className="font-semibold text-fg">{reais(p.saldo)}</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Pagamentos registrados" descricao="O que a clínica já recebeu de você." />
        <CardBody className="p-0">
          {pagamentos.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Nenhum pagamento registrado.</p>
          ) : (
            <ul className="divide-y divide-border">
              {pagamentos.map((p) => (
                <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-sm">
                  <span className="text-fg-2">{formatar(p.pagoEm)}</span>
                  <span className="text-fg-3">
                    parcela {p.parcelaNumero} · {ROTULO_MEIO[p.meio] ?? p.meio}
                  </span>
                  <span className="ml-auto font-medium text-fg">{reais(p.valor)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        Alguma cobrança não parece certa? Fale com a clínica — este portal mostra o registro, e
        ajustes são feitos por lá.
      </p>
    </div>
  )
}

function formatar(iso: string): string {
  return iso.split('-').reverse().join('/')
}
