import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { Icone } from '@/components/ui/Icone'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { addDias } from '@/lib/domain/datas'
import { formatarTelefone } from '@/lib/domain/cpf'
import { diaLocalIso, inicioDoDia } from '@/lib/domain/fuso'
import { REGRA_PADRAO } from '@/lib/domain/lembrete'
import { formatarE164 } from '@/lib/domain/whatsapp'
import {
  agendaComLembrete,
  filaDeEnvio,
  mensagensComProblema,
  painelWhatsapp,
  respostasParaHumano,
  respostasRecentes,
} from '@/lib/mensageria/consultas'
import { cn } from '@/lib/ui/cn'
import type { Metadata } from 'next'
import Link from 'next/link'
import { BotaoDespachar, BotaoEnviarLembrete, ResolverResposta } from './Controles'

export const metadata: Metadata = { title: 'WhatsApp' }

/**
 * Tela de WhatsApp.
 *
 * A ordem das seções é a ordem da urgência, não a do modelo de dados: primeiro o
 * que tem gente esperando (resposta não entendida), depois o que está quebrado
 * (travada, falha), e só então a fila e o histórico.
 *
 * O aviso de provedor simulado fica no topo e é impossível de não ver. A pior
 * falha desta fase não é uma mensagem que não sai — é a clínica **achar** que
 * está avisando os pacientes quando está tudo indo para um simulador.
 */
export default async function Page() {
  const ator = await exigirPermissaoPagina('mensageria', 'ler')
  const podeOperar = pode(ator.perfil, 'mensageria', 'criar')
  const podeResolver = pode(ator.perfil, 'mensageria', 'editar') && pode(ator.perfil, 'agenda', 'editar')

  const agora = new Date()
  const fuso = REGRA_PADRAO.fuso
  const hoje = diaLocalIso(agora, fuso)

  const [painel, paraHumano, problemas, fila, recentes, agenda] = await Promise.all([
    painelWhatsapp(ator, agora),
    respostasParaHumano(),
    mensagensComProblema(agora),
    filaDeEnvio(),
    respostasRecentes(20),
    agendaComLembrete(inicioDoDia(hoje, fuso), inicioDoDia(addDias(hoje, 3), fuso)),
  ])

  const semConfirmar = agenda.filter((a) => a.status === 'agendado')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
            <Icone nome="whatsapp" tamanho={18} />
            WhatsApp
          </h1>
          <p className="text-sm text-fg-3">
            Lembretes de consulta e respostas dos pacientes
          </p>
        </div>
        {podeOperar ? <BotaoDespachar /> : null}
      </div>

      {painel.provedor === 'simulado' ? (
        <Alerta tipo="atencao">
          <strong>Provedor simulado.</strong> Nenhuma mensagem está saindo de verdade — o fluxo
          inteiro funciona, mas o destino é um simulador. Para enviar de fato, configure{' '}
          <code className="font-mono">WHATSAPP_PROVEDOR=meta</code> com as credenciais da conta
          WhatsApp Business (ver README).
        </Alerta>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Numero
          rotulo="Aguardando humano"
          valor={painel.naoEntendidas}
          apoio="Respostas não interpretadas"
          tom={painel.naoEntendidas > 0 ? 'critico' : 'neutro'}
        />
        <Numero
          rotulo="Travadas"
          valor={painel.travadas}
          apoio="Em envio há mais de 15 min"
          tom={painel.travadas > 0 ? 'critico' : 'neutro'}
        />
        <Numero
          rotulo="Falhas"
          valor={painel.falhadas}
          apoio="Não foram entregues"
          tom={painel.falhadas > 0 ? 'atencao' : 'neutro'}
        />
        <Numero rotulo="Na fila" valor={painel.pendentes} apoio="Ainda vão sair" />
        <Numero
          rotulo="Enviadas em 24h"
          valor={painel.enviadasHoje}
          apoio="Últimas 24 horas"
          tom="sucesso"
        />
      </div>

      {/* 1. Gente esperando. */}
      <Card>
        <CardHeader
          titulo="Respostas que a máquina não entendeu"
          descricao={
            paraHumano.length === 0
              ? 'Nada esperando. Toda resposta recebida foi interpretada ou já foi tratada.'
              : 'O paciente escreveu algo que não é um sim nem um não claro. Nada foi alterado na agenda.'
          }
        />
        <CardBody className="p-0">
          {paraHumano.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Fila vazia.</p>
          ) : (
            <ul className="divide-y divide-border">
              {paraHumano.map((r) => (
                <li key={r.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                    {r.pacienteId ? (
                      <Link
                        href={`/pacientes/${r.pacienteId}`}
                        className="font-medium text-fg hover:text-primary hover:underline"
                      >
                        {r.pacienteNome}
                      </Link>
                    ) : (
                      <span className="font-medium text-fg-2">
                        Número não cadastrado · {formatarE164(r.remetente)}
                      </span>
                    )}
                    {r.agendamentoInicio ? (
                      <span className="text-xs text-fg-3">
                        consulta {r.agendamentoInicio.toLocaleString('pt-BR', { timeZone: fuso })}
                      </span>
                    ) : (
                      <span className="text-xs text-atencao">sem consulta vinculada</span>
                    )}
                    <span className="ml-auto text-xs text-fg-3">
                      {r.recebidoEm.toLocaleString('pt-BR', { timeZone: fuso })}
                    </span>
                  </div>

                  {/* O texto literal, sem interpretação nossa em cima. */}
                  <blockquote className="rounded-(--radius-controle) border-l-2 border-primary bg-surface-2 px-3 py-2 text-sm text-fg">
                    {r.texto}
                  </blockquote>

                  {podeResolver ? (
                    <ResolverResposta
                      respostaId={r.id}
                      temAgendamento={r.agendamentoId !== null}
                      statusAgendamento={r.agendamentoStatus}
                    />
                  ) : (
                    <p className="text-xs text-fg-3">
                      Somente a recepção resolve estas respostas.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* 2. O que está quebrado. */}
      {problemas.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Mensagens travadas ou com falha"
            descricao="Travada não é reenviada automaticamente de propósito: se a Meta recebeu antes de a conexão cair, reenviar mandaria duas. Confirme por telefone."
          />
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Paciente</th>
                    <th className="px-4 py-2 font-semibold">Destino</th>
                    <th className="px-4 py-2 font-semibold">Situação</th>
                    <th className="px-4 py-2 font-semibold">Tentativas</th>
                    <th className="px-4 py-2 font-semibold">O que aconteceu</th>
                  </tr>
                </thead>
                <tbody>
                  {problemas.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <Link
                          href={`/pacientes/${m.pacienteId}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {m.pacienteNome}
                        </Link>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-fg-2">
                        {formatarE164(m.destino)}
                      </td>
                      <td className="px-4 py-2">
                        <Situacao situacao={m.situacao} />
                      </td>
                      <td className="px-4 py-2 text-fg-2">{m.tentativas}</td>
                      <td className="px-4 py-2 text-fg-2">
                        {m.erroMensagem ?? 'Reivindicada para envio e nunca concluída.'}
                        {m.erroCodigo ? (
                          <span className="ml-1 font-mono text-xs text-fg-3">({m.erroCodigo})</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* 3. Quem ainda não confirmou — a pergunta das 18h. */}
      <Card>
        <CardHeader
          titulo="Próximos 3 dias sem confirmação"
          descricao={
            semConfirmar.length === 0
              ? 'Todos os atendimentos dos próximos dias estão confirmados.'
              : 'Ainda não responderam. A coluna do lembrete diz se a mensagem saiu.'
          }
        />
        <CardBody className="p-0">
          {semConfirmar.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Nada pendente de confirmação.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Quando</th>
                    <th className="px-4 py-2 font-semibold">Paciente</th>
                    <th className="px-4 py-2 font-semibold">Profissional</th>
                    <th className="px-4 py-2 font-semibold">Contato</th>
                    <th className="px-4 py-2 font-semibold">Lembrete</th>
                    {podeOperar ? <th className="px-4 py-2" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {semConfirmar.map((a) => (
                    <tr key={a.agendamentoId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 text-fg-2">
                        {a.inicio.toLocaleString('pt-BR', {
                          timeZone: fuso,
                          weekday: 'short',
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/pacientes/${a.pacienteId}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {a.pacienteNome}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-fg-2">{a.profissionalNome}</td>
                      <td className="px-4 py-2 text-fg-2">
                        {a.telefoneWhatsapp ?? a.telefone
                          ? formatarTelefone((a.telefoneWhatsapp ?? a.telefone)!)
                          : '—'}
                      </td>
                      <td className="px-4 py-2">
                        {a.mensagemSituacao ? (
                          <Situacao situacao={a.mensagemSituacao} />
                        ) : (
                          <span className="text-xs text-fg-3">não enfileirado</span>
                        )}
                        {a.mensagemErro ? (
                          <span className="ml-1 text-xs text-critico">{a.mensagemErro}</span>
                        ) : null}
                      </td>
                      {podeOperar ? (
                        <td className="px-4 py-2 text-right">
                          {a.mensagemSituacao ? null : (
                            <BotaoEnviarLembrete agendamentoId={a.agendamentoId} />
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 4. Contexto. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            titulo="Na fila"
            descricao="Horário já decidido: nunca de madrugada, nunca depois de a mensagem perder utilidade."
          />
          <CardBody className="p-0">
            {fila.length === 0 ? (
              <p className="px-4 py-6 text-sm text-fg-3">Fila vazia.</p>
            ) : (
              <ul className="divide-y divide-border">
                {fila.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                    <span className="text-fg-2">
                      {m.agendadoPara.toLocaleString('pt-BR', {
                        timeZone: fuso,
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <Link
                      href={`/pacientes/${m.pacienteId}`}
                      className="font-medium text-fg hover:text-primary hover:underline"
                    >
                      {m.pacienteNome}
                    </Link>
                    <span className="ml-auto font-mono text-xs text-fg-3">
                      {formatarE164(m.destino)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            titulo="Últimas respostas"
            descricao="O que os pacientes escreveram e o que o sistema fez."
          />
          <CardBody className="p-0">
            {recentes.length === 0 ? (
              <p className="px-4 py-6 text-sm text-fg-3">Nenhuma resposta ainda.</p>
            ) : (
              <ul className="divide-y divide-border">
                {recentes.map((r) => (
                  <li key={r.id} className="space-y-1 px-4 py-2.5 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Interpretacao valor={r.interpretacao} />
                      {r.pacienteId ? (
                        <Link
                          href={`/pacientes/${r.pacienteId}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {r.pacienteNome}
                        </Link>
                      ) : (
                        <span className="font-mono text-xs text-fg-3">
                          {formatarE164(r.remetente)}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-fg-3">
                        {r.recebidoEm.toLocaleString('pt-BR', { timeZone: fuso })}
                      </span>
                    </div>
                    <p className="text-fg-2">“{r.texto}”</p>
                    {r.acaoTomada ? (
                      <p className="text-xs text-fg-3">→ {r.acaoTomada}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <p className="text-xs text-fg-3">
        Este acesso foi registrado na trilha de auditoria. Mensagens e respostas não podem ser
        excluídas — são o registro do que foi dito ao paciente e do que ele pediu.
      </p>
    </div>
  )
}

function Numero({
  rotulo,
  valor,
  apoio,
  tom = 'neutro',
}: {
  rotulo: string
  valor: number
  apoio: string
  tom?: 'neutro' | 'sucesso' | 'atencao' | 'critico'
}) {
  const cor = {
    neutro: 'text-fg',
    sucesso: 'text-sucesso',
    atencao: 'text-atencao',
    critico: 'text-critico',
  }[tom]

  return (
    <div className="rounded-(--radius-cartao) border border-border bg-surface px-4 py-3">
      <span className="block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
        {rotulo}
      </span>
      <span className={cn('mt-0.5 block text-xl font-semibold', cor)}>{valor}</span>
      <span className="mt-0.5 block text-xs text-fg-3">{apoio}</span>
    </div>
  )
}

/**
 * Situação da mensagem, com dupla codificação: cor + marca textual.
 * Ninguém deve depender de distinguir verde de âmbar para saber se saiu.
 */
function Situacao({ situacao }: { situacao: string }) {
  const estilo: Record<string, { cor: string; marca: string; rotulo: string }> = {
    pendente: { cor: 'text-fg-2', marca: '◦', rotulo: 'na fila' },
    enviando: { cor: 'text-atencao', marca: '⟳', rotulo: 'enviando' },
    enviada: { cor: 'text-sucesso', marca: '✓', rotulo: 'enviada' },
    entregue: { cor: 'text-sucesso', marca: '✓✓', rotulo: 'entregue' },
    lida: { cor: 'text-sucesso', marca: '✓✓', rotulo: 'lida' },
    falhou: { cor: 'text-critico', marca: '✕', rotulo: 'falhou' },
    cancelada: { cor: 'text-fg-3', marca: '–', rotulo: 'cancelada' },
  }
  const e = estilo[situacao] ?? { cor: 'text-fg-2', marca: '?', rotulo: situacao }
  return (
    <span className={cn('text-xs font-medium', e.cor)}>
      <span aria-hidden>{e.marca}</span> {e.rotulo}
    </span>
  )
}

function Interpretacao({ valor }: { valor: string }) {
  const estilo: Record<string, { cor: string; marca: string; rotulo: string }> = {
    confirmou: { cor: 'text-sucesso', marca: '✓', rotulo: 'Confirmou' },
    cancelou: { cor: 'text-critico', marca: '✕', rotulo: 'Cancelou' },
    nao_entendido: { cor: 'text-atencao', marca: '?', rotulo: 'Não entendido' },
  }
  const e = estilo[valor] ?? { cor: 'text-fg-2', marca: '·', rotulo: valor }
  return (
    <span className={cn('text-xs font-semibold', e.cor)}>
      <span aria-hidden>{e.marca}</span> {e.rotulo}
    </span>
  )
}
