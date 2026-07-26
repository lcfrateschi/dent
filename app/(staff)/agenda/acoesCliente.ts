'use server'

import { horariosLivres } from '@/lib/agenda/consultas'
import { exigirPermissao } from '@/lib/authz/sessao'

/**
 * Consulta de horários livres para o formulário.
 *
 * Separada em arquivo próprio porque é a única server action chamada de dentro
 * de um `useEffect` — e mesmo sendo só leitura de disponibilidade, passa por
 * `exigirPermissao`: server action é endpoint público, e sem a checagem
 * qualquer pessoa mapearia a agenda da clínica.
 */
export async function buscarHorariosLivres({
  diaIso,
  profissionalId,
  duracaoMin,
  cadeiraId,
  ignorarAgendamentoId,
}: {
  diaIso: string
  profissionalId: string
  duracaoMin: number
  cadeiraId?: string | undefined
  ignorarAgendamentoId?: string | undefined
}): Promise<readonly string[]> {
  await exigirPermissao('agenda', 'ler')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(diaIso)) return []
  if (duracaoMin < 5 || duracaoMin > 480) return []

  const livres = await horariosLivres({
    diaIso,
    profissionalId,
    duracaoMin,
    cadeiraId,
    ignorarAgendamentoId,
  })
  // Só as horas: o cliente não precisa dos instantes, e menos dado no wire é melhor.
  return livres.map((l) => l.hora)
}
