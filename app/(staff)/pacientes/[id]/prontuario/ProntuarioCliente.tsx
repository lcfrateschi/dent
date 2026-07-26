'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import {
  assinarEvolucao,
  criarRascunho,
  descartarRascunho,
  editarRascunho,
  retificarEvolucao,
} from '@/lib/prontuario/acoes'
import type { EventoProntuario, EvolucaoNoProntuario, Prontuario } from '@/lib/prontuario/consultas'
import { cn } from '@/lib/ui/cn'
import { dataHoraBr } from '@/lib/ui/moeda'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

export interface AtendimentoPendente {
  readonly id: string
  readonly inicio: Date
  readonly profissionalNome: string
}

/**
 * Prontuário do paciente.
 *
 * Duas coisas que a tela precisa comunicar sem ambiguidade:
 *
 * 1. **Rascunho não é prontuário.** Fica visualmente separado e marcado como
 *    pendente de assinatura. Enquanto não assinado, não vale como registro.
 * 2. **Retificação não apaga.** A original continua visível, marcada como
 *    retificada, com a correção logo abaixo e o motivo à vista. Esconder a
 *    original seria justamente o que a norma do CFO proíbe.
 */
export function ProntuarioCliente({
  pacienteId,
  pacienteNome,
  prontuario,
  rascunho,
  atendimentosPendentes,
  podeEscrever,
  profissionalId,
}: {
  pacienteId: string
  pacienteNome: string
  prontuario: Prontuario
  rascunho: { id: string; texto: string; criadoEm: Date } | null
  atendimentosPendentes: readonly AtendimentoPendente[]
  podeEscrever: boolean
  profissionalId: string | null
}) {
  const router = useRouter()
  const [texto, setTexto] = useState(rascunho?.texto ?? '')
  const [agendamentoId, setAgendamentoId] = useState('')
  const [retificando, setRetificando] = useState<EvolucaoNoProntuario | null>(null)
  const [textoRetificacao, setTextoRetificacao] = useState('')
  const [motivo, setMotivo] = useState('')
  const [msg, setMsg] = useState<{ tipo: 'erro' | 'ok'; texto: string } | null>(null)
  const [pendente, iniciar] = useTransition()

  function agir(acao: () => Promise<{ ok: boolean; mensagem?: string }>, sucesso?: string): void {
    setMsg(null)
    iniciar(async () => {
      const r = await acao()
      if (!r.ok) {
        setMsg({ tipo: 'erro', texto: r.mensagem ?? 'Não foi possível concluir.' })
        return
      }
      if (sucesso ?? r.mensagem) setMsg({ tipo: 'ok', texto: sucesso ?? r.mensagem! })
      router.refresh()
    })
  }

  function salvarRascunho(): void {
    if (rascunho) {
      agir(() => editarRascunho(rascunho.id, texto), 'Rascunho salvo.')
    } else {
      agir(
        () => criarRascunho({ pacienteId, texto, agendamentoId: agendamentoId || undefined }),
        'Rascunho criado. Revise e assine para valer como prontuário.',
      )
    }
  }

  function assinar(): void {
    if (!rascunho) return
    if (
      !window.confirm(
        'Assinar esta evolução?\n\nDepois de assinada ela é IMUTÁVEL — nem você nem um administrador podem editá-la. Correções exigem registrar uma retificação, e a versão original continua visível no prontuário.',
      )
    ) {
      return
    }
    agir(() => assinarEvolucao(rascunho.id))
  }

  function confirmarRetificacao(): void {
    if (!retificando) return
    agir(() =>
      retificarEvolucao({ alvoId: retificando.id, texto: textoRetificacao, motivo }).then((r) => {
        if (r.ok) {
          setRetificando(null)
          setTextoRetificacao('')
          setMotivo('')
        }
        return r
      }),
    )
  }

  return (
    <div className="space-y-4">
      {msg ? (
        <Alerta tipo={msg.tipo === 'erro' ? 'critico' : 'sucesso'}>{msg.texto}</Alerta>
      ) : null}

      {/* Assinatura que não confere = alguém mexeu no banco por fora. */}
      {prontuario.assinaturasInvalidas > 0 ? (
        <div
          role="alert"
          className="rounded-(--radius-cartao) border-2 border-critico bg-critico/10 px-4 py-3"
        >
          <h2 className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-critico uppercase">
            <Icone nome="alerta" tamanho={14} />
            Integridade comprometida
          </h2>
          <p className="mt-1 text-sm text-fg-2">
            {prontuario.assinaturasInvalidas} evolução(ões) assinada(s) com hash inconsistente. Isso
            indica alteração feita fora do sistema. Registre o incidente e acione o responsável
            técnico — <strong>não</strong> tente corrigir editando o banco.
          </p>
        </div>
      ) : null}

      {podeEscrever ? (
        <Card>
          <CardHeader
            titulo={rascunho ? 'Rascunho em aberto' : 'Nova evolução'}
            descricao={
              rascunho
                ? `Criado em ${dataHoraBr(rascunho.criadoEm)} — ainda não vale como prontuário.`
                : 'O registro só vale como prontuário depois de assinado.'
            }
            acoes={
              rascunho ? (
                <Button
                  tamanho="sm"
                  variante="fantasma"
                  disabled={pendente}
                  onClick={() => {
                    if (window.confirm('Descartar este rascunho?')) {
                      agir(() => descartarRascunho(rascunho.id), 'Rascunho descartado.')
                      setTexto('')
                    }
                  }}
                >
                  Descartar
                </Button>
              ) : null
            }
          />
          <CardBody className="space-y-3">
            {!rascunho && atendimentosPendentes.length > 0 ? (
              <div>
                <label htmlFor="ag" className="mb-1 block text-sm font-medium text-fg-2">
                  Vincular ao atendimento
                </label>
                <select
                  id="ag"
                  value={agendamentoId}
                  onChange={(e) => setAgendamentoId(e.currentTarget.value)}
                  className="h-10 w-full max-w-md rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
                >
                  <option value="">— não vincular —</option>
                  {atendimentosPendentes.map((a) => (
                    <option key={a.id} value={a.id}>
                      {dataHoraBr(a.inicio)} · {a.profissionalNome}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-fg-3">
                  Atendimentos concluídos ainda sem evolução registrada.
                </p>
              </div>
            ) : null}

            <textarea
              value={texto}
              onChange={(e) => setTexto(e.currentTarget.value)}
              placeholder="Descreva o que foi feito, o que foi observado e a conduta."
              className="min-h-40 w-full rounded-(--radius-controle) border border-border bg-surface px-3 py-2 text-sm text-fg"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={pendente || texto.trim().length === 0} onClick={salvarRascunho}>
                {pendente ? 'Salvando…' : rascunho ? 'Salvar rascunho' : 'Criar rascunho'}
              </Button>
              {rascunho ? (
                <Button variante="primario" disabled={pendente} onClick={assinar}>
                  Assinar evolução
                </Button>
              ) : null}
              <span className="text-xs text-fg-3">
                {texto.trim().length} caracteres
              </span>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {retificando ? (
        <Card>
          <CardHeader
            titulo="Retificar evolução"
            descricao="A original continua no prontuário, marcada como retificada. Isso é exigência do CFO."
            acoes={
              <Button
                tamanho="sm"
                variante="fantasma"
                onClick={() => {
                  setRetificando(null)
                  setTextoRetificacao('')
                  setMotivo('')
                }}
              >
                Cancelar
              </Button>
            }
          />
          <CardBody className="space-y-3">
            <blockquote className="border-l-2 border-border bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap text-fg-3">
              {retificando.texto}
            </blockquote>
            <div>
              <label htmlFor="motivo" className="mb-1 block text-sm font-medium text-fg-2">
                Motivo da retificação <span className="text-critico">*</span>
              </label>
              <input
                id="motivo"
                value={motivo}
                onChange={(e) => setMotivo(e.currentTarget.value)}
                placeholder="Ex.: dente registrado incorretamente"
                className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
              />
            </div>
            <div>
              <label htmlFor="txtret" className="mb-1 block text-sm font-medium text-fg-2">
                Texto corrigido <span className="text-critico">*</span>
              </label>
              <textarea
                id="txtret"
                value={textoRetificacao}
                onChange={(e) => setTextoRetificacao(e.currentTarget.value)}
                className="min-h-32 w-full rounded-(--radius-controle) border border-border bg-surface px-3 py-2 text-sm text-fg"
              />
            </div>
            <Button
              variante="primario"
              disabled={pendente || motivo.trim().length < 3 || textoRetificacao.trim().length === 0}
              onClick={confirmarRetificacao}
            >
              {pendente ? 'Registrando…' : 'Registrar retificação (já assinada)'}
            </Button>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo="Linha do tempo"
          descricao={`${prontuario.eventos.length} evento(s) · ${prontuario.totalAssinadas} evolução(ões) assinada(s)${prontuario.totalRascunhos > 0 ? ` · ${prontuario.totalRascunhos} rascunho(s)` : ''}`}
        />
        <CardBody>
          {prontuario.eventos.length === 0 ? (
            <p className="text-sm text-fg-3">
              Nada registrado ainda para {pacienteNome}.
            </p>
          ) : (
            <ol className="space-y-3">
              {prontuario.eventos.map((ev, i) => (
                <li key={chaveEvento(ev, i)}>
                  <Evento
                    evento={ev}
                    podeRetificar={podeEscrever}
                    souOAutor={
                      ev.tipo === 'evolucao' && ev.evolucao.profissionalId === profissionalId
                    }
                    onRetificar={(e) => {
                      setRetificando(e)
                      setTextoRetificacao(e.texto)
                      setMsg(null)
                    }}
                  />
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function chaveEvento(ev: EventoProntuario, i: number): string {
  return ev.tipo === 'evolucao' ? `ev-${ev.evolucao.id}` : `${ev.tipo}-${ev.id}-${i}`
}

const ROTULO_TIPO: Record<EventoProntuario['tipo'], string> = {
  anamnese: 'Anamnese',
  evolucao: 'Evolução',
  execucao: 'Procedimento executado',
  falta: 'Falta',
  documento: 'Documento',
}

function Evento({
  evento,
  podeRetificar,
  souOAutor,
  onRetificar,
}: {
  evento: EventoProntuario
  podeRetificar: boolean
  souOAutor: boolean
  onRetificar: (e: EvolucaoNoProntuario) => void
}) {
  const cor = {
    anamnese: 'border-l-fg-3',
    evolucao: 'border-l-primary',
    execucao: 'border-l-executado',
    falta: 'border-l-critico',
    documento: 'border-l-atencao',
  }[evento.tipo]

  if (evento.tipo !== 'evolucao') {
    return (
      <div className={cn('border-l-2 pl-3', cor)}>
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-fg-3">
          <span className="font-semibold tracking-wide uppercase">{ROTULO_TIPO[evento.tipo]}</span>
          <span>{dataHoraBr(evento.quando)}</span>
        </div>
        <p className="text-sm text-fg-2">
          {evento.tipo === 'anamnese' ? (
            <>
              Versão {evento.versao}
              {evento.profissionalNome ? ` · ${evento.profissionalNome}` : ''}
            </>
          ) : evento.tipo === 'execucao' ? (
            <>
              <strong className="text-fg">{evento.procedimentoNome}</strong> · {evento.alvo} ·{' '}
              {evento.profissionalNome}
            </>
          ) : evento.tipo === 'falta' ? (
            <>
              Paciente não compareceu · {evento.profissionalNome}
            </>
          ) : (
            <>
              {evento.nomeArquivo} ({evento.tipoDocumento})
            </>
          )}
        </p>
      </div>
    )
  }

  const e = evento.evolucao
  const rascunho = e.assinadoEm === null

  return (
    <div
      className={cn(
        'border-l-2 pl-3',
        rascunho ? 'border-l-atencao' : cor,
        e.retificadaPorId ? 'opacity-75' : '',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-semibold tracking-wide text-fg-3 uppercase">
          {e.retificaId ? 'Retificação' : 'Evolução'}
        </span>
        <span className="text-fg-3">{dataHoraBr(e.assinadoEm ?? e.criadoEm)}</span>
        <span className="text-fg-3">
          {e.profissionalNome} · CRO {e.cro}-{e.ufCro}
        </span>

        {rascunho ? (
          <span className="rounded-full border border-atencao/45 bg-atencao/12 px-2 py-0.5 font-medium text-atencao">
            rascunho — não assinado
          </span>
        ) : e.assinaturaValida ? (
          <span className="flex items-center gap-1 text-sucesso">
            <Icone nome="confirmado" tamanho={12} />
            assinada
          </span>
        ) : (
          <span className="flex items-center gap-1 font-semibold text-critico">
            <Icone nome="alerta" tamanho={12} />
            assinatura NÃO confere
          </span>
        )}

        {e.retificadaPorId ? (
          <span className="rounded-full border border-border bg-surface-3 px-2 py-0.5 text-fg-3">
            retificada
          </span>
        ) : null}
      </div>

      {e.motivoRetificacao ? (
        <p className="mt-0.5 text-xs text-fg-3">
          Motivo: <em>{e.motivoRetificacao}</em>
        </p>
      ) : null}

      <p
        className={cn(
          'mt-1 text-sm whitespace-pre-wrap',
          e.retificadaPorId ? 'text-fg-3 line-through decoration-fg-3/40' : 'text-fg',
        )}
      >
        {e.texto}
      </p>

      {/* Só o autor retifica, e só o que está assinado e ainda não retificado. */}
      {podeRetificar && souOAutor && !rascunho && !e.retificadaPorId ? (
        <button
          type="button"
          onClick={() => onRetificar(e)}
          className="mt-1 text-xs text-primary underline underline-offset-2"
        >
          Retificar
        </button>
      ) : null}
    </div>
  )
}
