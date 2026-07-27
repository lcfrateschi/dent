'use client'

import { Button } from '@/components/ui/Button'
import { gravarDente, type MedidaDoDente } from '@/lib/periodontal/acoes'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A grade de digitação do periograma.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  O PROBLEMA REAL NÃO É MOSTRAR 192 MEDIDAS — É DIGITÁ-LAS
 *
 *  Na clínica o exame é ditado: o dentista sonda e fala "16, três, dois, quatro,
 *  três, dois, três", e a auxiliar digita **sem olhar a tela**. Se a interface
 *  exigir mouse entre campos, o exame leva vinte minutos em vez de cinco, e um
 *  módulo clínico que custa quinze minutos por paciente não é usado — ele é
 *  contornado com uma anotação em papel que ninguém digita depois.
 *
 *  Daí as quatro decisões abaixo, todas com uma alternativa que foi descartada.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── 1. Avanço automático ao digitar, e por que ele é seguro aqui ────────────
 * Digitar um algarismo move o foco para o campo seguinte. Isso normalmente é uma
 * péssima ideia — quebra em número de dois dígitos — e aqui é seguro por uma razão
 * medida: **profundidade de sondagem vai de 0 a 15 mm, e valor de dois algarismos é
 * raro**. A saída para ele existe e não depende de configuração: digitar `1` avança,
 * e se a medida era 12, a tecla `2` no campo seguinte... estaria errada.
 *
 * Então o avanço é **condicional**: `0` a `9` avançam, exceto `1`, que **espera**.
 * Um `1` sozinho fica no campo aguardando o próximo toque: se vier algarismo, o
 * campo passa a `1x` e avança; se vier `Tab`, `Enter` ou uma pausa (o `blur`), o
 * valor é `1`. É a diferença entre uma grade que digita 1–9 rápido e uma que erra
 * todo `10`–`15`.
 *
 * A alternativa descartada: exigir `Enter` sempre. Custa um toque a cada medida —
 * 192 toques por exame — para resolver um caso que é minoria.
 *
 * ── 2. Gravação por DENTE, não por sítio nem no fim ─────────────────────────
 * Ver o comentário de `gravarDente` em `lib/periodontal/acoes.ts`. Aqui a
 * consequência de interface: ao sair do último campo de um dente, o dente é gravado
 * e o indicador muda. **Não existe botão "salvar tudo"** — se a página cair na medida
 * 150, os 149 anteriores estão no banco.
 *
 * ── 3. O foco é visível e o teclado é previsível ────────────────────────────
 * Quem não olha a tela precisa que `Tab`/`Enter` façam a mesma coisa (avançar) e que
 * `Shift+Tab` volte. Ao chegar ao fim de um dente, o avanço vai para o primeiro
 * campo do dente seguinte — não para os controles de mobilidade e furca, que são
 * ditados depois e alcançados de propósito.
 *
 * ── 4. Erro é corrigível, e não bloqueia ───────────────────────────────────
 * Valor fora da faixa fica **marcado** em vez de recusado no meio do ditado: parar a
 * digitação para reclamar de um `40` que era `4,0` interrompe o exame inteiro. A
 * trava real é do banco (CHECK de faixa), e o dente com valor inválido não grava —
 * a marcação diz onde voltar.
 *
 * ── O que isto NÃO resolve, e é honesto dizer ───────────────────────────────
 * Não há ditado por voz, não há pedal, e **ninguém digitou um exame de verdade
 * nesta grade**. O desenho vem de como o procedimento é feito, não de observação de
 * uso: a validação com uma auxiliar é o próximo passo, e é ela que dirá se o avanço
 * condicional ajuda ou irrita.
 */

export interface SitioNaTela {
  readonly sitio: string
  readonly rotulo: string
}

export interface DenteNaTela {
  readonly fdi: number
  readonly sitios: readonly SitioNaTela[]
  readonly temFurca: boolean
}

export interface MedidaGravada {
  readonly denteFdi: number
  readonly sitio: string
  readonly profundidadeMm: number
  readonly recessaoMm: number
  readonly sangramento: boolean
  readonly supuracao: boolean
}

interface Props {
  readonly periogramaId: string
  readonly dentes: readonly DenteNaTela[]
  readonly gravadas: readonly MedidaGravada[]
  readonly achados: readonly { denteFdi: number; mobilidade: number | null; furca: number | null }[]
  readonly somenteLeitura: boolean
}

/** Estado de um campo: o texto digitado, para não perder o `1` intermediário. */
type Campos = Record<string, string>
type Marcas = Record<string, boolean>

const PS_MAXIMA = 15
const RECESSAO_MINIMA = -10
const RECESSAO_MAXIMA = 20

const chave = (fdi: number, sitio: string, campo: 'ps' | 'rec') => `${fdi}:${sitio}:${campo}`

export function GradeDeSondagem({
  periogramaId,
  dentes,
  gravadas,
  achados,
  somenteLeitura,
}: Props) {
  const [campos, setCampos] = useState<Campos>(() => {
    const inicial: Campos = {}
    for (const g of gravadas) {
      inicial[chave(g.denteFdi, g.sitio, 'ps')] = String(g.profundidadeMm)
      inicial[chave(g.denteFdi, g.sitio, 'rec')] = String(g.recessaoMm)
    }
    return inicial
  })
  const [sangra, setSangra] = useState<Marcas>(() => {
    const m: Marcas = {}
    for (const g of gravadas) if (g.sangramento) m[`${g.denteFdi}:${g.sitio}`] = true
    return m
  })
  const [mobilidades, setMobilidades] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {}
    for (const a of achados) if (a.mobilidade !== null) m[a.denteFdi] = String(a.mobilidade)
    return m
  })
  const [furcas, setFurcas] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {}
    for (const a of achados) if (a.furca !== null) m[a.denteFdi] = String(a.furca)
    return m
  })

  const [salvos, setSalvos] = useState<Record<number, 'salvando' | 'ok' | string>>(() => {
    const m: Record<number, 'ok'> = {}
    for (const g of gravadas) m[g.denteFdi] = 'ok'
    return m
  })

  /** Ordem linear de todos os campos, para o avanço saber quem é o próximo. */
  const ordem = useRef<string[]>([])
  useEffect(() => {
    const lista: string[] = []
    for (const d of dentes) for (const s of d.sitios) lista.push(chave(d.fdi, s.sitio, 'ps'))
    ordem.current = lista
  }, [dentes])

  const focar = useCallback((k: string) => {
    const el = document.querySelector<HTMLInputElement>(`[data-campo="${k}"]`)
    el?.focus()
    el?.select()
  }, [])

  const avancar = useCallback(
    (atual: string) => {
      const i = ordem.current.indexOf(atual)
      const proximo = ordem.current[i + 1]
      if (proximo) focar(proximo)
    },
    [focar],
  )

  const gravar = useCallback(
    async (fdi: number) => {
      if (somenteLeitura) return
      const dente = dentes.find((d) => d.fdi === fdi)
      if (!dente) return

      const medidas: MedidaDoDente[] = []
      for (const s of dente.sitios) {
        const ps = campos[chave(fdi, s.sitio, 'ps')]
        if (ps === undefined || ps === '') continue
        const rec = campos[chave(fdi, s.sitio, 'rec')] ?? '0'
        medidas.push({
          sitio: s.sitio as MedidaDoDente['sitio'],
          profundidadeMm: Number(ps),
          recessaoMm: Number(rec),
          sangramento: sangra[`${fdi}:${s.sitio}`] === true,
          supuracao: false,
        })
      }
      // Dente sem nenhuma medida não vai ao servidor: passar por um dente ausente é
      // normal num exame (o dente foi extraído), e gravar linha vazia inventaria
      // achado.
      if (medidas.length === 0) return

      setSalvos((s) => ({ ...s, [fdi]: 'salvando' }))
      const mob = mobilidades[fdi]
      const fur = furcas[fdi]
      const r = await gravarDente({
        periogramaId,
        denteFdi: fdi,
        mobilidade: mob === undefined || mob === '' ? null : Number(mob),
        furca: fur === undefined || fur === '' ? null : Number(fur),
        medidas,
      })
      setSalvos((s) => ({ ...s, [fdi]: r.ok ? 'ok' : r.mensagem }))
    },
    [campos, dentes, furcas, mobilidades, periogramaId, sangra, somenteLeitura],
  )

  /** Timer do `1` pendente: sem ele, `1` seguido de pausa nunca resolveria. */
  const pendente = useRef<ReturnType<typeof setTimeout> | null>(null)

  function onChangePs(k: string, fdi: number, valor: string) {
    const limpo = valor.replace(/[^0-9]/g, '').slice(0, 2)
    setCampos((c) => ({ ...c, [k]: limpo }))

    if (pendente.current) {
      clearTimeout(pendente.current)
      pendente.current = null
    }

    // Dois algarismos: não há ambiguidade, avança.
    if (limpo.length === 2) {
      avancar(k)
      return
    }
    // `1` espera: pode ser 1, 10, 11… 15. A pausa resolve.
    if (limpo === '1') {
      pendente.current = setTimeout(() => avancar(k), 900)
      return
    }
    if (limpo.length === 1) avancar(k)
  }

  const numeroInvalido = (v: string | undefined, min: number, max: number) => {
    if (v === undefined || v === '') return false
    const n = Number(v)
    return !Number.isFinite(n) || n < min || n > max
  }

  return (
    <div className="space-y-4">
      {!somenteLeitura && (
        <p className="text-xs text-fg-2">
          Digite a profundidade e o foco anda sozinho. <kbd className="rounded bg-surface-2 px-1">Tab</kbd>{' '}
          e <kbd className="rounded bg-surface-2 px-1">Enter</kbd> fazem o mesmo. Cada dente é gravado ao
          sair dele — não há botão de salvar no fim.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <caption className="sr-only">
            Grade de sondagem periodontal: seis sítios por dente, profundidade e recessão em
            milímetros.
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-fg-2">
              <th scope="col" className="py-2 pr-2 font-medium">
                Dente
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                Sítio
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                PS
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                Rec.
              </th>
              <th scope="col" className="py-2 pr-2 font-medium" title="Nível de inserção clínica">
                NIC
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                Sangra
              </th>
              <th scope="col" className="py-2 pr-2 font-medium">
                Mob. / Furca
              </th>
              <th scope="col" className="py-2 font-medium">
                Gravado
              </th>
            </tr>
          </thead>
          <tbody>
            {dentes.map((d) =>
              d.sitios.map((s, indice) => {
                const kPs = chave(d.fdi, s.sitio, 'ps')
                const kRec = chave(d.fdi, s.sitio, 'rec')
                const ps = campos[kPs] ?? ''
                const rec = campos[kRec] ?? ''
                // NIC mostrado, nunca digitado: no banco é coluna GENERATED e o
                // Postgres recusa escrita. Aqui é espelho do cálculo, e há invariante
                // provando que os dois concordam.
                const nic = ps === '' ? null : Number(ps) + (rec === '' ? 0 : Number(rec))
                const primeira = indice === 0
                const ultima = indice === d.sitios.length - 1
                const estado = salvos[d.fdi]

                return (
                  <tr
                    key={kPs}
                    className={`border-b border-border/50 ${primeira ? 'border-t-2 border-t-border' : ''}`}
                  >
                    {primeira && (
                      <th
                        scope="rowgroup"
                        rowSpan={d.sitios.length}
                        className="py-1 pr-2 align-top font-semibold text-fg"
                      >
                        {d.fdi}
                      </th>
                    )}
                    <td className="py-1 pr-2 text-xs text-fg-2">{s.rotulo}</td>
                    <td className="py-1 pr-2">
                      <input
                        data-campo={kPs}
                        data-teste={`ps-${d.fdi}-${s.sitio}`}
                        inputMode="numeric"
                        aria-label={`Profundidade do dente ${d.fdi}, ${s.rotulo}`}
                        value={ps}
                        disabled={somenteLeitura}
                        onChange={(e) => onChangePs(kPs, d.fdi, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            avancar(kPs)
                          }
                        }}
                        onBlur={() => {
                          if (pendente.current) {
                            clearTimeout(pendente.current)
                            pendente.current = null
                          }
                          if (ultima) void gravar(d.fdi)
                        }}
                        className={`w-12 rounded border px-1 py-0.5 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-primary ${
                          numeroInvalido(ps, 0, PS_MAXIMA)
                            ? 'border-critico bg-surface-2'
                            : 'border-border bg-surface'
                        }`}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        data-campo={kRec}
                        data-teste={`rec-${d.fdi}-${s.sitio}`}
                        inputMode="numeric"
                        aria-label={`Recessão do dente ${d.fdi}, ${s.rotulo}`}
                        value={rec}
                        disabled={somenteLeitura}
                        onChange={(e) =>
                          setCampos((c) => ({
                            ...c,
                            [kRec]: e.target.value.replace(/[^0-9-]/g, '').slice(0, 3),
                          }))
                        }
                        onBlur={() => {
                          if (ultima) void gravar(d.fdi)
                        }}
                        className={`w-12 rounded border px-1 py-0.5 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-primary ${
                          numeroInvalido(rec, RECESSAO_MINIMA, RECESSAO_MAXIMA)
                            ? 'border-critico bg-surface-2'
                            : 'border-border bg-surface'
                        }`}
                      />
                    </td>
                    {/*
                      `data-teste` e `data-valor` existem para a verificação por HTTP
                      poder afirmar ESTE número, e não "existe um 7 em algum lugar da
                      página". Num exame de 192 medidas, procurar um algarismo solto no
                      HTML é uma asserção que passa sempre.
                    */}
                    <td
                      data-teste={`nic-${d.fdi}-${s.sitio}`}
                      data-valor={nic === null ? '' : String(nic)}
                      className="py-1 pr-2 text-center tabular-nums text-fg-2"
                    >
                      {nic === null ? '—' : nic}
                    </td>
                    <td className="py-1 pr-2">
                      <input
                        type="checkbox"
                        aria-label={`Sangramento no dente ${d.fdi}, ${s.rotulo}`}
                        checked={sangra[`${d.fdi}:${s.sitio}`] === true}
                        disabled={somenteLeitura}
                        onChange={(e) =>
                          setSangra((m) => ({ ...m, [`${d.fdi}:${s.sitio}`]: e.target.checked }))
                        }
                        onBlur={() => {
                          if (ultima) void gravar(d.fdi)
                        }}
                      />
                    </td>
                    {primeira && (
                      <td rowSpan={d.sitios.length} className="py-1 pr-2 align-top">
                        <div className="flex flex-col gap-1">
                          <label className="flex items-center gap-1 text-xs text-fg-2">
                            Mob.
                            <select
                              aria-label={`Mobilidade do dente ${d.fdi}`}
                              value={mobilidades[d.fdi] ?? ''}
                              disabled={somenteLeitura}
                              onChange={(e) =>
                                setMobilidades((m) => ({ ...m, [d.fdi]: e.target.value }))
                              }
                              onBlur={() => void gravar(d.fdi)}
                              className="rounded border border-border bg-surface px-1 py-0.5"
                            >
                              <option value="">—</option>
                              <option value="0">0</option>
                              <option value="1">I</option>
                              <option value="2">II</option>
                              <option value="3">III</option>
                            </select>
                          </label>
                          {/*
                            Furca só aparece em dente multirradicular. O campo não
                            existir é a interface obedecendo ao modelo: o CHECK do
                            banco recusaria, e oferecer um campo que sempre falha é
                            convidar o erro.
                          */}
                          {d.temFurca ? (
                            <label className="flex items-center gap-1 text-xs text-fg-2">
                              Furca
                              <select
                                aria-label={`Furca do dente ${d.fdi}`}
                                value={furcas[d.fdi] ?? ''}
                                disabled={somenteLeitura}
                                onChange={(e) => setFurcas((m) => ({ ...m, [d.fdi]: e.target.value }))}
                                onBlur={() => void gravar(d.fdi)}
                                className="rounded border border-border bg-surface px-1 py-0.5"
                              >
                                <option value="">—</option>
                                <option value="0">0</option>
                                <option value="1">I</option>
                                <option value="2">II</option>
                                <option value="3">III</option>
                                <option value="4">IV</option>
                              </select>
                            </label>
                          ) : (
                            <span className="text-xs text-fg-3" title="Dente de raiz única não tem furca">
                              raiz única
                            </span>
                          )}
                        </div>
                      </td>
                    )}
                    {primeira && (
                      <td rowSpan={d.sitios.length} className="py-1 align-top text-xs">
                        {estado === undefined && <span className="text-fg-3">—</span>}
                        {estado === 'salvando' && <span className="text-fg-2">salvando…</span>}
                        {estado === 'ok' && <span className="text-sucesso">✓</span>}
                        {typeof estado === 'string' && estado !== 'ok' && estado !== 'salvando' && (
                          <span className="text-critico">{estado}</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              }),
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Botão de concluir, separado porque conclusão é decisão, não consequência. */
export function ConcluirExame({
  acao,
}: {
  readonly acao: () => Promise<{ ok: boolean; mensagem: string }>
}) {
  const [estado, setEstado] = useState<string | null>(null)
  return (
    <div className="flex items-center gap-3">
      <Button
        variante="secundario"
        onClick={async () => {
          setEstado('…')
          const r = await acao()
          setEstado(r.mensagem)
        }}
      >
        Concluir exame
      </Button>
      {estado && <span className="text-sm text-fg-2">{estado}</span>}
    </div>
  )
}
