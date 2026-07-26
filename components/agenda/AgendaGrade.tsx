'use client'

import type { AgendamentoNaGrade, BloqueioNaGrade } from '@/lib/agenda/consultas'
import {
  type EstruturaGrade,
  agruparPorDia,
  empacotarFaixas,
  posicaoDoAgora,
} from '@/lib/agenda/grade'
import { minutosDoDia, minutosParaHhmm } from '@/lib/domain/fuso'
import { NOME_DIA_CURTO, descreverDia } from '@/lib/domain/horario'
import type { HorarioFuncionamento } from '@/lib/domain/horario'
import { cn } from '@/lib/ui/cn'
import { useMemo } from 'react'
import { ESTILO_STATUS } from './estilos'

export interface AgendaGradeProps {
  estrutura: EstruturaGrade
  horario: HorarioFuncionamento
  fuso: string
  agendamentos: readonly AgendamentoNaGrade[]
  bloqueios: readonly BloqueioNaGrade[]
  /** Filtro de coluna: quando definido, cada dia mostra só este profissional. */
  profissionalId?: string | undefined
  /** Instante de referência para a linha do "agora". Vem do servidor. */
  agora: Date
  onSelecionar?: (agendamento: AgendamentoNaGrade) => void
  onClicarVazio?: (diaIso: string, hora: string) => void
  /** Pixels por minuto. 0,9 mostra 10h de grade em ~540px. */
  escala?: number
}

const LARGURA_EIXO = 52

/**
 * Grade da agenda: colunas de dia, linhas de tempo.
 *
 * Toda a matemática de posição vem de `lib/agenda/grade.ts`, que é puro e
 * testado. Aqui só há pintura e eventos — mesma divisão do odontograma.
 */
export function AgendaGrade({
  estrutura,
  horario,
  fuso,
  agendamentos,
  bloqueios,
  profissionalId,
  agora,
  onSelecionar,
  onClicarVazio,
  escala = 0.9,
}: AgendaGradeProps) {
  const alturaPx = estrutura.alturaMin * escala

  const porDia = useMemo(
    () => agruparPorDia(profissionalId ? agendamentos.filter((a) => a.profissionalId === profissionalId) : agendamentos, fuso),
    [agendamentos, profissionalId, fuso],
  )

  const bloqueiosPorDia = useMemo(() => agruparPorDia(bloqueios, fuso), [bloqueios, fuso])

  return (
    <div className="overflow-x-auto">
      <div
        className="grid min-w-[720px]"
        style={{
          gridTemplateColumns: `${LARGURA_EIXO}px repeat(${estrutura.dias.length}, minmax(120px, 1fr))`,
        }}
      >
        {/* Cabeçalho */}
        <div className="sticky left-0 z-20 border-b border-border bg-surface" />
        {estrutura.dias.map((dia) => (
          <div
            key={dia.iso}
            className={cn(
              'border-b border-l border-border px-2 py-1.5 text-center',
              dia.ehHoje ? 'bg-primary/8' : 'bg-surface',
            )}
          >
            <div className="text-xs font-semibold tracking-wide text-fg-3 uppercase">
              {NOME_DIA_CURTO[dia.diaSemana]}
            </div>
            <div className={cn('text-sm font-semibold', dia.ehHoje ? 'text-primary' : 'text-fg')}>
              {dia.iso.slice(8)}/{dia.iso.slice(5, 7)}
            </div>
            <div className="text-[10px] text-fg-3">{descreverDia(horario, dia.diaSemana)}</div>
          </div>
        ))}

        {/* Eixo de horas */}
        <div
          className="sticky left-0 z-10 bg-surface"
          style={{ height: alturaPx }}
        >
          {estrutura.marcas.map((m) => (
            <div
              key={m}
              className="absolute -translate-y-1/2 pr-2 text-right text-[11px] text-fg-3"
              style={{ top: (m - estrutura.inicioMin) * escala, width: LARGURA_EIXO }}
            >
              {minutosParaHhmm(m)}
            </div>
          ))}
        </div>

        {/* Colunas de dia */}
        {estrutura.dias.map((dia) => {
          const doDia = porDia.get(dia.iso) ?? []
          const posicoes = empacotarFaixas(doDia, {
            inicioGradeMin: estrutura.inicioMin,
            fuso,
          })
          const porId = new Map(posicoes.map((p) => [p.id, p]))
          const linhaAgora = posicaoDoAgora({
            agora,
            diaIso: dia.iso,
            inicioMin: estrutura.inicioMin,
            fimMin: estrutura.fimMin,
            fuso,
          })

          return (
            <div
              key={dia.iso}
              className={cn(
                'relative border-l border-border',
                dia.aberto ? 'bg-surface' : 'bg-surface-2',
              )}
              style={{ height: alturaPx }}
            >
              {/* Faixas fora do funcionamento: hachura de "não atende". */}
              {faixasIndisponiveis(horario, dia.diaSemana, estrutura).map((f, i) => (
                <div
                  key={`ind-${i}`}
                  aria-hidden
                  className="absolute inset-x-0 bg-surface-3/60"
                  style={{
                    top: (f.de - estrutura.inicioMin) * escala,
                    height: (f.ate - f.de) * escala,
                    backgroundImage:
                      'repeating-linear-gradient(135deg, var(--border) 0 1px, transparent 1px 6px)',
                  }}
                />
              ))}

              {/* Linhas de hora */}
              {estrutura.marcas.map((m) => (
                <div
                  key={m}
                  aria-hidden
                  className="absolute inset-x-0 border-t border-border/60"
                  style={{ top: (m - estrutura.inicioMin) * escala }}
                />
              ))}

              {/* Alvos de clique em vazio, no passo de meia hora */}
              {onClicarVazio && dia.aberto
                ? estrutura.marcas.flatMap((m) =>
                    [0, 30].map((offset) => {
                      const minuto = m + offset
                      if (minuto >= estrutura.fimMin) return null
                      return (
                        <button
                          key={`vazio-${minuto}`}
                          type="button"
                          onClick={() => onClicarVazio(dia.iso, minutosParaHhmm(minuto))}
                          title={`Agendar ${minutosParaHhmm(minuto)}`}
                          className="absolute inset-x-0 hover:bg-primary/8"
                          style={{
                            top: (minuto - estrutura.inicioMin) * escala,
                            height: 30 * escala,
                          }}
                        />
                      )
                    }),
                  )
                : null}

              {/* Bloqueios */}
              {(bloqueiosPorDia.get(dia.iso) ?? [])
                .filter(
                  (b) =>
                    !profissionalId ||
                    b.profissionalId === null ||
                    b.profissionalId === profissionalId,
                )
                .map((b) => {
                  const de = minutosDoDia(b.inicio, fuso)
                  const ate = minutosDoDia(b.fim, fuso)
                  return (
                    <div
                      key={b.id}
                      title={`Bloqueado: ${b.motivo}`}
                      className="absolute inset-x-0.5 z-10 overflow-hidden rounded border border-atencao/50 px-1 text-[10px] text-atencao"
                      style={{
                        top: Math.max(0, de - estrutura.inicioMin) * escala,
                        height: Math.max(14, (ate - de) * escala),
                        backgroundImage:
                          'repeating-linear-gradient(135deg, color-mix(in oklab, var(--atencao) 30%, transparent) 0 2px, transparent 2px 7px)',
                      }}
                    >
                      {b.motivo}
                    </div>
                  )
                })}

              {/* Cartões */}
              {doDia.map((a) => {
                const p = porId.get(a.id)
                if (!p) return null
                const estilo = ESTILO_STATUS[a.status]
                const largura = 100 / p.deFaixas

                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onSelecionar?.(a)}
                    aria-label={`${minutosParaHhmm(minutosDoDia(a.inicio, fuso))} ${a.pacienteNome}, ${estilo.rotulo}, ${a.profissionalNome}`}
                    className={cn(
                      'absolute z-20 overflow-hidden rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight',
                      'transition-shadow hover:z-30 hover:shadow-md',
                      estilo.cartao,
                    )}
                    style={{
                      top: p.topoMin * escala,
                      height: p.alturaMin * escala - 2,
                      left: `calc(${p.faixa * largura}% + 2px)`,
                      width: `calc(${largura}% - 4px)`,
                    }}
                  >
                    <span
                      aria-hidden
                      className={cn('absolute inset-y-0 left-0 w-1', estilo.barra)}
                    />
                    <span className={cn('block pl-1.5 font-semibold', estilo.texto)}>
                      {minutosParaHhmm(minutosDoDia(a.inicio, fuso))}{' '}
                      <span aria-hidden className="font-normal opacity-70">
                        {estilo.marca}
                      </span>
                    </span>
                    <span className={cn('block truncate pl-1.5', estilo.texto)}>
                      {a.pacienteNome}
                    </span>
                    {p.alturaMin * escala > 44 ? (
                      <span className="block truncate pl-1.5 text-fg-3">{a.profissionalNome}</span>
                    ) : null}
                  </button>
                )
              })}

              {/* Linha do agora */}
              {linhaAgora !== null ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 z-40 border-t-2 border-critico"
                  style={{ top: linhaAgora * escala }}
                >
                  <span className="absolute -top-1 -left-1 size-2 rounded-full bg-critico" />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Trechos da grade em que a clínica NÃO atende — almoço, antes de abrir, etc. */
function faixasIndisponiveis(
  horario: HorarioFuncionamento,
  diaSemana: number,
  estrutura: EstruturaGrade,
): readonly { de: number; ate: number }[] {
  const faixas = (horario[String(diaSemana)] ?? []).map((f) => ({
    de: Number(f.inicio.slice(0, 2)) * 60 + Number(f.inicio.slice(3, 5)),
    ate: Number(f.fim.slice(0, 2)) * 60 + Number(f.fim.slice(3, 5)),
  }))

  if (faixas.length === 0) return [{ de: estrutura.inicioMin, ate: estrutura.fimMin }]

  const indisponiveis: { de: number; ate: number }[] = []
  let cursor = estrutura.inicioMin

  for (const f of faixas) {
    if (f.de > cursor) indisponiveis.push({ de: cursor, ate: f.de })
    cursor = Math.max(cursor, f.ate)
  }
  if (cursor < estrutura.fimMin) indisponiveis.push({ de: cursor, ate: estrutura.fimMin })

  return indisponiveis
}
