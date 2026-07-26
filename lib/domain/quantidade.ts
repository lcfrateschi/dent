import { erro } from './erros'

/**
 * Quantidade de material em `numeric(12,3)` no banco e `string` no TS —
 * a mesma disciplina do dinheiro, pela mesma razão.
 *
 * **Por que três decimais e não inteiro.** Nem todo insumo se conta: hipoclorito
 * sai em mililitros, resina em gramas, cimento em porções. `0.1 + 0.2` em float
 * dá `0.30000000000000004`, e num livro de estoque isso vira saldo que não fecha
 * na contagem — a mesma classe de bug que o centavo. Aritmética em milésimos
 * inteiros; a borda converte.
 *
 * Três decimais cobrem o menor insumo real (0,001 g não existe em consultório) e
 * ainda deixam `numeric(12,3)` guardar nove dígitos inteiros.
 */

const FORMATO = /^-?\d{1,9}(\.\d{1,3})?$/

/** "1.5" → 1500. Lança se o formato não couber em numeric(_,3). */
export function paraMilesimos(quantidade: string): number {
  const q = quantidade.trim()
  if (!FORMATO.test(q)) {
    erro(
      'QUANTIDADE_INVALIDA',
      `Quantidade inválida: "${quantidade}". Esperada como "1.5" ou "12", até 3 decimais.`,
      { quantidade },
    )
  }
  const negativo = q.startsWith('-')
  const [inteiro = '0', decimal = ''] = q.replace('-', '').split('.')
  const milesimos = Number(inteiro) * 1000 + Number(decimal.padEnd(3, '0'))
  return negativo ? -milesimos : milesimos
}

/** 1500 → "1.500" */
export function deMilesimos(milesimos: number): string {
  if (!Number.isInteger(milesimos)) {
    erro(
      'MILESIMOS_FRACIONARIOS',
      `Milésimos devem ser inteiros, recebido ${milesimos}. Arredonde antes de converter.`,
      { milesimos },
    )
  }
  const sinal = milesimos < 0 ? '-' : ''
  const abs = Math.abs(milesimos)
  return `${sinal}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`
}

export function somarQtd(...quantidades: readonly string[]): string {
  return deMilesimos(quantidades.reduce((acc, q) => acc + paraMilesimos(q), 0))
}

export function subtrairQtd(a: string, b: string): string {
  return deMilesimos(paraMilesimos(a) - paraMilesimos(b))
}

export function comparaQtd(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = [paraMilesimos(a), paraMilesimos(b)]
  return x < y ? -1 : x > y ? 1 : 0
}

export function ehZeroQtd(quantidade: string): boolean {
  return paraMilesimos(quantidade) === 0
}

/**
 * Multiplica por um fator inteiro — a conversão de embalagem.
 *
 * "Comprei 2 caixas de luva" não é entrada de 2: é de 2 × 100. Registrar 2 é o
 * erro mais comum de quem lança nota fiscal, e ele aparece semanas depois como
 * alerta de mínimo que nunca dispara. Ver `converterCompra`.
 */
export function multiplicarQtd(quantidade: string, fator: number): string {
  if (!Number.isInteger(fator) || fator < 0) {
    erro('FATOR_INVALIDO', `Fator deve ser inteiro não-negativo, recebido ${fator}.`, { fator })
  }
  return deMilesimos(paraMilesimos(quantidade) * fator)
}

/**
 * Quantidade de embalagens → quantidade na unidade de consumo.
 *
 * `converterCompra("2", 100)` → `"200.000"` (2 caixas de 100 luvas).
 * Material sem embalagem múltipla usa fator 1.
 */
export function converterCompra(embalagens: string, unidadesPorEmbalagem: number): string {
  if (!Number.isInteger(unidadesPorEmbalagem) || unidadesPorEmbalagem < 1) {
    erro(
      'EMBALAGEM_INVALIDA',
      `Unidades por embalagem deve ser inteiro >= 1, recebido ${unidadesPorEmbalagem}.`,
      { unidadesPorEmbalagem },
    )
  }
  return multiplicarQtd(embalagens, unidadesPorEmbalagem)
}

/**
 * Formata para leitura humana, sem decimal inútil.
 *
 * `formatarQuantidade("12.000", "un")` → `"12 un"`
 * `formatarQuantidade("0.500", "ml")` → `"0,5 ml"`
 *
 * Vírgula decimal: é o que a recepção lê e digita.
 */
export function formatarQuantidade(quantidade: string, unidade?: string): string {
  const milesimos = paraMilesimos(quantidade)
  const sinal = milesimos < 0 ? '-' : ''
  const abs = Math.abs(milesimos)
  const inteiro = Math.floor(abs / 1000)
  const decimal = String(abs % 1000).padStart(3, '0').replace(/0+$/, '')
  const numero = decimal === '' ? `${inteiro}` : `${inteiro},${decimal}`
  return unidade ? `${sinal}${numero} ${unidade}` : `${sinal}${numero}`
}
