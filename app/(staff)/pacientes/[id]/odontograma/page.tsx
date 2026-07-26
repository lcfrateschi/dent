import { FaixaAlertas } from '@/components/paciente/FaixaAlertas'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { estadoDoOdontograma, procedimentosPorDente } from '@/lib/odontograma/consultas'
import { acharPacienteResumo, alertasDoPaciente } from '@/lib/pacientes/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { OdontogramaClinico } from './OdontogramaClinico'

export const metadata: Metadata = { title: 'Odontograma' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  // Odontograma é dado clínico: recepção e financeiro não entram aqui.
  const ator = await exigirPermissaoPagina('odontograma', 'ler')
  const { id } = await params

  const paciente = await acharPacienteResumo(id)
  if (!paciente) notFound()

  const [estado, procedimentos, alertas] = await Promise.all([
    estadoDoOdontograma(ator, id),
    procedimentosPorDente(),
    alertasDoPaciente(id),
  ])

  return (
    <div className="space-y-4">
      {/* Alertas antes de tudo: alergia e anticoagulante mudam o planejamento. */}
      <FaixaAlertas alertas={alertas} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex gap-3 text-sm">
          <Link href={`/pacientes/${id}`} className="text-fg-2 hover:text-fg">
            Ficha
          </Link>
          <Link href={`/pacientes/${id}/anamnese`} className="text-fg-2 hover:text-fg">
            Anamnese
          </Link>
          <span className="font-medium text-fg">Odontograma</span>
        </nav>
      </div>

      <OdontogramaClinico
        pacienteId={id}
        pacienteNome={paciente.nome}
        marcacoesFace={estado.marcacoesFace}
        marcacoesDente={estado.marcacoesDente}
        itens={estado.itens}
        procedimentos={procedimentos}
        podePlanejar={pode(ator.perfil, 'plano_tratamento', 'criar')}
        podeExecutar={pode(ator.perfil, 'odontograma', 'editar')}
      />

      <p className="text-xs text-fg-3">Este acesso foi registrado na trilha de auditoria.</p>
    </div>
  )
}
