'use client'

import { AgendaGrade } from '@/components/agenda/AgendaGrade'
import { ESTILO_STATUS, PROXIMOS_STATUS, ROTULO_ORIGEM } from '@/components/agenda/estilos'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { mudarStatus, registrarChegada } from '@/lib/agenda/acoes'
import type { AgendamentoNaGrade, DadosAgenda } from '@/lib/agenda/consultas'
import type { EstruturaGrade } from '@/lib/agenda/grade'
import type { StatusAgendamento } from '@/lib/domain/agendamento'
import { horaLocal } from '@/lib/domain/fuso'
import { cn } from '@/lib/ui/cn'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Icone } from '@/components/ui/Icone'

export interface AgendaClienteProps {
  dados: DadosAgenda
  estrutura: EstruturaGrade
  agoraIso: string
  visao: 'semana' | 'dia'
  refIso: string
  profissionalId: string | null
  podeEditar: boolean
  podeCriar: boolean
  navegacao: { anterior: string; proximo: string; hoje: string }
}

export function AgendaCliente({
  dados,
  estrutura,
  agoraIso,
  visao,
  refIso,
  profissionalId,
  podeEditar,
  podeCriar,
  navegacao,
}: AgendaClienteProps) {
  const router = useRouter()
  const [selecionado, setSelecionado] = useState<AgendamentoNaGrade | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  const agora = new Date(agoraIso)
  const fuso = dados.config.fuso

  function aplicar(acao: () => Promise<{ ok: boolean; mensagem?: string }>): void {
    setErro(null)
    iniciar(async () => {
      const r = await acao()
      if (!r.ok) {
        setErro(r.mensagem ?? 'Não foi possível concluir.')
        return
      }
      setSelecionado(null)
      router.refresh()
    })
  }

  function mudar(para: StatusAgendamento): void {
    if (!selecionado) return
    // O CHECK do banco exige motivo no cancelamento; pedimos antes de tentar.
    let motivo: string | undefined
    if (para === 'cancelado') {
      const informado = window.prompt('Motivo do cancelamento:')
      if (informado === null) return
      if (informado.trim().length < 3) {
        setErro('Informe o motivo do cancelamento.')
        return
      }
      motivo = informado.trim()
    }
    aplicar(() => mudarStatus(selecionado.id, para, motivo))
  }

  const urlBase = (params: Record<string, string | undefined>): string => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v)
    return `/agenda?${q.toString()}`
  }

  return (
    <div className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Agenda</h1>
          <p className="text-sm text-fg-3">
            {visao === 'semana' ? 'Semana de' : ''} {formatarBr(estrutura.dias[0]?.iso ?? refIso)}
            {visao === 'semana' && estrutura.dias.length > 1
              ? ` a ${formatarBr(estrutura.dias[estrutura.dias.length - 1]!.iso)}`
              : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-1">
            {/* Os dois únicos icon-only do sistema: seta de período é
                universal e ambos carregam aria-label. */}
            <Link href={navegacao.anterior}>
              <Button tamanho="sm" aria-label="Período anterior">
                <Icone nome="anterior" />
              </Button>
            </Link>
            <Link href={navegacao.hoje}>
              <Button tamanho="sm">Hoje</Button>
            </Link>
            <Link href={navegacao.proximo}>
              <Button tamanho="sm" aria-label="Próximo período">
                <Icone nome="proximo" />
              </Button>
            </Link>
          </div>

          <div className="flex gap-1">
            {(['semana', 'dia'] as const).map((v) => (
              <Link key={v} href={urlBase({ visao: v, ref: refIso, prof: profissionalId ?? undefined })}>
                <Button tamanho="sm" ativo={visao === v}>
                  {v === 'semana' ? 'Semana' : 'Dia'}
                </Button>
              </Link>
            ))}
          </div>

          <form method="get" className="flex items-end gap-2">
            <input type="hidden" name="visao" value={visao} />
            <input type="hidden" name="ref" value={refIso} />
            <div>
              <label htmlFor="prof" className="mb-1 block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
                Profissional
              </label>
              <select
                id="prof"
                name="prof"
                defaultValue={profissionalId ?? ''}
                className="h-9 rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg"
              >
                <option value="">Todos</option>
                {dados.profissionais.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" tamanho="sm">
              Filtrar
            </Button>
          </form>

          {podeCriar ? (
            <Link href={`/agenda/novo?dia=${refIso}`}>
              <Button variante="primario">Novo agendamento</Button>
            </Link>
          ) : null}
        </div>
      </div>

      <Card className="overflow-hidden">
        <AgendaGrade
          estrutura={estrutura}
          horario={dados.config.horario}
          fuso={fuso}
          agendamentos={dados.agendamentos}
          bloqueios={dados.bloqueios}
          profissionalId={profissionalId ?? undefined}
          agora={agora}
          onSelecionar={setSelecionado}
          onClicarVazio={
            podeCriar
              ? (dia, hora) => router.push(`/agenda/novo?dia=${dia}&hora=${hora}${profissionalId ? `&prof=${profissionalId}` : ''}`)
              : undefined
          }
        />
      </Card>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
        {(Object.keys(ESTILO_STATUS) as StatusAgendamento[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className={cn('inline-block size-2.5 rounded-sm', ESTILO_STATUS[s].barra)} />
            <Icone nome={s} tamanho={13} />
            {ESTILO_STATUS[s].rotulo}
            <span aria-hidden className="opacity-60">
              {ESTILO_STATUS[s].marca}
            </span>
          </span>
        ))}
      </div>

      {selecionado ? (
        <Card>
          <CardHeader
            titulo={selecionado.pacienteNome}
            descricao={`${horaLocal(selecionado.inicio, fuso)}–${horaLocal(selecionado.fim, fuso)} · ${selecionado.profissionalNome}${selecionado.cadeiraNome ? ` · ${selecionado.cadeiraNome}` : ''}`}
            acoes={
              <Button tamanho="sm" variante="fantasma" onClick={() => setSelecionado(null)}>
                Fechar
              </Button>
            }
          />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-fg-2">
              <span>
                Status:{' '}
                <strong className="text-fg">{ESTILO_STATUS[selecionado.status].rotulo}</strong>
              </span>
              <span>Origem: {ROTULO_ORIGEM[selecionado.origem] ?? selecionado.origem}</span>
              {selecionado.confirmadoEm ? <span>Confirmado</span> : null}
              {selecionado.chegouEm ? (
                <span>Chegou às {horaLocal(selecionado.chegouEm, fuso)}</span>
              ) : null}
            </div>

            {selecionado.observacao ? (
              <p className="text-sm text-fg-2">{selecionado.observacao}</p>
            ) : null}

            {podeEditar ? (
              <div className="flex flex-wrap gap-2">
                {/* Chegada é distinta de confirmação — ver GLOSSARIO. */}
                {!selecionado.chegouEm &&
                !['concluido', 'faltou', 'cancelado'].includes(selecionado.status) ? (
                  <Button
                    tamanho="sm"
                    disabled={pendente}
                    onClick={() => aplicar(() => registrarChegada(selecionado.id))}
                  >
                    Registrar chegada
                  </Button>
                ) : null}

                {PROXIMOS_STATUS[selecionado.status].map((s) => (
                  <Button
                    key={s}
                    tamanho="sm"
                    disabled={pendente}
                    variante={s === 'cancelado' || s === 'faltou' ? 'fantasma' : 'secundario'}
                    onClick={() => mudar(s)}
                  >
                    {ESTILO_STATUS[s].rotulo}
                  </Button>
                ))}

                {!['concluido', 'faltou', 'cancelado'].includes(selecionado.status) ? (
                  <Link href={`/agenda/${selecionado.id}/reagendar`}>
                    <Button tamanho="sm">Reagendar</Button>
                  </Link>
                ) : null}

                <Link href={`/pacientes/${selecionado.pacienteId}`}>
                  <Button tamanho="sm" variante="fantasma">
                    Abrir ficha
                  </Button>
                </Link>
              </div>
            ) : (
              <p className="text-xs text-fg-3">Seu perfil pode consultar a agenda, sem alterá-la.</p>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}

function formatarBr(iso: string): string {
  const [ano, mes, dia] = iso.split('-')
  return `${dia}/${mes}/${ano}`
}
