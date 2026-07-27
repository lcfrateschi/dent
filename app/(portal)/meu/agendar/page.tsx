import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import {
  minhaListaDeEspera,
  meusFuturosAtivos,
  procedimentosDoPortal,
  profissionaisDoPortal,
  regraDoAutoatendimento,
  registrarAcessoDoPortal,
} from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Marcar } from './Marcar'

export const metadata: Metadata = { title: 'Marcar consulta' }

/**
 * Agendamento pelo paciente (Fase 19).
 *
 * ── Por que a página abre mesmo com o recurso desligado ─────────────────────
 * Porque "não existe" e "está desligado aqui" são coisas diferentes para quem
 * procurou o botão. Um 404 faria o paciente achar que errou o caminho e tentar de
 * novo; a página explica e aponta o telefone.
 *
 * ── O que ela NÃO mostra ───────────────────────────────────────────────────
 * Nada sobre os horários ocupados. `horariosLivres` devolve apenas os livres, então a
 * ausência de um horário é a única informação que sai daqui — e é inevitável numa
 * agenda pública. Quem o ocupa não passa por aqui.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const [regra, procedimentos, profissionais, futuros, espera] = await Promise.all([
    regraDoAutoatendimento(),
    procedimentosDoPortal(),
    profissionaisDoPortal(),
    meusFuturosAtivos(sessao),
    minhaListaDeEspera(sessao),
  ])

  await registrarAcessoDoPortal(sessao, 'agendar', { ativo: regra.ativo })

  const noTeto = futuros >= regra.maximoFuturosPorPaciente

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Marcar consulta</h1>
        <p className="text-sm text-fg-3">
          Escolha o profissional, o dia e o horário. A confirmação chega por WhatsApp.
        </p>
      </div>

      {!regra.ativo ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Esta clínica ainda não abriu o agendamento pelo portal. Fale com a recepção para
              marcar sua consulta.
            </p>
          </CardBody>
        </Card>
      ) : procedimentos.length === 0 || profissionais.length === 0 ? (
        <Card>
          <CardBody>
            {/* Configuração incompleta é diferente de recurso desligado, e o paciente
                não precisa saber a diferença — mas quem lê o log, sim. */}
            <p className="text-sm text-fg-2">
              Nenhum tipo de atendimento está disponível para marcar por aqui neste momento.
              Fale com a recepção.
            </p>
          </CardBody>
        </Card>
      ) : noTeto ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Você já tem {futuros} consulta{futuros > 1 ? 's' : ''} marcada
              {futuros > 1 ? 's' : ''}. Para marcar outra, fale com a recepção.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Marcar
          procedimentos={procedimentos}
          profissionais={profissionais}
          antecedenciaMinimaHoras={regra.antecedenciaMinimaHoras}
          antecedenciaMaximaDias={regra.antecedenciaMaximaDias}
          termo={regra.termoDeAtendimento}
        />
      )}

      {espera.length > 0 && (
        <Card>
          <CardHeader titulo="Lista de espera" />
          <CardBody>
            <ul className="space-y-1 text-sm text-fg-2">
              {espera.map((e) => (
                <li key={e.id}>
                  {e.procedimentoNome ?? 'Qualquer atendimento'} — turno {e.turno}, até{' '}
                  {e.validoAte.toLocaleDateString('pt-BR')}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-fg-3">
              Se vagar um horário, a clínica entra em contato.
            </p>
          </CardBody>
        </Card>
      )}
    </div>
  )
}
