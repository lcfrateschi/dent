import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { multiplicar } from '@/lib/domain/dinheiro'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import {
  itensDoOrcamentoDoPortal,
  orcamentosDoPortal,
  registrarAcessoDoPortal,
} from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import { reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { DecisaoDoOrcamento } from './Decisao'

export const metadata: Metadata = { title: 'Orçamento' }

/**
 * Um orçamento, com os procedimentos e a decisão.
 *
 * Este é o **único lugar do portal em que um id vem da URL** — a tela precisa abrir
 * um orçamento específico. A defesa não é confiar no id: é
 * `itensDoOrcamentoDoPortal` filtrar por `sessao.pacienteId` na mesma consulta.
 * Trocar o id na URL para o de outro paciente devolve 404, não o orçamento dele.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const { id } = await params
  const dados = await itensDoOrcamentoDoPortal(sessao, id)
  if (!dados) notFound()

  const hoje = await hojeDaClinica()
  const lista = await orcamentosDoPortal(sessao, hoje)
  const cabecalho = lista.find((o) => o.id === id)
  if (!cabecalho) notFound()

  await registrarAcessoDoPortal(sessao, 'orcamento', { numero: dados.numero })

  const podeDecidir = cabecalho.status === 'enviado' && !cabecalho.expirado

  return (
    <div className="space-y-4">
      <nav className="text-sm">
        <Link href="/meu/orcamentos" className="text-fg-2 hover:text-fg">
          ← Orçamentos
        </Link>
      </nav>

      <div>
        <h1 className="text-xl font-semibold text-fg">Orçamento nº {dados.numero}</h1>
        <p className="text-sm text-fg-3">
          {cabecalho.expirado
            ? `Venceu em ${formatar(cabecalho.validadeAte)}`
            : `Válido até ${formatar(cabecalho.validadeAte)}`}
        </p>
      </div>

      <Card>
        <CardHeader
          titulo="Procedimentos"
          descricao="Os valores foram copiados na emissão — este documento não muda."
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2">
                <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                  <th className="px-4 py-2 font-semibold">Procedimento</th>
                  <th className="px-4 py-2 text-right font-semibold">Qtd.</th>
                  <th className="px-4 py-2 text-right font-semibold">Valor</th>
                </tr>
              </thead>
              <tbody>
                {dados.itens.map((i) => (
                  <tr key={i.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <span className="text-fg">{i.descricao}</span>
                      {i.detalhe ? (
                        <span className="block text-xs text-fg-3">{i.detalhe}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right text-fg-2">{i.quantidade}</td>
                    <td className="px-4 py-2 text-right text-fg">
                      {reais(multiplicar(i.valorUnitario, i.quantidade))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {Number(cabecalho.desconto) > 0 ? (
                  <tr className="border-t border-border">
                    <td colSpan={2} className="px-4 py-2 text-right text-fg-2">
                      Desconto
                    </td>
                    <td className="px-4 py-2 text-right text-sucesso">
                      − {reais(cabecalho.desconto)}
                    </td>
                  </tr>
                ) : null}
                <tr className="border-t-2 border-border-forte">
                  <td colSpan={2} className="px-4 py-2 text-right font-semibold text-fg">
                    Total
                  </td>
                  <td className="px-4 py-2 text-right text-lg font-semibold text-primary">
                    {reais(cabecalho.valorTotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardBody>
      </Card>

      {podeDecidir ? (
        <Card>
          <CardHeader
            titulo="Sua decisão"
            descricao="Aprovar aqui vale como aceite. Depois disso a clínica organiza o tratamento e as parcelas."
          />
          <CardBody>
            <DecisaoDoOrcamento orcamentoId={id} />
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              {cabecalho.status === 'aprovado'
                ? 'Você aprovou este orçamento.'
                : cabecalho.status === 'recusado'
                  ? 'Você recusou este orçamento.'
                  : 'Este orçamento venceu e não pode mais ser aprovado aqui. Fale com a clínica para receber um novo.'}
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function formatar(iso: string): string {
  return iso.split('-').reverse().join('/')
}
