import { criarAgendamento } from '@/lib/agenda/acoes'
import {
  configuracaoAgenda,
  procedimentosParaAgenda,
  profissionaisAtivos,
} from '@/lib/agenda/consultas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { cadeira } from '@/lib/db/schema'
import { paciente } from '@/lib/db/schema'
import { diaLocalIso } from '@/lib/domain/fuso'
import { asc, eq, sql } from 'drizzle-orm'
import type { Metadata } from 'next'
import { FormularioAgendamento } from '../FormularioAgendamento'

export const metadata: Metadata = { title: 'Novo agendamento' }

type Busca = { dia?: string; hora?: string; prof?: string; paciente?: string }

export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  await exigirPermissaoPagina('agenda', 'criar')
  const { dia, hora, prof, paciente: pacienteId } = await searchParams

  const config = await configuracaoAgenda()
  const hojeIso = diaLocalIso(new Date(), config.fuso)

  const [pacientes, profissionais, cadeiras, procedimentos] = await Promise.all([
    // Só ativos: agendar paciente arquivado é quase sempre engano.
    db
      .select({ id: paciente.id, nome: paciente.nome })
      .from(paciente)
      .where(eq(paciente.status, 'ativo'))
      .orderBy(asc(sql`lower(${paciente.nome})`))
      .limit(500),
    profissionaisAtivos(),
    db
      .select({ id: cadeira.id, nome: cadeira.nome })
      .from(cadeira)
      .where(eq(cadeira.ativo, true))
      .orderBy(asc(cadeira.ordem)),
    procedimentosParaAgenda(),
  ])

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Novo agendamento</h1>
        <p className="text-sm text-fg-3">
          Os horários oferecidos já descontam funcionamento, bloqueios e ocupação.
        </p>
      </div>

      <FormularioAgendamento
        pacientes={pacientes}
        profissionais={profissionais.map((p) => ({ id: p.id, nome: p.nome }))}
        cadeiras={cadeiras}
        procedimentos={procedimentos}
        inicial={{
          dia: dia && /^\d{4}-\d{2}-\d{2}$/.test(dia) ? dia : hojeIso,
          hora: hora && /^\d{2}:\d{2}$/.test(hora) ? hora : undefined,
          profissionalId: prof,
          pacienteId,
        }}
        acao={criarAgendamento}
      />
    </div>
  )
}
