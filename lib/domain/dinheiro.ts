import { erro } from './erros'

/**
 * Dinheiro em `numeric(10,2)` no banco e `string` no TS.
 * Toda aritmética acontece em centavos inteiros — float com dinheiro perde centavo
 * e o financeiro não fecha. Ver CLAUDE.md.
 */

const FORMATO = /^-?\d{1,13}(\.\d{1,2})?$/

/** "1234.56" → 123456. Lança se o formato não for numeric(_,2). */
export function paraCentavos(valor: string): number {
  const v = valor.trim()
  if (!FORMATO.test(v)) {
    erro('DINHEIRO_INVALIDO', `Valor monetário inválido: "${valor}". Esperado como "1234.56".`, {
      valor,
    })
  }
  const negativo = v.startsWith('-')
  const [inteiro = '0', decimal = ''] = v.replace('-', '').split('.')
  const centavos = Number(inteiro) * 100 + Number(decimal.padEnd(2, '0'))
  return negativo ? -centavos : centavos
}

/** 123456 → "1234.56" */
export function deCentavos(centavos: number): string {
  if (!Number.isInteger(centavos)) {
    erro('CENTAVOS_FRACIONARIOS', `Centavos devem ser inteiros, recebido ${centavos}.`, { centavos })
  }
  const sinal = centavos < 0 ? '-' : ''
  const abs = Math.abs(centavos)
  return `${sinal}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function somar(...valores: readonly string[]): string {
  return deCentavos(valores.reduce((acc, v) => acc + paraCentavos(v), 0))
}

export function subtrair(a: string, b: string): string {
  return deCentavos(paraCentavos(a) - paraCentavos(b))
}

/** Multiplica por uma quantidade inteira (linha de orçamento com quantidade). */
export function multiplicar(valor: string, quantidade: number): string {
  if (!Number.isInteger(quantidade) || quantidade < 0) {
    erro('QUANTIDADE_INVALIDA', `Quantidade deve ser inteiro não-negativo, recebido ${quantidade}.`, {
      quantidade,
    })
  }
  return deCentavos(paraCentavos(valor) * quantidade)
}

/** Aplica um percentual (ex.: cobertura de convênio, comissão), arredondando ao centavo. */
export function percentual(valor: string, pct: string): string {
  const p = Number(pct)
  if (!Number.isFinite(p) || p < 0) {
    erro('PERCENTUAL_INVALIDO', `Percentual inválido: "${pct}".`, { pct })
  }
  return deCentavos(Math.round((paraCentavos(valor) * p) / 100))
}

export function compara(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = [paraCentavos(a), paraCentavos(b)]
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Divide um total em `partes` inteiras de centavos cuja soma é EXATAMENTE o total.
 * A sobra do arredondamento vai na PRIMEIRA parte — convenção da clínica:
 * a primeira parcela é a maior, para o resto sair redondo.
 *
 * ratear("100.00", 3) → ["33.34", "33.33", "33.33"]
 */
export function ratear(total: string, partes: number): string[] {
  if (!Number.isInteger(partes) || partes < 1) {
    erro('PARTES_INVALIDAS', `Número de partes deve ser inteiro >= 1, recebido ${partes}.`, {
      partes,
    })
  }
  const totalCentavos = paraCentavos(total)
  if (totalCentavos < 0) {
    erro('TOTAL_NEGATIVO', `Não é possível ratear valor negativo: ${total}.`, { total })
  }

  const base = Math.floor(totalCentavos / partes)
  const sobra = totalCentavos - base * partes

  return Array.from({ length: partes }, (_, i) => deCentavos(i === 0 ? base + sobra : base))
}
