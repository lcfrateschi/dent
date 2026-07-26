import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { FaixaAlertas } from '@/components/paciente/FaixaAlertas'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { orcamentosDoPaciente, planoDoPaciente } from '@/lib/orcamento/consultas'
import { acharPacienteResumo, alertasDoPaciente } from '@/lib/pacientes/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PlanoCliente } from './PlanoCliente'

export const metadata: Metadata = { title: 'Plano de tratamento' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('plano_tratamento', 'ler')
  const { id } = await params

  const paciente = await acharPacienteResumo(id)
  if (!paciente) notFound()

  const [plano, orcamentos, alertas] = await Promise.all([
    planoDoPaciente(ator, id),
    orcamentosDoPaciente(id),
    pode(ator.perfil, 'alerta_clinico', 'ler') ? alertasDoPaciente(id) : Promise.resolve([]),
  ])

  return (
    <div className="space-y-4">
      <FaixaAlertas alertas={alertas} />

      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href={`/pacientes/${id}`} className="text-fg-2 hover:text-fg">
          Ficha
        </Link>
        {pode(ator.perfil, 'anamnese', 'criar') ? (
          <Link href={`/pacientes/${id}/anamnese`} className="text-fg-2 hover:text-fg">
            Anamnese
          </Link>
        ) : null}
        {pode(ator.perfil, 'odontograma', 'ler') ? (
          <Link href={`/pacientes/${id}/odontograma`} className="text-fg-2 hover:text-fg">
            Odontograma
          </Link>
        ) : null}
        {pode(ator.perfil, 'prontuario', 'ler') ? (
          <Link href={`/pacientes/${id}/prontuario`} className="text-fg-2 hover:text-fg">
            Prontuário
          </Link>
        ) : null}
        <span className="font-medium text-fg">Plano e orçamentos</span>
      </nav>

      <div>
        <h1 className="text-xl font-semibold text-fg">Plano de tratamento</h1>
        <p className="text-sm text-fg-3">{paciente.nome}</p>
      </div>

      {plano ? (
        <PlanoCliente
          plano={plano}
          orcamentos={orcamentos}
          podeOrcar={pode(ator.perfil, 'orcamento', 'criar')}
          podeEditar={pode(ator.perfil, 'plano_tratamento', 'editar')}
        />
      ) : (
        <Card>
          <CardHeader
            titulo="Nenhum plano ativo"
            descricao="O plano é criado automaticamente quando o primeiro procedimento é marcado no odontograma."
          />
          <CardBody>
            {pode(ator.perfil, 'odontograma', 'ler') ? (
              <Link
                href={`/pacientes/${id}/odontograma`}
                className="text-sm font-medium text-primary underline underline-offset-2"
              >
                Abrir o odontograma →
              </Link>
            ) : (
              <p className="text-sm text-fg-3">
                Seu perfil não tem acesso ao odontograma. Peça ao dentista para montar o plano.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <p className="text-xs text-fg-3">Este acesso foi registrado na trilha de auditoria.</p>
    </div>
  )
}
