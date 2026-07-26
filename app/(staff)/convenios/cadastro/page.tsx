import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { conveniosCadastrados } from '@/lib/convenios/consultas'
import { formatarCnpj } from '@/lib/domain/cnpj'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { cn } from '@/lib/ui/cn'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ConvenioControles, NovoConvenio } from './Controles'

export const metadata: Metadata = { title: 'Operadoras' }

/**
 * Cadastro de operadoras.
 *
 * A coluna que importa é **preços vigentes**: operadora cadastrada sem tabela
 * negociada não fatura nada. `precoVigenteEm` não encontra valor, a guia sai com
 * o valor particular (que a operadora não paga) ou nem sai — e a descoberta
 * acontece no fim do mês, quando o lote é montado.
 */
export default async function Page() {
  await exigirPermissaoPagina('convenio', 'ler')
  const hoje = await hojeDaClinica()
  const lista = await conveniosCadastrados(hoje)

  const semTabela = lista.filter((c) => c.ativo && c.precosVigentes === 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/convenios" className="text-xs text-fg-3 hover:underline">
            ← Convênios
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-fg">
            <Icone nome="convenios" tamanho={18} />
            Operadoras
          </h1>
          <p className="text-sm text-fg-3">Cadastro, prazo de pagamento e tabela negociada</p>
        </div>
        <NovoConvenio />
      </div>

      {lista.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Nenhuma operadora cadastrada. Enquanto não houver, todo atendimento é particular — o
              que é um começo válido: o modelo financeiro já nasceu sabendo que convênio existe, e
              adicionar uma operadora depois não refaz nada.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {semTabela.length > 0 ? (
        <Alerta tipo="atencao">
          <strong>
            {semTabela.length} operadora(s) ativa(s) sem nenhum preço vigente:{' '}
            {semTabela.map((c) => c.nome).join(', ')}.
          </strong>{' '}
          Sem tabela negociada não há o que faturar — a guia sairia com o valor particular, que a
          operadora não paga.
        </Alerta>
      ) : null}

      {lista.length > 0 ? (
        <Card>
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                    <th className="px-4 py-2 font-medium">Operadora</th>
                    <th className="px-4 py-2 font-medium">Registro ANS</th>
                    <th className="px-4 py-2 font-medium">CNPJ</th>
                    <th className="px-4 py-2 font-medium">Prazo</th>
                    <th className="px-4 py-2 font-medium">Preços vigentes</th>
                    <th className="px-4 py-2 font-medium">Pacientes</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {lista.map((c) => (
                    <tr
                      key={c.id}
                      className={cn('border-b border-border/60 last:border-0', !c.ativo && 'text-fg-3')}
                    >
                      <td className="px-4 py-2">
                        <Link
                          href={`/convenios/cadastro/${c.id}`}
                          className={cn('font-medium hover:underline', c.ativo ? 'text-fg' : 'text-fg-3')}
                        >
                          {c.nome}
                        </Link>
                        {!c.ativo ? (
                          <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px]">
                            inativa
                          </span>
                        ) : null}
                        {c.contatoNome ? (
                          <span className="block text-xs text-fg-3">{c.contatoNome}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{c.registroAns ?? '—'}</td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {c.cnpj ? formatarCnpj(c.cnpj) : '—'}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-xs">
                        {c.prazoPagamentoDias} dias
                        {c.diaFechamento ? (
                          <span className="block text-fg-3">fecha dia {c.diaFechamento}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        <span
                          className={cn(
                            c.precosVigentes === 0 && c.ativo ? 'font-medium text-atencao' : '',
                          )}
                        >
                          {c.precosVigentes}
                        </span>
                        {c.precosTotais > c.precosVigentes ? (
                          <span className="ml-1 text-xs text-fg-3">
                            (+{c.precosTotais - c.precosVigentes} histórico)
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 tabular-nums">{c.pacientes}</td>
                      <td className="px-4 py-2">
                        <ConvenioControles
                          convenio={{
                            id: c.id,
                            nome: c.nome,
                            registroAns: c.registroAns,
                            cnpj: c.cnpj,
                            prazoPagamentoDias: c.prazoPagamentoDias,
                            diaFechamento: c.diaFechamento,
                            contatoNome: c.contatoNome,
                            contatoTelefone: c.contatoTelefone,
                            observacoes: c.observacoes,
                            ativo: c.ativo,
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader titulo="O registro ANS vai no XML" />
        <CardBody>
          <p className="text-sm text-fg-2">
            São 5 ou 6 dígitos, e é como a ANS identifica a operadora. Errado, o lote é recusado na
            recepção da operadora — não item por item, o lote inteiro. Ele está no carnê e no site
            da operadora.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
