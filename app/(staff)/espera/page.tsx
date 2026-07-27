import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { filaDeEspera } from '@/lib/autoatendimento/fila'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { dataBr, dataHoraBr } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { FilaDeEspera, type LinhaNaTela } from './FilaDeEspera'

export const metadata: Metadata = { title: 'Lista de espera' }

const TURNO: Readonly<Record<string, string>> = {
  manha: 'Manhã',
  tarde: 'Tarde',
  qualquer: 'Qualquer turno',
}

/**
 * A lista de espera, do lado de quem liga.
 *
 * ── Por que esta tela existe ────────────────────────────────────────────────
 * A Fase 19 deu ao paciente o botão "me avise se vagar algo mais cedo" e não deu à
 * recepção nada para fazer com isso. Os pedidos entravam no banco e ficavam lá — o
 * recurso existia para o paciente e não existia para a clínica, que é a pior forma
 * de meia funcionalidade: gera expectativa e não gera ligação.
 *
 * ── A pergunta que a tela responde ─────────────────────────────────────────
 * "Vagou um horário na terça à tarde — para quem eu ligo?" Por isso a fila é por
 * **chegada** e o turno aparece grande: são os dois campos que decidem a ligação.
 *
 * ── O que ela NÃO faz ──────────────────────────────────────────────────────
 * Não agenda. Marcar o horário é na agenda, com a EXCLUDE constraint e as regras que
 * ela já tem; um segundo caminho para gravar agendamento seria o caminho que esquece
 * uma trava. Aqui a recepção marca a linha como atendida **depois** de agendar, e a
 * mensagem de sucesso diz isso em voz alta.
 */
export default async function Page() {
  const ator = await exigirPermissaoPagina('relacionamento', 'ler')
  const podeTrabalhar = pode(ator.perfil, 'relacionamento', 'editar')

  const fila = await filaDeEspera()

  const linhas: LinhaNaTela[] = fila.map((l) => ({
    id: l.id,
    pacienteId: l.pacienteId,
    pacienteNome: l.pacienteNome,
    telefone: l.telefone,
    procedimentoNome: l.procedimentoNome,
    turnoRotulo: TURNO[l.turno] ?? l.turno,
    observacao: l.observacao,
    validoAteBr: dataBr(l.validoAte.toISOString().slice(0, 10)),
    pediuEmBr: dataHoraBr(l.criadoEm),
    vencida: l.vencida,
  }))

  const vencidas = linhas.filter((l) => l.vencida).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Lista de espera</h1>
        <p className="mt-1 text-sm text-fg-2">
          {linhas.length === 0
            ? 'Ninguém aguardando por um horário mais cedo.'
            : `${linhas.length} paciente(s) aguardando${vencidas > 0 ? `, ${vencidas} com prazo vencido` : ''}.`}{' '}
          Quem chegou primeiro aparece primeiro.
        </p>
      </div>

      <Card>
        <CardHeader
          titulo="Quem está esperando"
          descricao="O prazo é o que o próprio paciente aceitou esperar. Vencido continua na lista, marcado — sumir com a linha faria alguém ligar sem saber."
        />
        {linhas.length === 0 ? (
          <CardBody>
            <p className="text-sm text-fg-3">
              Os pedidos chegam pelo portal, em “Marcar consulta”. Se o autoatendimento estiver
              desligado nos ajustes, ninguém consegue entrar na fila.
            </p>
          </CardBody>
        ) : (
          <FilaDeEspera linhas={linhas} podeTrabalhar={podeTrabalhar} />
        )}
      </Card>

      {!podeTrabalhar && (
        <p className="text-xs text-fg-2">
          Seu perfil vê a fila e não a trabalha. Encerrar e marcar como atendido são da recepção e do
          financeiro.
        </p>
      )}
    </div>
  )
}
