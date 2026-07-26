import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { acharPacienteResumo } from '@/lib/pacientes/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FormularioExportacao } from './FormularioExportacao'

export const metadata: Metadata = { title: 'Exportar prontuário' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('prontuario', 'exportar')
  const { id } = await params

  const paciente = await acharPacienteResumo(id)
  if (!paciente) notFound()

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <nav className="flex gap-3 text-sm">
        <Link href={`/pacientes/${id}/prontuario`} className="text-fg-2 hover:text-fg">
          Prontuário
        </Link>
        <span className="font-medium text-fg">Exportar</span>
      </nav>

      <Card>
        <CardHeader
          titulo="Exportar prontuário"
          descricao={paciente.nome}
        />
        <CardBody className="space-y-4">
          <div className="rounded-(--radius-controle) border border-atencao/45 bg-atencao/10 px-3 py-2.5 text-sm text-fg-2">
            <p className="font-semibold text-atencao">
              Esta é a ação mais sensível do sistema.
            </p>
            <p className="mt-1">
              Você vai gerar o histórico clínico completo em papel. O paciente tem direito de pedir
              (LGPD, art. 18, e norma do CFO), mas <strong>cada entrega fica registrada</strong> na
              trilha de auditoria com o motivo informado — é isso que diferencia atender a um pedido
              legítimo de vazar prontuário.
            </p>
          </div>

          <FormularioExportacao pacienteId={id} />

          <div className="border-t border-border pt-3 text-xs text-fg-3">
            <p className="font-semibold text-fg-2">Antes de entregar:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>Confirme a identidade de quem recebe. Se for terceiro, exija procuração.</li>
              <li>Para paciente menor de idade, a entrega é ao responsável legal cadastrado.</li>
              <li>
                Rascunhos não assinados aparecem marcados: eles não são prontuário e não deveriam
                ser entregues como tal.
              </li>
            </ul>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
