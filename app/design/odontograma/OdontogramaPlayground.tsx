'use client'

import { Legenda } from '@/components/odontograma/Legenda'
import { Odontograma } from '@/components/odontograma/Odontograma'
import type {
  EstadoDente,
  EstadoFace,
  MarcacoesDente,
  MarcacoesFace,
  SelecaoFaces,
} from '@/components/odontograma/tipos'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { type Denticao, type Face, exigirDente } from '@/lib/domain/dentes'
import { descreverFaces } from '@/lib/domain/faces'
import { useMemo, useState } from 'react'

type Ferramenta =
  | 'selecionar'
  | 'planejado'
  | 'executado'
  | 'limpar'
  | 'presente'
  | 'ausente'
  | 'coroa'
  | 'implante'

const FERRAMENTAS_FACE: readonly Ferramenta[] = ['selecionar', 'planejado', 'executado', 'limpar']

const ROTULO_FERRAMENTA: Record<Ferramenta, string> = {
  selecionar: 'Selecionar',
  planejado: 'Planejar',
  executado: 'Executar',
  limpar: 'Limpar',
  presente: 'Presente',
  ausente: 'Ausente',
  coroa: 'Coroa',
  implante: 'Implante',
}

/** Caso realista para mostrar ao dentista sem ele precisar clicar 20 vezes. */
const EXEMPLO: { face: MarcacoesFace; dente: MarcacoesDente } = {
  face: {
    16: { oclusal: 'executado', mesial: 'executado' },
    26: { oclusal: 'planejado' },
    36: { oclusal: 'planejado', distal: 'planejado' },
    11: { incisal: 'executado' },
    21: { mesial: 'planejado' },
    47: { oclusal: 'executado', vestibular: 'executado' },
    34: { cervical: 'planejado' },
  },
  dente: { 18: 'ausente', 28: 'ausente', 46: 'coroa', 37: 'implante' },
}

export function OdontogramaPlayground() {
  const [denticao, setDenticao] = useState<Denticao | 'mista'>('permanente')
  const [tamanho, setTamanho] = useState<'compacto' | 'confortavel'>('compacto')
  const [ferramenta, setFerramenta] = useState<Ferramenta>('selecionar')
  const [marcacoesFace, setMarcacoesFace] = useState<MarcacoesFace>({})
  const [marcacoesDente, setMarcacoesDente] = useState<MarcacoesDente>({})
  const [selecao, setSelecao] = useState<SelecaoFaces>({})

  const ehFerramentaDeFace = FERRAMENTAS_FACE.includes(ferramenta)

  function aplicarNaFace(fdi: number, face: Face): void {
    if (ferramenta === 'selecionar') {
      setSelecao((s) => {
        const atuais = s[fdi] ?? []
        const proximas = atuais.includes(face)
          ? atuais.filter((f) => f !== face)
          : [...atuais, face]
        const { [fdi]: _, ...resto } = s
        return proximas.length > 0 ? { ...resto, [fdi]: proximas } : resto
      })
      return
    }

    setMarcacoesFace((m) => {
      const doDente = { ...(m[fdi] ?? {}) }
      if (ferramenta === 'limpar') delete doDente[face]
      else doDente[face] = ferramenta as EstadoFace

      if (Object.keys(doDente).length === 0) {
        const { [fdi]: _, ...resto } = m
        return resto
      }
      return { ...m, [fdi]: doDente }
    })
  }

  function aplicarNoDente(fdi: number): void {
    // Ferramenta de dente: clicar em qualquer parte aplica ao dente inteiro.
    if (!ehFerramentaDeFace) {
      setMarcacoesDente((m) => {
        if (ferramenta === 'presente') {
          const { [fdi]: _, ...resto } = m
          return resto
        }
        return { ...m, [fdi]: ferramenta as EstadoDente }
      })
      return
    }

    // Ferramenta de face + dente inteiro: aplica em todas as faces do dente.
    const faces = exigirDente(fdi).facesValidas

    if (ferramenta === 'selecionar') {
      setSelecao((s) => {
        const jaTodas = (s[fdi]?.length ?? 0) === faces.length
        const { [fdi]: _, ...resto } = s
        return jaTodas ? resto : { ...resto, [fdi]: [...faces] }
      })
      return
    }

    setMarcacoesFace((m) => {
      if (ferramenta === 'limpar') {
        const { [fdi]: _, ...resto } = m
        return resto
      }
      const estado = ferramenta as EstadoFace
      return { ...m, [fdi]: Object.fromEntries(faces.map((f) => [f, estado])) }
    })
  }

  function limparTudo(): void {
    setMarcacoesFace({})
    setMarcacoesDente({})
    setSelecao({})
  }

  const itensSelecionados = useMemo(
    () =>
      Object.entries(selecao)
        .map(([fdi, faces]) => ({ fdi: Number(fdi), faces }))
        .sort((a, b) => a.fdi - b.fdi),
    [selecao],
  )

  const contagem = useMemo(() => {
    let planejadas = 0
    let executadas = 0
    for (const faces of Object.values(marcacoesFace)) {
      for (const estado of Object.values(faces)) {
        if (estado === 'planejado') planejadas++
        else if (estado === 'executado') executadas++
      }
    }
    return { planejadas, executadas }
  }, [marcacoesFace])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          titulo="Odontograma"
          descricao="Protótipo isolado. Geometria vinda de catalogoDentes(), com faces validadas por anatomia."
          acoes={
            <>
              <GrupoBotoes rotulo="Dentição">
                {(['permanente', 'deciduo', 'mista'] as const).map((d) => (
                  <Button
                    key={d}
                    tamanho="sm"
                    ativo={denticao === d}
                    onClick={() => setDenticao(d)}
                  >
                    {d === 'permanente' ? 'Permanente' : d === 'deciduo' ? 'Decídua' : 'Mista'}
                  </Button>
                ))}
              </GrupoBotoes>
              <GrupoBotoes rotulo="Tamanho">
                {(['compacto', 'confortavel'] as const).map((t) => (
                  <Button key={t} tamanho="sm" ativo={tamanho === t} onClick={() => setTamanho(t)}>
                    {t === 'compacto' ? 'Compacto' : 'Confortável'}
                  </Button>
                ))}
              </GrupoBotoes>
            </>
          }
        />

        <div className="flex flex-wrap items-end gap-4 border-b border-border bg-surface-2 px-4 py-3">
          <GrupoBotoes rotulo="Marcar face">
            {FERRAMENTAS_FACE.map((f) => (
              <Button
                key={f}
                tamanho="sm"
                ativo={ferramenta === f}
                onClick={() => setFerramenta(f)}
                variante={f === 'limpar' ? 'fantasma' : 'secundario'}
              >
                {ROTULO_FERRAMENTA[f]}
              </Button>
            ))}
          </GrupoBotoes>

          <GrupoBotoes rotulo="Marcar dente inteiro">
            {(['presente', 'ausente', 'coroa', 'implante'] as const).map((f) => (
              <Button key={f} tamanho="sm" ativo={ferramenta === f} onClick={() => setFerramenta(f)}>
                {ROTULO_FERRAMENTA[f]}
              </Button>
            ))}
          </GrupoBotoes>

          <div className="ml-auto flex gap-2">
            <Button
              tamanho="sm"
              onClick={() => {
                setMarcacoesFace(EXEMPLO.face)
                setMarcacoesDente(EXEMPLO.dente)
              }}
            >
              Carregar exemplo
            </Button>
            <Button tamanho="sm" variante="fantasma" onClick={limparTudo}>
              Limpar tudo
            </Button>
          </div>
        </div>

        <CardBody>
          <p className="mb-3 text-xs text-fg-3">
            Clique numa face para aplicar a ferramenta.{' '}
            <kbd className="rounded border border-border bg-surface-2 px-1">Tab</kbd> navega entre
            dentes e{' '}
            <kbd className="rounded border border-border bg-surface-2 px-1">Enter</kbd> aplica ao
            dente inteiro.
          </p>

          <Odontograma
            denticao={denticao}
            tamanho={tamanho}
            marcacoesFace={marcacoesFace}
            marcacoesDente={marcacoesDente}
            selecao={selecao}
            onFaceClick={ehFerramentaDeFace ? aplicarNaFace : (fdi) => aplicarNoDente(fdi)}
            onDenteClick={aplicarNoDente}
          />

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-fg-3">
            <span>
              Faces planejadas: <strong className="text-planejado">{contagem.planejadas}</strong>
            </span>
            <span>
              Faces executadas: <strong className="text-executado">{contagem.executadas}</strong>
            </span>
            <span>
              Dentes com marcação de dente:{' '}
              <strong className="text-fg-2">{Object.keys(marcacoesDente).length}</strong>
            </span>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            titulo="Seleção"
            descricao="É exatamente o que virá a ser um item de plano na Fase 6."
          />
          <CardBody>
            {itensSelecionados.length === 0 ? (
              <p className="text-sm text-fg-3">
                Nada selecionado. Escolha a ferramenta <em>Selecionar</em> e clique nas faces.
              </p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {itensSelecionados.map(({ fdi, faces }) => (
                  <li key={fdi} className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-fg-3">{fdi}</span>
                    {/* Mesma função que congela a descrição no orçamento. */}
                    <span className="text-fg">{descreverFaces(fdi, faces)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader titulo="Legenda e convenções" />
          <CardBody>
            <Legenda />
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function GrupoBotoes({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
        {rotulo}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}
