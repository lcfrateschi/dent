'use client'

import type { Denticao, Face } from '@/lib/domain/dentes'
import { cn } from '@/lib/ui/cn'
import { type DenteLayout, layoutOdontograma, rotuloFace } from './geometria'
import {
  type EstadoDente,
  type EstadoFace,
  type MarcacoesDente,
  type MarcacoesFace,
  ROTULO_ESTADO_DENTE,
  ROTULO_ESTADO_FACE,
  type SelecaoFaces,
  aceitaMarcacaoDeFace,
} from './tipos'

export interface OdontogramaProps {
  denticao?: Denticao | 'mista'
  tamanho?: 'compacto' | 'confortavel'
  marcacoesFace?: MarcacoesFace
  marcacoesDente?: MarcacoesDente
  selecao?: SelecaoFaces
  onFaceClick?: (fdi: number, face: Face) => void
  onDenteClick?: (fdi: number) => void
  somenteLeitura?: boolean
  className?: string
}

/**
 * Odontograma: os 52 dentes com estado por face.
 *
 * Componente CONTROLADO e sem estado próprio — quem guarda marcação e seleção é
 * quem usa. Isso é de propósito: na Fase 5 o estado vem de `item_plano` e
 * `execucao`, e um componente com estado interno brigaria com o servidor.
 *
 * Toda a geometria vem de `geometria.ts` (puro e testado). Aqui só há pintura
 * e eventos.
 */
export function Odontograma({
  denticao = 'permanente',
  tamanho = 'compacto',
  marcacoesFace = {},
  marcacoesDente = {},
  selecao = {},
  onFaceClick,
  onDenteClick,
  somenteLeitura = false,
  className,
}: OdontogramaProps) {
  const layout = layoutOdontograma({ denticao, tamanho })
  const fonteRotulo = tamanho === 'compacto' ? 9.5 : 12
  const interativo = !somenteLeitura

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <svg
        viewBox={`-2 -2 ${layout.largura + 4} ${layout.altura + 4}`}
        className="h-auto w-full min-w-[640px] select-none"
        role="group"
        aria-label="Odontograma"
      >
        <defs>
          {/*
            Hachura do estado "planejado". É a metade não-cromática da dupla
            codificação: quem não distingue vermelho de azul ainda diferencia
            hachurado de sólido.
          */}
          <pattern
            id="odonto-hachura-planejado"
            patternUnits="userSpaceOnUse"
            width="4"
            height="4"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" fill="var(--planejado-fill)" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--planejado)" strokeWidth="1.4" />
          </pattern>
        </defs>

        {/* Eixo de simetria e linha entre as arcadas: referências de leitura. */}
        <line
          x1={layout.linhaMediaX}
          y1={0}
          x2={layout.linhaMediaX}
          y2={layout.altura}
          stroke="var(--border)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <line
          x1={0}
          y1={layout.linhaArcadasY}
          x2={layout.largura}
          y2={layout.linhaArcadasY}
          stroke="var(--border)"
          strokeWidth="1"
        />

        {layout.dentes.map((d) => (
          <DenteSvg
            key={d.fdi}
            layout={d}
            estadoDente={marcacoesDente[d.fdi]}
            estadosFace={marcacoesFace[d.fdi]}
            selecionadas={selecao[d.fdi]}
            fonteRotulo={fonteRotulo}
            interativo={interativo}
            onFaceClick={onFaceClick}
            onDenteClick={onDenteClick}
          />
        ))}
      </svg>
    </div>
  )
}

interface DenteSvgProps {
  layout: DenteLayout
  estadoDente: EstadoDente | undefined
  estadosFace: Partial<Record<Face, EstadoFace>> | undefined
  selecionadas: readonly Face[] | undefined
  fonteRotulo: number
  interativo: boolean
  onFaceClick?: (fdi: number, face: Face) => void
  onDenteClick?: (fdi: number) => void
}

function DenteSvg({
  layout,
  estadoDente = 'presente',
  estadosFace = {},
  selecionadas = [],
  fonteRotulo,
  interativo,
  onFaceClick,
  onDenteClick,
}: DenteSvgProps) {
  const { fdi, x, y, lado, centro, rotulo, dente } = layout
  const mostraFaces = aceitaMarcacaoDeFace(estadoDente)
  const opacidadeFaces = mostraFaces ? 1 : 0.3

  const marcadas = Object.entries(estadosFace)
    .filter(([, e]) => e && e !== 'higido')
    .map(([f, e]) => `${rotuloFace(f as Face)} ${ROTULO_ESTADO_FACE[e as EstadoFace]}`)

  const descricao = [
    `Dente ${fdi}, ${dente.nome}`,
    estadoDente !== 'presente' ? ROTULO_ESTADO_DENTE[estadoDente] : null,
    marcadas.length > 0 ? marcadas.join('; ') : null,
    selecionadas.length > 0
      ? `selecionado: ${selecionadas.map(rotuloFace).join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('. ')

  return (
    <g
      data-fdi={fdi}
      // O dente é o alvo de teclado; as faces são alvo de ponteiro.
      // Navegar 312 faces por Tab seria inutilizável.
      tabIndex={interativo ? 0 : -1}
      role={interativo ? 'button' : 'img'}
      aria-label={descricao}
      className={cn('outline-none', interativo && 'cursor-pointer')}
      onKeyDown={
        interativo && onDenteClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onDenteClick(fdi)
              }
            }
          : undefined
      }
    >
      {/* Fundo do dente: dá área de foco e evita buraco entre os trapézios. */}
      <rect
        x={x}
        y={y}
        width={lado}
        height={lado}
        fill="var(--dente-higido)"
        stroke="var(--dente-borda)"
        strokeWidth="0.8"
      />

      <g opacity={opacidadeFaces}>
        {layout.regioes.map((r) => {
          const estado = estadosFace[r.face] ?? 'higido'
          const selecionada = selecionadas.includes(r.face)
          return (
            <path
              key={r.posicao}
              d={r.path}
              fillRule={r.posicao === 'cervical' ? 'evenodd' : undefined}
              fill={preenchimentoFace(estado)}
              stroke={selecionada ? 'var(--selecionado)' : 'var(--dente-borda)'}
              strokeWidth={selecionada ? 1.8 : 0.6}
              className={cn(
                'odonto-face',
                interativo && mostraFaces && 'cursor-pointer',
                !mostraFaces && 'pointer-events-none',
              )}
              onClick={
                interativo && mostraFaces && onFaceClick
                  ? (e) => {
                      e.stopPropagation()
                      onFaceClick(fdi, r.face)
                    }
                  : undefined
              }
            >
              <title>{`Dente ${fdi} — ${rotuloFace(r.face)}${
                estado !== 'higido' ? ` (${ROTULO_ESTADO_FACE[estado]})` : ''
              }`}</title>
            </path>
          )
        })}
      </g>

      {estadoDente === 'coroa' && (
        <rect
          x={x - 1.5}
          y={y - 1.5}
          width={lado + 3}
          height={lado + 3}
          fill="none"
          stroke="var(--coroa)"
          strokeWidth="2.2"
          rx="2"
          pointerEvents="none"
        />
      )}

      {estadoDente === 'ausente' && (
        <g stroke="var(--ausente)" strokeWidth="2.4" strokeLinecap="round" pointerEvents="none">
          <line x1={x + 4} y1={y + 4} x2={x + lado - 4} y2={y + lado - 4} />
          <line x1={x + lado - 4} y1={y + 4} x2={x + 4} y2={y + lado - 4} />
        </g>
      )}

      {estadoDente === 'raiz_residual' && (
        // Meia-lua na base: a coroa se foi, a raiz ficou.
        <path
          d={`M${x + 6} ${y + lado - 8} Q${centro.x} ${y + lado - 22} ${x + lado - 6} ${y + lado - 8}`}
          fill="none"
          stroke="var(--ausente)"
          strokeWidth="2.2"
          strokeLinecap="round"
          pointerEvents="none"
        />
      )}

      {estadoDente === 'implante' && (
        <g stroke="var(--implante)" strokeWidth="2" strokeLinecap="round" pointerEvents="none">
          {/* Glifo de rosca: lê como implante sem precisar de legenda de cor. */}
          <line x1={centro.x} y1={y + 5} x2={centro.x} y2={y + lado - 5} />
          {[0.3, 0.45, 0.6, 0.75].map((t) => (
            <line
              key={t}
              x1={centro.x - lado * 0.18}
              y1={y + lado * t}
              x2={centro.x + lado * 0.18}
              y2={y + lado * t}
            />
          ))}
        </g>
      )}

      <text
        x={rotulo.x}
        y={rotulo.y}
        textAnchor="middle"
        fontSize={fonteRotulo}
        fill="var(--fg-2)"
        fontWeight={600}
        pointerEvents="none"
      >
        {fdi}
      </text>
    </g>
  )
}

/** Fill por estado. Planejado é hachurado, executado é sólido — dupla codificação. */
function preenchimentoFace(estado: EstadoFace): string {
  switch (estado) {
    case 'planejado':
      return 'url(#odonto-hachura-planejado)'
    case 'executado':
      return 'var(--executado-fill)'
    default:
      return 'var(--dente-higido)'
  }
}
