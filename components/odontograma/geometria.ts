import {
  type Dente,
  type Denticao,
  type Face,
  catalogoDentes,
  ehAnterior,
  exigirDente,
} from '@/lib/domain/dentes'

/**
 * Geometria do odontograma. Módulo PURO, sem React — é aqui que mora o bug
 * silencioso: mesial e distal trocam de lado conforme o quadrante, e ninguém
 * percebe olhando a tela.
 *
 * ── Convenções de desenho ──────────────────────────────────────────────────
 *
 * Cada dente é a vista OCLUSAL da coroa: um quadrado dividido em 5 regiões
 * (4 trapézios + centro), envolto por uma moldura fina que representa a face
 * cervical — cervical é o colo do dente, que circunda todas as faces, então
 * moldura é a representação anatomicamente honesta.
 *
 *   ┌─────────────────┐  ← moldura = cervical
 *   │ ╲     topo     ╱ │
 *   │  ╲───────────╱   │
 *   │ e │  centro  │ d │
 *   │  ╱───────────╲   │
 *   │ ╱     base     ╲ │
 *   └─────────────────┘
 *
 * - `topo`/`base`: vestibular fica sempre na borda EXTERNA do diagrama
 *   (para cima na arcada superior, para baixo na inferior). A face interna
 *   (palatina em cima, lingual embaixo) fica voltada para a linha do meio.
 * - `esquerda`/`direita`: mesial aponta para a linha média do paciente.
 *   Quadrantes do lado DIREITO do paciente (1, 4, 5, 8) são desenhados na
 *   metade ESQUERDA da tela — logo, para eles, mesial é a trapézio da DIREITA.
 * - `centro`: incisal nos anteriores, oclusal nos posteriores.
 */

export type Posicao = 'topo' | 'base' | 'esquerda' | 'direita' | 'centro'

/** Metade do diagrama em que o dente é desenhado (o paciente está de frente). */
export type MetadeDesenho = 'esquerda' | 'direita'

export interface Medidas {
  /** Lado do quadrado externo, incluindo a moldura cervical. */
  readonly ladoExterno: number
  /** Espessura da moldura cervical. */
  readonly molduraCervical: number
  /** Lado do quadrado central (oclusal/incisal). */
  readonly ladoCentro: number
  /** Espaço horizontal entre dentes. */
  readonly espacoX: number
  /** Espaço vertical entre fileiras. */
  readonly espacoY: number
  /** Altura reservada ao rótulo FDI. */
  readonly alturaRotulo: number
  /** Folga extra na linha média entre as arcadas. */
  readonly folgaLinhaMedia: number
}

export const MEDIDAS: Readonly<Record<'compacto' | 'confortavel', Medidas>> = {
  compacto: {
    ladoExterno: 34,
    molduraCervical: 4,
    ladoCentro: 11,
    espacoX: 4,
    espacoY: 6,
    alturaRotulo: 13,
    folgaLinhaMedia: 14,
  },
  // Alvo de toque maior: cada face fica com ~18px, usável em tablet no consultório.
  confortavel: {
    ladoExterno: 52,
    molduraCervical: 6,
    ladoCentro: 16,
    espacoX: 6,
    espacoY: 10,
    alturaRotulo: 16,
    folgaLinhaMedia: 20,
  },
}

/**
 * De qual lado do diagrama o dente aparece. Como o paciente está de frente,
 * o lado direito DELE fica à nossa esquerda.
 */
export function metadeDesenho(dente: Pick<Dente, 'lado'>): MetadeDesenho {
  return dente.lado === 'direito' ? 'esquerda' : 'direita'
}

/**
 * Qual face ocupa cada posição do quadrado. As 5 posições mais a cervical
 * devem cobrir exatamente `dente.facesValidas` — há teste garantindo isso.
 */
export function mapearFaces(dente: Dente): Readonly<Record<Posicao, Face>> {
  const superior = dente.arcada === 'superior'
  const desenhadoNaEsquerda = metadeDesenho(dente) === 'esquerda'

  return {
    // Vestibular sempre na borda externa do diagrama.
    topo: superior ? 'vestibular' : 'lingual',
    base: superior ? 'palatina' : 'vestibular',
    // Mesial aponta para a linha média.
    esquerda: desenhadoNaEsquerda ? 'distal' : 'mesial',
    direita: desenhadoNaEsquerda ? 'mesial' : 'distal',
    centro: ehAnterior(dente.tipo) ? 'incisal' : 'oclusal',
  }
}

export interface RegiaoFace {
  readonly face: Face
  readonly posicao: Posicao | 'cervical'
  /** `d` de um <path> SVG, em coordenadas absolutas. */
  readonly path: string
}

export interface DenteLayout {
  readonly fdi: number
  readonly dente: Dente
  /** Canto superior esquerdo do quadrado externo. */
  readonly x: number
  readonly y: number
  readonly lado: number
  readonly metade: MetadeDesenho
  readonly regioes: readonly RegiaoFace[]
  /** Centro do dente, para glifos de ausente/implante. */
  readonly centro: { readonly x: number; readonly y: number }
  /** Posição do rótulo FDI. */
  readonly rotulo: { readonly x: number; readonly y: number }
}

export interface FileiraLayout {
  readonly chave: string
  readonly denticao: Denticao
  readonly arcada: 'superior' | 'inferior'
  readonly fdis: readonly number[]
  readonly y: number
}

export interface OdontogramaLayout {
  readonly largura: number
  readonly altura: number
  readonly fileiras: readonly FileiraLayout[]
  readonly dentes: readonly DenteLayout[]
  /** X da linha média, para desenhar o eixo de simetria. */
  readonly linhaMediaX: number
  /** Y da linha entre as arcadas. */
  readonly linhaArcadasY: number
}

function p(n: number): string {
  // Duas casas bastam e mantêm o SVG legível no diff.
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** Moldura cervical: quadrado externo com o interno recortado (regra even-odd). */
function pathMoldura(x: number, y: number, lado: number, borda: number): string {
  const xi = x + borda
  const yi = y + borda
  const li = lado - borda * 2
  return (
    `M${p(x)} ${p(y)}H${p(x + lado)}V${p(y + lado)}H${p(x)}Z` +
    `M${p(xi)} ${p(yi)}H${p(xi + li)}V${p(yi + li)}H${p(xi)}Z`
  )
}

function regioesDoDente(dente: Dente, x: number, y: number, m: Medidas): RegiaoFace[] {
  const faces = mapearFaces(dente)
  const b = m.molduraCervical
  // Quadrado interno (a coroa em si), dentro da moldura cervical.
  const ix = x + b
  const iy = y + b
  const il = m.ladoExterno - b * 2
  // Quadrado central (oclusal/incisal), centralizado no interno.
  const c = (il - m.ladoCentro) / 2
  const cx1 = ix + c
  const cy1 = iy + c
  const cx2 = cx1 + m.ladoCentro
  const cy2 = cy1 + m.ladoCentro

  return [
    {
      // Cervical não é uma das 5 posições do quadrado: é a moldura, e todo
      // dente a tem. Por isso é literal, não vem de `mapearFaces`.
      face: 'cervical',
      posicao: 'cervical',
      path: pathMoldura(x, y, m.ladoExterno, b),
    },
    {
      face: faces.topo,
      posicao: 'topo',
      path: `M${p(ix)} ${p(iy)}H${p(ix + il)}L${p(cx2)} ${p(cy1)}H${p(cx1)}Z`,
    },
    {
      face: faces.direita,
      posicao: 'direita',
      path: `M${p(ix + il)} ${p(iy)}V${p(iy + il)}L${p(cx2)} ${p(cy2)}V${p(cy1)}Z`,
    },
    {
      face: faces.base,
      posicao: 'base',
      path: `M${p(ix)} ${p(iy + il)}H${p(ix + il)}L${p(cx2)} ${p(cy2)}H${p(cx1)}Z`,
    },
    {
      face: faces.esquerda,
      posicao: 'esquerda',
      path: `M${p(ix)} ${p(iy)}V${p(iy + il)}L${p(cx1)} ${p(cy2)}V${p(cy1)}Z`,
    },
    {
      face: faces.centro,
      posicao: 'centro',
      path: `M${p(cx1)} ${p(cy1)}H${p(cx2)}V${p(cy2)}H${p(cx1)}Z`,
    },
  ]
}

/**
 * Ordem dos dentes numa fileira, da esquerda para a direita da tela.
 * Do 8 ao 1 na metade esquerda (lado direito do paciente), depois do 1 ao 8.
 */
function fdisDaFileira(
  denticao: Denticao,
  arcada: 'superior' | 'inferior',
): { readonly esquerda: number[]; readonly direita: number[] } {
  const quadrantes =
    denticao === 'permanente'
      ? arcada === 'superior'
        ? [1, 2]
        : [4, 3]
      : arcada === 'superior'
        ? [5, 6]
        : [8, 7]

  const posicoes = denticao === 'permanente' ? 8 : 5
  const [qDireito, qEsquerdo] = quadrantes as [number, number]

  return {
    // Metade esquerda da tela: do fundo (posição 8/5) até o incisivo central.
    esquerda: Array.from({ length: posicoes }, (_, i) => qDireito * 10 + (posicoes - i)),
    direita: Array.from({ length: posicoes }, (_, i) => qEsquerdo * 10 + (i + 1)),
  }
}

export interface OpcoesLayout {
  readonly denticao: Denticao | 'mista'
  readonly tamanho?: 'compacto' | 'confortavel'
}

/**
 * Monta o layout completo.
 *
 * Na dentição mista as fileiras decíduas ficam por DENTRO (mais próximas da
 * linha entre as arcadas) e alinhadas à linha média, que é como a criança em
 * transição é registrada na prática.
 */
export function layoutOdontograma({
  denticao,
  tamanho = 'compacto',
}: OpcoesLayout): OdontogramaLayout {
  const m = MEDIDAS[tamanho]
  const catalogo = new Map(catalogoDentes().map((d) => [d.fdi, d]))
  const passo = m.ladoExterno + m.espacoX

  // A largura é ditada pela dentição permanente: 8 dentes de cada lado.
  const colunasPorLado = 8
  const larguraLado = colunasPorLado * passo - m.espacoX
  // Vão da linha média, repartido igualmente entre as duas metades — senão o
  // diagrama fica assimétrico e o 11 e o 21 não encostam de forma espelhada.
  const vaoLinhaMedia = m.espacoX * 2
  const linhaMediaX = larguraLado + vaoLinhaMedia / 2
  const largura = larguraLado * 2 + vaoLinhaMedia

  const superiores: Denticao[] =
    denticao === 'mista' ? ['permanente', 'deciduo'] : [denticao]
  // Espelhado: embaixo, o decíduo vem primeiro (mais perto da linha média).
  const inferiores: Denticao[] =
    denticao === 'mista' ? ['deciduo', 'permanente'] : [denticao]

  const fileiras: FileiraLayout[] = []
  const dentes: DenteLayout[] = []
  let y = 0

  const montarFileira = (dent: Denticao, arcada: 'superior' | 'inferior'): void => {
    const { esquerda, direita } = fdisDaFileira(dent, arcada)
    const posicoes = dent === 'permanente' ? 8 : 5
    // Fileira decídua tem 5 dentes: encosta na linha média, sobrando colunas na ponta.
    const recuo = (colunasPorLado - posicoes) * passo

    esquerda.forEach((fdi, i) => {
      const dente = catalogo.get(fdi)
      if (!dente) return
      const x = recuo + i * passo
      dentes.push(montarDente(dente, x, y, m, 'esquerda'))
    })
    direita.forEach((fdi, i) => {
      const dente = catalogo.get(fdi)
      if (!dente) return
      const x = larguraLado + vaoLinhaMedia + i * passo
      dentes.push(montarDente(dente, x, y, m, 'direita'))
    })

    fileiras.push({
      chave: `${arcada}-${dent}`,
      denticao: dent,
      arcada,
      fdis: [...esquerda, ...direita],
      y,
    })
    y += m.ladoExterno + m.alturaRotulo + m.espacoY
  }

  for (const d of superiores) montarFileira(d, 'superior')

  const linhaArcadasY = y - m.espacoY + m.folgaLinhaMedia / 2
  y += m.folgaLinhaMedia

  for (const d of inferiores) montarFileira(d, 'inferior')

  return {
    largura,
    altura: y - m.espacoY,
    fileiras,
    dentes,
    linhaMediaX,
    linhaArcadasY,
  }
}

function montarDente(
  dente: Dente,
  x: number,
  y: number,
  m: Medidas,
  metade: MetadeDesenho,
): DenteLayout {
  return {
    fdi: dente.fdi,
    dente,
    x,
    y,
    lado: m.ladoExterno,
    metade,
    regioes: regioesDoDente(dente, x, y, m),
    centro: { x: x + m.ladoExterno / 2, y: y + m.ladoExterno / 2 },
    rotulo: {
      x: x + m.ladoExterno / 2,
      // Rótulo abaixo do quadrado, na área reservada.
      y: y + m.ladoExterno + m.alturaRotulo - 3,
    },
  }
}

/** Nome apresentável da face, para tooltip e leitor de tela. */
export function rotuloFace(face: Face): string {
  const nomes: Record<Face, string> = {
    mesial: 'mesial',
    distal: 'distal',
    vestibular: 'vestibular',
    lingual: 'lingual',
    palatina: 'palatina',
    oclusal: 'oclusal',
    incisal: 'incisal',
    cervical: 'cervical',
  }
  return nomes[face]
}

/** Descrição do dente para `aria-label`. */
export function rotuloDente(fdi: number): string {
  return `Dente ${fdi} — ${exigirDente(fdi).nome}`
}
