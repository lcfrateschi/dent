import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { Icone } from '@/components/ui/Icone'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { nomeDoPaciente } from '@/lib/documentos/consultas'
import { atorAtual } from '@/lib/authz/sessao'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FormularioAtestado, FormularioReceita } from './Formularios'

export const metadata: Metadata = { title: 'Atestado e receita' }

/**
 * Emissão de atestado e receita.
 *
 * A permissão é `prontuario: assinar` — atestado e receita são atos privativos do
 * cirurgião-dentista. A recepção pode anexar uma radiografia que o laboratório
 * mandou, mas não pode emitir estes dois.
 *
 * O impresso sai em PDF gerado no servidor e **fica arquivado no prontuário com
 * hash**. É o mesmo arquivo que o paciente leva e que a clínica guarda: se
 * amanhã houver dúvida sobre quantos dias o atestado deu, existe um artefato para
 * conferir, não uma tela que reimprime a partir dos dados de hoje.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await exigirPermissaoPagina('prontuario', 'assinar')
  const ator = await atorAtual()
  const { id } = await params

  const nome = await nomeDoPaciente(id)
  if (!nome) notFound()

  const semCro = !ator?.profissionalId

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href="/pacientes" className="text-fg-2 hover:text-fg">
          Pacientes
        </Link>
        <Link href={`/pacientes/${id}`} className="text-fg-2 hover:text-fg">
          {nome}
        </Link>
        <span className="font-medium text-fg">Atestado e receita</span>
      </nav>

      <div>
        <h1 className="text-xl font-semibold text-fg">Atestado e receita</h1>
        <p className="text-sm text-fg-3">
          Para {nome}. O PDF fica arquivado no prontuário — é o mesmo papel que o paciente leva.
        </p>
      </div>

      {semCro ? (
        <Alerta>
          Seu usuário não está vinculado a um profissional com CRO. Atestado e receita são atos
          privativos do cirurgião-dentista, então a emissão vai ser recusada.
        </Alerta>
      ) : null}

      <FormularioAtestado pacienteId={id} />
      <FormularioReceita pacienteId={id} />

      <Card>
        <CardHeader titulo="Onde os impressos ficam" />
        <CardBody className="space-y-2 text-sm text-fg-2">
          <p>
            Cada emissão gera um PDF anexado ao prontuário, com SHA-256 gravado. Nada disso se
            apaga: a exclusão é lógica, com motivo e autor.
          </p>
          <Link
            href={`/pacientes/${id}/documentos`}
            className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
          >
            <Icone nome="documentos" tamanho={14} />
            Ver documentos deste paciente
          </Link>
        </CardBody>
      </Card>
    </div>
  )
}
