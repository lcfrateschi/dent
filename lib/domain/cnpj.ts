import { apenasDigitos } from './cpf'

/**
 * CNPJ: validação pelos dois dígitos verificadores.
 *
 * Existe pelo mesmo motivo de `cpf.ts`: CNPJ digitado errado só aparece quando a
 * nota fiscal é rejeitada ou quando a guia volta glosada por dado do prestador.
 * Aqui há três: o da clínica (`clinica.cnpj`), o da operadora (`convenio.cnpj`) e
 * o que vai no XML TISS.
 *
 * **O que isto NÃO faz:** não diz se a empresa existe nem se está ativa na
 * Receita. Dígito verificador só pega erro de digitação.
 */

const PESOS_PRIMEIRO = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const
const PESOS_SEGUNDO = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const

function digito(base: string, pesos: readonly number[]): number {
  const soma = base
    .split('')
    .reduce((acc, d, i) => acc + Number(d) * (pesos[i] ?? 0), 0)
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

export function cnpjEhValido(valor: string): boolean {
  const d = apenasDigitos(valor)
  if (d.length !== 14) return false
  // Todos iguais passam na conta dos dígitos (00000000000000 é "válido"
  // aritmeticamente) e nunca é CNPJ real.
  if (/^(\d)\1{13}$/.test(d)) return false

  const base = d.slice(0, 12)
  const primeiro = digito(base, PESOS_PRIMEIRO)
  const segundo = digito(base + primeiro, PESOS_SEGUNDO)
  return d === `${base}${primeiro}${segundo}`
}

/** Só dígitos, para gravar. O banco guarda 14 caracteres sem pontuação. */
export function normalizarCnpj(valor: string): string {
  return apenasDigitos(valor)
}

/** `12.345.678/0001-95` — como aparece em documento. */
export function formatarCnpj(cnpj: string): string {
  const d = apenasDigitos(cnpj)
  if (d.length !== 14) return cnpj
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}

/** `12345-678` → CEP formatado. Mora aqui por ser do mesmo grupo de documentos. */
export function formatarCep(cep: string): string {
  const d = apenasDigitos(cep)
  if (d.length !== 8) return cep
  return `${d.slice(0, 5)}-${d.slice(5)}`
}

export { apenasDigitos }
