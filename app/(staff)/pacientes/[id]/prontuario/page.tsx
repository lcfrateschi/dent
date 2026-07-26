import { Button } from '@/components/ui/Button'
import { FaixaAlertas } from '@/components/paciente/FaixaAlertas'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { acharPacienteResumo, alertasDoPaciente } from '@/lib/pacientes/consultas'
import {
  atendimentosSemEvolucao,
  montarProntuario,
  rascunhoAberto,
} from '@/lib/prontuario/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ProntuarioCliente } from './ProntuarioCliente'

export const metadata: Metadata = { title: 'Prontuário' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  /*
   * `prontuario:ler` só existe no perfil dentista. Recepção, financeiro e
   * ADMIN não entram aqui — o admin não é superusuário clínico, e é
   * justamente essa tentação que a LGPD pune.
   */
  const ator = await exigirPermissaoPagina('prontuario', 'ler')
  const { id } = await params

  const paciente = await acharPacienteResumo(id)
  if (!paciente) notFound()

  const podeEscrever = pode(ator.perfil, 'prontuario', 'criar') && ator.profissionalId !== null

  const [prontuario, rascunho, pendentes, alertas] = await Promise.all([
    montarProntuario(ator, id),
    ator.profissionalId ? rascunhoAberto(id, ator.profissionalId) : Promise.resolve(null),
    podeEscrever ? atendimentosSemEvolucao(id) : Promise.resolve([]),
    alertasDoPaciente(id),
  ])

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <FaixaAlertas alertas={alertas} />

      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href={`/pacientes/${id}`} className="text-fg-2 hover:text-fg">
          Ficha
        </Link>
        <Link href={`/pacientes/${id}/anamnese`} className="text-fg-2 hover:text-fg">
          Anamnese
        </Link>
        <Link href={`/pacientes/${id}/odontograma`} className="text-fg-2 hover:text-fg">
          Odontograma
        </Link>
        <Link href={`/pacientes/${id}/plano`} className="text-fg-2 hover:text-fg">
          Plano e orçamentos
        </Link>
        <span className="font-medium text-fg">Prontuário</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Prontuário</h1>
          <p className="text-sm text-fg-3">{paciente.nome}</p>
        </div>

        {pode(ator.perfil, 'prontuario', 'exportar') ? (
          <Link href={`/pacientes/${id}/prontuario/exportar`}>
            <Button>Exportar para o paciente</Button>
          </Link>
        ) : null}
      </div>

      <ProntuarioCliente
        pacienteId={id}
        pacienteNome={paciente.nome}
        prontuario={prontuario}
        rascunho={rascunho}
        atendimentosPendentes={pendentes}
        podeEscrever={podeEscrever}
        profissionalId={ator.profissionalId}
      />

      <p className="text-xs text-fg-3">
        Este acesso foi registrado na trilha de auditoria. Prontuário odontológico tem guarda mínima
        de 20 anos (CFO).
      </p>
    </div>
  )
}
