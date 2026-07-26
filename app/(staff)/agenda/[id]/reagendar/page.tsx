import { acharAgendamento, configuracaoAgenda } from '@/lib/agenda/consultas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { diaLocalIso, horaLocal } from '@/lib/domain/fuso'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { FormularioReagendar } from './FormularioReagendar'

export const metadata: Metadata = { title: 'Reagendar' }

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('agenda', 'editar')
  const { id } = await params

  const ag = await acharAgendamento(ator, id)
  if (!ag) notFound()

  const config = await configuracaoAgenda()
  const duracaoMin = Math.round((ag.fim.getTime() - ag.inicio.getTime()) / 60_000)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Reagendar</h1>
        <p className="text-sm text-fg-3">
          {ag.pacienteNome} · atualmente {diaLocalIso(ag.inicio, config.fuso)} às{' '}
          {horaLocal(ag.inicio, config.fuso)} com {ag.profissionalNome}
        </p>
      </div>

      <FormularioReagendar
        id={ag.id}
        profissionalId={ag.profissionalId}
        cadeiraId={ag.cadeiraId}
        diaAtual={diaLocalIso(ag.inicio, config.fuso)}
        duracaoMin={duracaoMin}
      />
    </div>
  )
}
