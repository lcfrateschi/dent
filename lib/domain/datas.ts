import { erro } from './erros'

/**
 * Aritmética sobre datas civis no formato "YYYY-MM-DD", sem passar por `Date`.
 * `Date` interpreta a string em UTC e devolve no fuso local — em BRT (UTC-3),
 * `new Date('2026-03-01').getDate()` é 28 de fevereiro. Vencimento de parcela
 * não pode andar um dia porque o servidor mudou de região.
 */

const FORMATO = /^(\d{4})-(\d{2})-(\d{2})$/

export interface DataCivil {
  readonly ano: number
  readonly mes: number
  readonly dia: number
}

export function parseData(iso: string): DataCivil {
  const m = FORMATO.exec(iso.trim())
  if (!m) {
    erro('DATA_INVALIDA', `Data inválida: "${iso}". Esperado "YYYY-MM-DD".`, { iso })
  }
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasNoMes(ano, mes)) {
    erro('DATA_INEXISTENTE', `Data inexistente no calendário: "${iso}".`, { iso })
  }
  return { ano, mes, dia }
}

export function formatarData({ ano, mes, dia }: DataCivil): string {
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

export function ehAnoBissexto(ano: number): boolean {
  return (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0
}

export function diasNoMes(ano: number, mes: number): number {
  const dias = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (mes === 2 && ehAnoBissexto(ano)) return 29
  return dias[mes - 1] ?? 31
}

/**
 * Soma meses preservando o dia, com clamp no último dia do mês de destino.
 * addMeses("2026-01-31", 1) → "2026-02-28" — e a parcela seguinte volta a cair no dia 31,
 * porque o clamp é aplicado sobre a data original, não sobre a anterior.
 */
export function addMeses(iso: string, meses: number): string {
  const { ano, mes, dia } = parseData(iso)
  const total = (ano * 12 + (mes - 1)) + meses
  const novoAno = Math.floor(total / 12)
  const novoMes = (total % 12) + 1
  return formatarData({ ano: novoAno, mes: novoMes, dia: Math.min(dia, diasNoMes(novoAno, novoMes)) })
}

export function addDias(iso: string, dias: number): string {
  const { ano, mes, dia } = parseData(iso)
  // Dias-desde-a-época via UTC: seguro porque não há conversão de fuso.
  const ms = Date.UTC(ano, mes - 1, dia) + dias * 86_400_000
  const d = new Date(ms)
  return formatarData({
    ano: d.getUTCFullYear(),
    mes: d.getUTCMonth() + 1,
    dia: d.getUTCDate(),
  })
}

export function comparaData(a: string, b: string): -1 | 0 | 1 {
  const x = formatarData(parseData(a))
  const y = formatarData(parseData(b))
  return x < y ? -1 : x > y ? 1 : 0
}

/** Idade em anos completos numa data de referência. Define se o paciente é menor. */
export function idadeEm(nascimento: string, referencia: string): number {
  const n = parseData(nascimento)
  const r = parseData(referencia)
  let idade = r.ano - n.ano
  if (r.mes < n.mes || (r.mes === n.mes && r.dia < n.dia)) idade--
  return idade
}

/** Menor de 18 exige responsável legal para consentimento e orçamento. */
export function ehMenorDeIdade(nascimento: string, referencia: string): boolean {
  return idadeEm(nascimento, referencia) < 18
}
