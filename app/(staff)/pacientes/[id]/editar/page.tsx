import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { idadeEm } from '@/lib/domain/datas'
import { atualizarPaciente } from '@/lib/pacientes/acoes'
import { acharPaciente, listarPacientes } from '@/lib/pacientes/consultas'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { FormularioPaciente } from '../../FormularioPaciente'

export const metadata: Metadata = { title: 'Editar paciente' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('paciente', 'editar')
  const { id } = await params

  const p = await acharPaciente(ator, id)
  if (!p) notFound()

  const { itens } = await listarPacientes(ator, { status: 'ativo', pagina: 1 })
  const hoje = new Date().toISOString().slice(0, 10)
  const responsaveis = itens
    // Um paciente não pode ser responsável por si mesmo — nem aparece na lista.
    .filter((c) => c.id !== id && idadeEm(c.dataNascimento, hoje) >= 18)
    .map((c) => ({ id: c.id, nome: c.nome }))

  // `bind` fixa o id: a action recebe (id, estadoAnterior, formData).
  const acao = atualizarPaciente.bind(null, id)

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Editar paciente</h1>
        <p className="text-sm text-fg-3">{p.nome}</p>
      </div>

      <FormularioPaciente
        paciente={p}
        responsaveis={responsaveis}
        acao={acao}
        cancelarHref={`/pacientes/${id}`}
      />
    </div>
  )
}
