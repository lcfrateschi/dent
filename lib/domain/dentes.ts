import { erro } from './erros'

export type Denticao = 'permanente' | 'deciduo'
export type Arcada = 'superior' | 'inferior'
export type Lado = 'direito' | 'esquerdo'

export type TipoDente =
  | 'incisivo_central'
  | 'incisivo_lateral'
  | 'canino'
  | 'primeiro_premolar'
  | 'segundo_premolar'
  | 'primeiro_molar'
  | 'segundo_molar'
  | 'terceiro_molar'

export type Face =
  | 'mesial'
  | 'distal'
  | 'vestibular'
  | 'lingual'
  | 'palatina'
  | 'oclusal'
  | 'incisal'
  | 'cervical'

export interface Dente {
  readonly fdi: number
  readonly denticao: Denticao
  readonly arcada: Arcada
  readonly lado: Lado
  readonly quadrante: number
  readonly tipo: TipoDente
  readonly facesValidas: readonly Face[]
  /** Permanente que sucede este decíduo. `null` nos permanentes. */
  readonly sucessorFdi: number | null
  readonly nome: string
}

/** Posição (segundo dígito FDI) → tipo, na dentição permanente. */
const TIPOS_PERMANENTE: readonly TipoDente[] = [
  'incisivo_central',
  'incisivo_lateral',
  'canino',
  'primeiro_premolar',
  'segundo_premolar',
  'primeiro_molar',
  'segundo_molar',
  'terceiro_molar',
]

/**
 * Posição → tipo, na dentição decídua. Só 5 dentes por quadrante:
 * o decíduo não tem pré-molares — os molares decíduos (posições 4 e 5) são
 * sucedidos pelos pré-molares permanentes.
 */
const TIPOS_DECIDUO: readonly TipoDente[] = [
  'incisivo_central',
  'incisivo_lateral',
  'canino',
  'primeiro_molar',
  'segundo_molar',
]

const ANTERIORES: ReadonlySet<TipoDente> = new Set<TipoDente>([
  'incisivo_central',
  'incisivo_lateral',
  'canino',
])

const NOME_TIPO: Readonly<Record<TipoDente, string>> = {
  incisivo_central: 'Incisivo central',
  incisivo_lateral: 'Incisivo lateral',
  canino: 'Canino',
  primeiro_premolar: '1º pré-molar',
  segundo_premolar: '2º pré-molar',
  primeiro_molar: '1º molar',
  segundo_molar: '2º molar',
  terceiro_molar: '3º molar',
}

/** Dentes anteriores têm face incisal; posteriores têm oclusal. Nunca as duas. */
export function ehAnterior(tipo: TipoDente): boolean {
  return ANTERIORES.has(tipo)
}

/**
 * Faces anatomicamente válidas para um dente.
 *
 * Sempre: mesial, distal, vestibular, cervical.
 * Superior → palatina. Inferior → lingual.
 * Anterior → incisal. Posterior → oclusal.
 */
export function facesDe(arcada: Arcada, tipo: TipoDente): readonly Face[] {
  return [
    'mesial',
    'distal',
    'vestibular',
    arcada === 'superior' ? 'palatina' : 'lingual',
    ehAnterior(tipo) ? 'incisal' : 'oclusal',
    'cervical',
  ] as const
}

function arcadaDoQuadrante(q: number): Arcada {
  // 1,2 e 5,6 são superiores; 3,4 e 7,8 são inferiores.
  return q === 1 || q === 2 || q === 5 || q === 6 ? 'superior' : 'inferior'
}

function ladoDoQuadrante(q: number): Lado {
  // 1,4 e 5,8 são do lado direito do paciente; 2,3 e 6,7 do esquerdo.
  return q === 1 || q === 4 || q === 5 || q === 8 ? 'direito' : 'esquerdo'
}

/**
 * Catálogo completo dos 52 dentes em notação FDI: 32 permanentes + 20 decíduos.
 * É a fonte do seed de `dente` e da validação de faces. Ordenado por FDI.
 */
export function catalogoDentes(): readonly Dente[] {
  const dentes: Dente[] = []

  for (const quadrante of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const deciduo = quadrante >= 5
    const tipos = deciduo ? TIPOS_DECIDUO : TIPOS_PERMANENTE
    const arcada = arcadaDoQuadrante(quadrante)
    const lado = ladoDoQuadrante(quadrante)

    tipos.forEach((tipo, i) => {
      const posicao = i + 1
      const fdi = quadrante * 10 + posicao
      const sufixo = `${arcada} ${lado}`
      dentes.push({
        fdi,
        denticao: deciduo ? 'deciduo' : 'permanente',
        arcada,
        lado,
        quadrante,
        tipo,
        facesValidas: facesDe(arcada, tipo),
        // Decíduo do quadrante 5..8 é sucedido pelo permanente do quadrante 1..4,
        // mesma posição: 54 (1º molar decíduo) → 14 (1º pré-molar).
        sucessorFdi: deciduo ? (quadrante - 4) * 10 + posicao : null,
        nome: deciduo
          ? `${NOME_TIPO[tipo]} ${sufixo} (decíduo)`
          : `${NOME_TIPO[tipo]} ${sufixo}`,
      })
    })
  }

  return dentes.sort((a, b) => a.fdi - b.fdi)
}

const POR_FDI: ReadonlyMap<number, Dente> = new Map(catalogoDentes().map((d) => [d.fdi, d]))

/** Retorna o dente ou `undefined` se o código FDI não existir. */
export function acharDente(fdi: number): Dente | undefined {
  return POR_FDI.get(fdi)
}

/** Retorna o dente ou lança `ErroDominio`. */
export function exigirDente(fdi: number): Dente {
  const d = POR_FDI.get(fdi)
  if (!d) {
    erro('DENTE_INEXISTENTE', `Dente FDI ${fdi} não existe.`, { fdi })
  }
  return d
}

export function ehFdiValido(fdi: number): boolean {
  return POR_FDI.has(fdi)
}
