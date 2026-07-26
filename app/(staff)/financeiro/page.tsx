import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { formatarTelefone } from '@/lib/domain/cpf'
import {
  inadimplencia,
  orcamentosAFaturar,
  painelFinanceiro,
} from '@/lib/financeiro/consultas'
import { cn } from '@/lib/ui/cn'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Financeiro' }

export default async function Page() {
  const ator = await exigirPermissaoPagina('cobranca', 'ler')

  const podeFaturar = pode(ator.perfil, 'cobranca', 'criar')

  const [painel, atrasadas, aFaturar] = await Promise.all([
    painelFinanceiro(ator),
    inadimplencia(ator),
    podeFaturar ? orcamentosAFaturar(ator) : Promise.resolve([]),
  ])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Financeiro</h1>
          <p className="text-sm text-fg-3">
            Posição em {dataBr(painel.hojeIso)}
          </p>
        </div>
        {pode(ator.perfil, 'relatorio_financeiro', 'ler') ? (
          <Link href="/financeiro/comissoes">
            <Button>
              <Icone nome="financeiro" tamanho={14} />
              Comissões
            </Button>
          </Link>
        ) : null}
      </div>

      {/* Quatro números, e a separação entre "a receber" e "em atraso" é
          deliberada: somar os dois faria a clínica parecer inadimplente. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Numero
          rotulo="A receber"
          valor={reais(painel.aReceber)}
          apoio="Tudo que ainda falta entrar"
        />
        <Numero
          rotulo="Em atraso"
          valor={reais(painel.emAtraso)}
          apoio={`${painel.parcelasVencidas} parcela(s) · ${painel.pacientesEmAtraso} paciente(s)`}
          tom={Number(painel.emAtraso) > 0 ? 'critico' : 'neutro'}
        />
        <Numero
          rotulo="Recebido no mês"
          valor={reais(painel.recebidoNoMes)}
          apoio={`${reais(painel.conciliadoNoMes)} já conciliado`}
          tom="sucesso"
        />
        <Numero
          rotulo="Aguardando conciliação"
          valor={reais(painel.aguardandoConciliacao)}
          apoio="Ainda não conta para comissão"
          tom={Number(painel.aguardandoConciliacao) > 0 ? 'atencao' : 'neutro'}
        />
      </div>

      {podeFaturar && aFaturar.length > 0 ? (
        <Card>
          <CardHeader
            titulo="A faturar"
            descricao={`${aFaturar.length} orçamento(s) aprovado(s) sem cobrança gerada`}
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {aFaturar.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <Link
                    href={`/orcamentos/${o.id}`}
                    className="font-mono font-semibold text-fg hover:text-primary hover:underline"
                  >
                    #{o.numero}
                  </Link>
                  <Link href={`/pacientes/${o.pacienteId}`} className="text-fg hover:text-primary">
                    {o.pacienteNome}
                  </Link>
                  {o.decididoEm ? (
                    <span className="text-xs text-fg-3">
                      aprovado em {o.decididoEm.toLocaleDateString('pt-BR')}
                    </span>
                  ) : null}
                  <span className="ml-auto font-semibold text-fg">{reais(o.valorTotal)}</span>
                  <Link href={`/financeiro/faturar/${o.id}`}>
                    <Button tamanho="sm" variante="primario">
                      Faturar
                    </Button>
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo="Inadimplência"
          descricao={
            atrasadas.length === 0
              ? 'Nenhuma parcela vencida com saldo.'
              : 'Da mais antiga para a mais recente — é a ordem em que se cobra.'
          }
        />
        <CardBody className="p-0">
          {atrasadas.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Nada em atraso.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Paciente</th>
                    <th className="px-4 py-2 font-semibold">Contato</th>
                    <th className="px-4 py-2 font-semibold">Parcela</th>
                    <th className="px-4 py-2 font-semibold">Vencimento</th>
                    <th className="px-4 py-2 text-right font-semibold">Atraso</th>
                    <th className="px-4 py-2 text-right font-semibold">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {atrasadas.map((l) => (
                    <tr key={l.parcelaId} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="px-4 py-2">
                        <Link
                          href={`/financeiro/cobrancas/${l.cobrancaId}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {l.pacienteNome}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-fg-2">
                        {l.pacienteTelefone ? formatarTelefone(l.pacienteTelefone) : '—'}
                      </td>
                      <td className="px-4 py-2 text-fg-2">{l.numero}</td>
                      <td className="px-4 py-2 text-fg-2">{dataBr(l.vencimento)}</td>
                      <td
                        className={cn(
                          'px-4 py-2 text-right font-medium',
                          l.diasAtraso > 30 ? 'text-critico' : 'text-atencao',
                        )}
                      >
                        {l.diasAtraso} dia{l.diasAtraso === 1 ? '' : 's'}
                      </td>
                      <td className="px-4 py-2 text-right font-semibold text-fg">
                        {reais(l.saldo)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        Este acesso foi registrado na trilha de auditoria.
      </p>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  apoio,
  tom = 'neutro',
}: {
  rotulo: string
  valor: string
  apoio: string
  tom?: 'neutro' | 'sucesso' | 'atencao' | 'critico'
}) {
  const cor = {
    neutro: 'text-fg',
    sucesso: 'text-sucesso',
    atencao: 'text-atencao',
    critico: 'text-critico',
  }[tom]

  return (
    <div className="rounded-(--radius-cartao) border border-border bg-surface px-4 py-3">
      <span className="block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
        {rotulo}
      </span>
      <span className={cn('mt-0.5 block text-xl font-semibold', cor)}>{valor}</span>
      <span className="mt-0.5 block text-xs text-fg-3">{apoio}</span>
    </div>
  )
}
