import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { EtiquetaStatus } from '@/app/(staff)/pacientes/[id]/plano/PlanoCliente'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { diasParaVencer } from '@/lib/domain/orcamento'
import { acharOrcamento, hojeDaClinica } from '@/lib/orcamento/consultas'
import { BotaoArquivarPdf } from './BotaoArquivarPdf'
import { dataBr, dataHoraBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AcoesOrcamento } from './AcoesOrcamento'

export const metadata: Metadata = { title: 'Orçamento' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('orcamento', 'ler')
  const { id } = await params

  const [o, hoje] = await Promise.all([acharOrcamento(ator, id), hojeDaClinica()])
  if (!o) notFound()

  const dias = diasParaVencer(o.validadeAte, hoje)

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href={`/pacientes/${o.pacienteId}`} className="text-fg-2 hover:text-fg">
          Ficha
        </Link>
        <Link href={`/pacientes/${o.pacienteId}/plano`} className="text-fg-2 hover:text-fg">
          Plano e orçamentos
        </Link>
        <span className="font-medium text-fg">Orçamento #{o.numero}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-fg">Orçamento #{o.numero}</h1>
            <EtiquetaStatus status={o.statusVisivel} />
          </div>
          <p className="mt-0.5 text-sm text-fg-3">
            {o.pacienteNome} · emitido em {dataHoraBr(o.criadoEm)}
            {o.criadoPorNome ? ` por ${o.criadoPorNome}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/orcamentos/${o.id}/imprimir`} target="_blank">
            <Button>
              <Icone nome="anamnese" tamanho={14} />
              Imprimir
            </Button>
          </Link>
          {/* Arquivar é diferente de imprimir: grava UM arquivo com hash no
              prontuário, que é o que se confere quando o paciente aparece com a
              via dele meses depois. */}
          {pode(ator.perfil, 'orcamento', 'criar') ? (
            <BotaoArquivarPdf orcamentoId={o.id} jaArquivado={o.pdfKey !== null} />
          ) : null}
        </div>
      </div>

      {/* Aviso de vencimento: só faz sentido para quem ainda espera resposta. */}
      {o.status === 'enviado' ? (
        dias < 0 ? (
          <div className="rounded-(--radius-controle) border border-atencao/45 bg-atencao/10 px-3 py-2 text-sm text-atencao">
            Venceu há {Math.abs(dias)} dia(s). Para manter a proposta, gere um novo orçamento — o
            preço pode ter mudado.
          </div>
        ) : dias <= 7 ? (
          <div className="rounded-(--radius-controle) border border-atencao/45 bg-atencao/10 px-3 py-2 text-sm text-atencao">
            Vence em {dias} dia(s).
          </div>
        ) : null
      ) : null}

      <Card>
        <CardHeader
          titulo="Itens"
          descricao="Descrição e valor foram copiados na emissão — este documento não muda."
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2">
                <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                  <th className="px-4 py-2 font-semibold">Procedimento</th>
                  <th className="px-4 py-2 font-semibold">Detalhe</th>
                  <th className="px-4 py-2 text-center font-semibold">Qtd.</th>
                  <th className="px-4 py-2 text-right font-semibold">Valor</th>
                </tr>
              </thead>
              <tbody>
                {o.linhas.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium text-fg">{l.descricao}</td>
                    <td className="px-4 py-2 text-fg-2">{l.detalhe ?? '—'}</td>
                    <td className="px-4 py-2 text-center text-fg-2">{l.quantidade}</td>
                    <td className="px-4 py-2 text-right text-fg">{reais(l.valorUnitario)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader titulo="Valores" />
          <CardBody>
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
              <dt className="text-fg-3">Subtotal</dt>
              <dd className="text-right text-fg">{reais(o.valorBruto)}</dd>
              <dt className="text-fg-3">Desconto</dt>
              <dd className="text-right text-fg">{reais(o.desconto)}</dd>
              <dt className="border-t border-border pt-1.5 font-semibold text-fg">Total</dt>
              <dd className="border-t border-border pt-1.5 text-right text-lg font-semibold text-primary">
                {reais(o.valorTotal)}
              </dd>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader titulo="Andamento" />
          <CardBody>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-fg-3">Validade</dt>
              <dd className="text-fg">{dataBr(o.validadeAte)}</dd>
              <dt className="text-fg-3">Enviado</dt>
              <dd className="text-fg">{o.enviadoEm ? dataHoraBr(o.enviadoEm) : '—'}</dd>
              <dt className="text-fg-3">Decidido</dt>
              <dd className="text-fg">{o.decididoEm ? dataHoraBr(o.decididoEm) : '—'}</dd>
            </dl>
            {o.observacao ? (
              <p className="mt-3 border-t border-border pt-3 text-sm text-fg-2">{o.observacao}</p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      {pode(ator.perfil, 'orcamento', 'editar') ? (
        <Card>
          <CardHeader titulo="Ações" />
          <CardBody>
            <AcoesOrcamento
              id={o.id}
              status={o.status}
              numero={o.numero}
              pacienteId={o.pacienteId}
              temLinhas={o.linhas.length > 0}
            />
          </CardBody>
        </Card>
      ) : null}

      <p className="text-xs text-fg-3">Este acesso foi registrado na trilha de auditoria.</p>
    </div>
  )
}
