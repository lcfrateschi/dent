import { erro } from './erros'

/**
 * CPF. Guardado no banco como 11 dígitos, sem pontuação — formatar é
 * responsabilidade da apresentação, não do dado.
 *
 * O CPF é OPCIONAL no cadastro de paciente: criança pequena costuma não ter, e
 * exigir travaria o atendimento na recepção. Quando informado, precisa ser
 * válido — CPF errado gera glosa em guia de convênio e nota fiscal rejeitada.
 */

/** Remove tudo que não é dígito. */
export function apenasDigitos(valor: string): string {
  return valor.replace(/\D/g, '')
}

function calcularDigito(base: string, pesoInicial: number): number {
  let soma = 0
  for (let i = 0; i < base.length; i++) {
    soma += Number(base[i]) * (pesoInicial - i)
  }
  const resto = (soma * 10) % 11
  return resto === 10 ? 0 : resto
}

/**
 * Valida os dois dígitos verificadores.
 *
 * Rejeita também as sequências de dígito repetido (`111...`): passam na conta
 * dos verificadores mas não são CPFs emitidos, e é o que alguém digita para
 * "furar" um campo obrigatório.
 */
export function cpfEhValido(valor: string): boolean {
  const cpf = apenasDigitos(valor)
  if (cpf.length !== 11) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false

  const primeiro = calcularDigito(cpf.slice(0, 9), 10)
  if (primeiro !== Number(cpf[9])) return false

  const segundo = calcularDigito(cpf.slice(0, 10), 11)
  return segundo === Number(cpf[10])
}

/** Normaliza para armazenamento: 11 dígitos. Lança se inválido. */
export function normalizarCpf(valor: string): string {
  const cpf = apenasDigitos(valor)
  if (!cpfEhValido(cpf)) {
    erro('CPF_INVALIDO', `CPF inválido: "${valor}".`, { valor })
  }
  return cpf
}

/** 12345678909 → 123.456.789-09. Só apresentação. */
export function formatarCpf(cpf: string): string {
  const d = apenasDigitos(cpf)
  if (d.length !== 11) return cpf
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}

/** Telefone brasileiro: 10 dígitos (fixo) ou 11 (celular com 9). */
export function telefoneEhValido(valor: string): boolean {
  const d = apenasDigitos(valor)
  if (d.length !== 10 && d.length !== 11) return false
  const ddd = Number(d.slice(0, 2))
  if (ddd < 11 || ddd > 99) return false
  // Celular (11 dígitos) sempre começa com 9 depois do DDD.
  if (d.length === 11 && d[2] !== '9') return false
  return true
}

export function formatarTelefone(valor: string): string {
  const d = apenasDigitos(valor)
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return valor
}

/** CEP: 8 dígitos. */
export function cepEhValido(valor: string): boolean {
  return apenasDigitos(valor).length === 8
}

export function formatarCep(valor: string): string {
  const d = apenasDigitos(valor)
  if (d.length !== 8) return valor
  return `${d.slice(0, 5)}-${d.slice(5)}`
}

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const

export type Uf = (typeof UFS)[number]

export function ufEhValida(valor: string): valor is Uf {
  return (UFS as readonly string[]).includes(valor.toUpperCase())
}
