import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { orcamentosDoPortal, registrarAcessoDoPortal } from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { cn } from '@/lib/ui/cn'
import { reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

export const metadata: Metadata = { title: 'Orçamentos' }

/**
 * Orçamentos do paciente.
 *
 * Só os enviados — rascunho é trabalho interno em andamento, e mostrar preço que
 * ainda vai mudar gera conversa difícil de desfazer.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const hoje = await hojeDaClinica()
  const lista = await orcamentosDoPortal(sessao, hoje)

  await registrarAcessoDoPortal(sessao, 'orcamentos', { quantidade: lista.length })

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Orçamentos</h1>
        <p className="text-sm text-fg-3">
          O que a clínica propôs, com o valor que foi combinado na emissão.
        </p>
      </div>

      {lista.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Você não tem orçamento enviado.</p>
          </CardBody>
        </Card>
      ) : (
        lista.map((o) => (
          <Card key={o.id}>
            <CardHeader
              titulo={`Orçamento nº ${o.numero}`}
              descricao={
                o.enviadoEm
                  ? `Enviado em ${o.enviadoEm.toLocaleDateString('pt-BR')}`
                  : undefined
              }
            />
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-lg font-semibold text-fg">{reais(o.valorTotal)}</span>
                <Situacao status={o.status} expirado={o.expirado} />
              </div>

              <p className="text-sm text-fg-3">
                {o.expirado
                  ? `Venceu em ${formatar(o.validadeAte)}. O preço pode ter mudado — fale com a clínica.`
                  : `Válido até ${formatar(o.validadeAte)}.`}
              </p>

              <Link
                href={`/meu/orcamentos/${o.id}`}
                className="inline-block text-sm font-medium text-primary hover:underline"
              >
                Ver os procedimentos
              </Link>
            </CardBody>
          </Card>
        ))
      )}
    </div>
  )
}

function Situacao({ status, expirado }: { status: string; expirado: boolean }) {
  // Dupla codificação: marca e cor. A marca sozinha já diz o estado.
  const estilo: Record<string, { cor: string; marca: string; rotulo: string }> = {
    enviado: { cor: 'text-atencao', marca: '○', rotulo: 'aguardando sua decisão' },
    aprovado: { cor: 'text-sucesso', marca: '✓', rotulo: 'aprovado por você' },
    recusado: { cor: 'text-fg-3', marca: '✕', rotulo: 'recusado' },
    expirado: { cor: 'text-fg-3', marca: '–', rotulo: 'vencido' },
  }
  const chave = expirado && status === 'enviado' ? 'expirado' : status
  const e = estilo[chave] ?? { cor: 'text-fg-2', marca: '·', rotulo: status }

  return (
    <span className={cn('text-sm font-medium', e.cor)}>
      <span aria-hidden>{e.marca}</span> {e.rotulo}
    </span>
  )
}

function formatar(iso: string): string {
  return iso.split('-').reverse().join('/')
}
