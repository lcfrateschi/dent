import { configuracaoAgenda, dadosDaAgenda } from '@/lib/agenda/consultas'
import { estruturaDaSemana, estruturaDoDia, inicioDaSemana } from '@/lib/agenda/grade'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { addDias } from '@/lib/domain/datas'
import { diaLocalIso } from '@/lib/domain/fuso'
import type { Metadata } from 'next'
import { AgendaCliente } from './AgendaCliente'

export const metadata: Metadata = { title: 'Agenda' }

type Busca = { visao?: string; ref?: string; prof?: string }

export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  const ator = await exigirPermissaoPagina('agenda', 'ler')
  const { visao: visaoParam, ref, prof } = await searchParams

  const visao = visaoParam === 'dia' ? 'dia' : 'semana'
  const profissionalId = prof && prof.length > 0 ? prof : null

  // O "hoje" da clínica vem do fuso configurado, não do fuso do servidor.
  // Lê só a configuração: chamar `dadosDaAgenda` aqui geraria um evento de
  // auditoria espúrio antes de saber o período que vamos mostrar.
  const agora = new Date()
  const config = await configuracaoAgenda()
  const hojeIso = diaLocalIso(agora, config.fuso)
  const refIso = ref && /^\d{4}-\d{2}-\d{2}$/.test(ref) ? ref : hojeIso

  const estrutura =
    visao === 'dia'
      ? estruturaDoDia({ diaIso: refIso, horario: config.horario, hojeIso })
      : estruturaDaSemana({
          segundaIso: inicioDaSemana(refIso),
          horario: config.horario,
          hojeIso,
        })

  const primeiro = estrutura.dias[0]?.iso ?? refIso
  const ultimo = estrutura.dias[estrutura.dias.length - 1]?.iso ?? refIso

  const dados = await dadosDaAgenda(ator, {
    deIso: primeiro,
    ateIso: ultimo,
    profissionalId: profissionalId ?? undefined,
  })

  const passo = visao === 'dia' ? 1 : 7
  const url = (novoRef: string): string => {
    const q = new URLSearchParams({ visao, ref: novoRef })
    if (profissionalId) q.set('prof', profissionalId)
    return `/agenda?${q.toString()}`
  }

  return (
    <AgendaCliente
      dados={dados}
      estrutura={estrutura}
      agoraIso={agora.toISOString()}
      visao={visao}
      refIso={refIso}
      profissionalId={profissionalId}
      podeEditar={pode(ator.perfil, 'agenda', 'editar')}
      podeCriar={pode(ator.perfil, 'agenda', 'criar')}
      navegacao={{
        anterior: url(addDias(refIso, -passo)),
        proximo: url(addDias(refIso, passo)),
        hoje: url(hojeIso),
      }}
    />
  )
}
