import { addDias, addMeses, comparaData, diasNoMes, parseData } from './datas'
import { erro } from './erros'

/**
 * Períodos de relatório.
 *
 * Tudo em data civil ('YYYY-MM-DD'), nunca em `Date`. O motivo é o de sempre
 * neste projeto: "o mês de julho" é um intervalo do calendário da clínica, e um
 * `Date` arrasta fuso e hora para dentro de uma pergunta que não tem nem uma nem
 * outra. A conversão para instante acontece uma vez, na borda da consulta, com o
 * fuso da clínica.
 *
 * O intervalo é **fechado nos dois lados** (`de` e `ate` inclusive), porque é
 * assim que a clínica fala: "de 1º a 31 de julho". Quem consulta o banco converte
 * para meia-noite do dia seguinte ao `ate`.
 */

export type TipoPeriodo = 'mes' | 'trimestre' | 'ano' | 'livre'

export interface Periodo {
  readonly de: string
  readonly ate: string
  readonly tipo: TipoPeriodo
  /** Rótulo para a tela: 'julho de 2026', '3º trimestre de 2026'. */
  readonly rotulo: string
}

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const

function ultimoDiaDoMes(ano: number, mes: number): string {
  return `${ano}-${String(mes).padStart(2, '0')}-${String(diasNoMes(ano, mes)).padStart(2, '0')}`
}

/** O mês em que `hojeIso` cai. */
export function mesDe(hojeIso: string): Periodo {
  const { ano, mes } = parseData(hojeIso)
  return {
    de: `${ano}-${String(mes).padStart(2, '0')}-01`,
    ate: ultimoDiaDoMes(ano, mes),
    tipo: 'mes',
    rotulo: `${MESES[mes - 1]} de ${ano}`,
  }
}

/** O trimestre em que `hojeIso` cai. */
export function trimestreDe(hojeIso: string): Periodo {
  const { ano, mes } = parseData(hojeIso)
  const trimestre = Math.ceil(mes / 3)
  const primeiroMes = (trimestre - 1) * 3 + 1
  const ultimoMes = primeiroMes + 2
  return {
    de: `${ano}-${String(primeiroMes).padStart(2, '0')}-01`,
    ate: ultimoDiaDoMes(ano, ultimoMes),
    tipo: 'trimestre',
    rotulo: `${trimestre}º trimestre de ${ano}`,
  }
}

/** O ano em que `hojeIso` cai. */
export function anoDe(hojeIso: string): Periodo {
  const { ano } = parseData(hojeIso)
  return {
    de: `${ano}-01-01`,
    ate: `${ano}-12-31`,
    tipo: 'ano',
    rotulo: String(ano),
  }
}

/** Período livre, validado. */
export function periodoLivre(de: string, ate: string): Periodo {
  parseData(de)
  parseData(ate)
  if (comparaData(de, ate) > 0) {
    erro('PERIODO_INVERTIDO', `Período invertido: de ${de} até ${ate}.`, { de, ate })
  }
  const dias = diasEntre(de, ate)
  // Cinco anos de dados num relatório de tela é sinal de erro de digitação, não
  // de intenção. O limite existe para não derrubar o banco por engano.
  if (dias > 366 * 5) {
    erro('PERIODO_LONGO', `Período de ${dias} dias é longo demais para um relatório de tela.`, {
      dias,
    })
  }
  return { de, ate, tipo: 'livre', rotulo: `${formatarBr(de)} a ${formatarBr(ate)}` }
}

/** Resolve o período a partir dos parâmetros da URL, com o mês como padrão. */
export function resolverPeriodo(
  hojeIso: string,
  parametros: { readonly tipo?: string; readonly de?: string; readonly ate?: string } = {},
): Periodo {
  const { tipo, de, ate } = parametros

  if (tipo === 'ano') return anoDe(hojeIso)
  if (tipo === 'trimestre') return trimestreDe(hojeIso)
  if (tipo === 'livre' || (de && ate)) {
    // Data inválida na URL cai no padrão em vez de estourar: a URL vem de fora e
    // um relatório não deve dar erro 500 por causa de um parâmetro editado.
    try {
      if (de && ate) return periodoLivre(de, ate)
    } catch {
      return mesDe(hojeIso)
    }
  }
  return mesDe(hojeIso)
}

/**
 * Período anterior equivalente, para a comparação.
 *
 * Para mês, trimestre e ano é o anterior do calendário — não "os mesmos N dias
 * para trás". Comparar julho com "os 31 dias anteriores" (1º de junho a 1º de
 * julho) misturaria dois meses e a variação não significaria nada.
 *
 * Para período livre, é a mesma quantidade de dias imediatamente antes, que é a
 * única definição possível quando não há mês nem ano de referência.
 */
export function periodoAnterior(p: Periodo): Periodo {
  if (p.tipo === 'mes') {
    const anterior = addMeses(p.de, -1)
    const { ano, mes } = parseData(anterior)
    return {
      de: `${ano}-${String(mes).padStart(2, '0')}-01`,
      ate: ultimoDiaDoMes(ano, mes),
      tipo: 'mes',
      rotulo: `${MESES[mes - 1]} de ${ano}`,
    }
  }

  if (p.tipo === 'trimestre') {
    const anterior = addMeses(p.de, -3)
    return trimestreDe(anterior)
  }

  if (p.tipo === 'ano') {
    const { ano } = parseData(p.de)
    return {
      de: `${ano - 1}-01-01`,
      ate: `${ano - 1}-12-31`,
      tipo: 'ano',
      rotulo: String(ano - 1),
    }
  }

  const dias = diasEntre(p.de, p.ate)
  const ate = addDias(p.de, -1)
  const de = addDias(ate, -(dias - 1))
  return { de, ate, tipo: 'livre', rotulo: `${formatarBr(de)} a ${formatarBr(ate)}` }
}

/** Dias no intervalo, contando as duas pontas. */
export function diasEntre(de: string, ate: string): number {
  const a = parseData(de)
  const b = parseData(ate)
  const ms =
    Date.UTC(b.ano, b.mes - 1, b.dia) - Date.UTC(a.ano, a.mes - 1, a.dia)
  return Math.round(ms / 86_400_000) + 1
}

/** Cada dia do período, em ordem. Base das séries diárias do painel. */
export function diasDoPeriodo(p: Periodo): readonly string[] {
  const dias: string[] = []
  let atual = p.de
  // Guarda contra período absurdo: `periodoLivre` já limita, mas esta função
  // também é chamada com períodos de calendário.
  for (let i = 0; i < 2000 && comparaData(atual, p.ate) <= 0; i++) {
    dias.push(atual)
    atual = addDias(atual, 1)
  }
  return dias
}

/**
 * Dia da semana de uma data civil. 0 = domingo.
 *
 * Usa `Date.UTC` de propósito: a data civil não tem fuso, e construir com
 * `new Date('2026-07-26')` já daria interpretação UTC — mas `new Date(2026, 6, 26)`
 * daria a do servidor. Explicitar evita o relatório mudar de dia da semana
 * conforme onde roda.
 */
export function diaSemanaDe(iso: string): number {
  const { ano, mes, dia } = parseData(iso)
  return new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay()
}

function formatarBr(iso: string): string {
  const { ano, mes, dia } = parseData(iso)
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`
}

export const FORMATAR_BR = formatarBr
