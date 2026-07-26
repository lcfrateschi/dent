import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { criarPaciente } from '@/lib/pacientes/acoes'
import { listarPacientes } from '@/lib/pacientes/consultas'
import { idadeEm } from '@/lib/domain/datas'
import type { Metadata } from 'next'
import { FormularioPaciente } from '../FormularioPaciente'

export const metadata: Metadata = { title: 'Novo paciente' }

export default async function Page() {
  const ator = await exigirPermissaoPagina('paciente', 'criar')

  // Candidatos a responsável: pacientes ativos maiores de idade.
  const { itens } = await listarPacientes(ator, { status: 'ativo', pagina: 1 })
  const hoje = new Date().toISOString().slice(0, 10)
  const responsaveis = itens
    .filter((p) => idadeEm(p.dataNascimento, hoje) >= 18)
    .map((p) => ({ id: p.id, nome: p.nome }))

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Novo paciente</h1>
        <p className="text-sm text-fg-3">
          Só nome e data de nascimento são obrigatórios — o resto pode ser completado depois.
        </p>
      </div>

      <FormularioPaciente
        responsaveis={responsaveis}
        acao={criarPaciente}
        cancelarHref="/pacientes"
      />
    </div>
  )
}
