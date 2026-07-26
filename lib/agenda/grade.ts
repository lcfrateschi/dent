import { type DiaSemana, type HorarioFuncionamento, limitesDaGrade } from '@/lib/domain/horario'
import { addDias } from '@/lib/domain/datas'
import { diaLocalIso, minutosDoDia } from '@/lib/domain/fuso'

/**
 * Layout da grade da agenda. Módulo **puro** — sem React, sem banco.
 *
 * O bug silencioso que este arquivo existe para evitar: dois cartões
 * desenhados um sobre o outro. O banco impede sobreposição de agendamento ativo
 * por profissional e por cadeira (EXCLUDE constraints), mas a tela ainda mostra
 * cancelados e faltas, que PODEM se sobrepor a um ativo — o horário foi
 * liberado e reocupado. Sem empacotamento em faixas, um esconde o outro.
 */

export interface ItemGrade {
  readonly id: string
  readonly inicio: Date
  readonly fim: Date
}

export interface PosicaoCartao {
  readonly id: string
  /** Faixa horizontal, base 0, dentro do grupo de sobreposição. */
  readonly faixa: number
  /** Quantas faixas o grupo ocupa — define a largura do cartão. */
  readonly deFaixas: number
  /** Distância do topo da grade, em minutos. */
  readonly topoMin: number
  /** Altura em minutos. Nunca menor que `alturaMinimaMin`. */
  readonly alturaMin: number
}

/** Um atendimento de 15 min ainda precisa de área clicável e texto legível. */
const ALTURA_MINIMA_MIN = 20

/**
 * Distribui itens sobrepostos em faixas lado a lado.
 *
 * Duas etapas:
 *   1. **Grupos** — itens ligados por sobreposição transitiva (A cobre B, B
 *      cobre C ⇒ os três no mesmo grupo). O grupo é a unidade de largura: sem
 *      isso, A e C ficariam com larguras diferentes e o alinhamento quebra.
 *   2. **Faixas** — dentro do grupo, cada item vai para a primeira faixa cujo
 *      último item já terminou.
 */
export function empacotarFaixas(
  itens: readonly ItemGrade[],
  opcoes: { readonly inicioGradeMin: number; readonly fuso: string; readonly alturaMinimaMin?: number },
): readonly PosicaoCartao[] {
  const alturaMinima = opcoes.alturaMinimaMin ?? ALTURA_MINIMA_MIN

  const normalizados = itens
    .map((i) => ({
      id: i.id,
      inicioMin: minutosDoDia(i.inicio, opcoes.fuso),
      fimMin: minutosDoDia(i.fim, opcoes.fuso),
    }))
    // Ordem estável: por início e, no empate, por fim — o mais longo primeiro
    // fica na faixa da esquerda, que é onde o olho procura.
    .sort((a, b) => a.inicioMin - b.inicioMin || b.fimMin - a.fimMin || a.id.localeCompare(b.id))

  const saida: PosicaoCartao[] = []
  let grupo: typeof normalizados = []
  let fimDoGrupo = Number.NEGATIVE_INFINITY

  const fecharGrupo = (): void => {
    if (grupo.length === 0) return

    // Fim de cada faixa, para saber onde o próximo item cabe.
    const fimDaFaixa: number[] = []
    const faixaDoItem = new Map<string, number>()

    for (const item of grupo) {
      let faixa = fimDaFaixa.findIndex((fim) => fim <= item.inicioMin)
      if (faixa === -1) {
        faixa = fimDaFaixa.length
        fimDaFaixa.push(item.fimMin)
      } else {
        fimDaFaixa[faixa] = item.fimMin
      }
      faixaDoItem.set(item.id, faixa)
    }

    const deFaixas = fimDaFaixa.length
    for (const item of grupo) {
      saida.push({
        id: item.id,
        faixa: faixaDoItem.get(item.id) ?? 0,
        deFaixas,
        topoMin: item.inicioMin - opcoes.inicioGradeMin,
        alturaMin: Math.max(alturaMinima, item.fimMin - item.inicioMin),
      })
    }
    grupo = []
    fimDoGrupo = Number.NEGATIVE_INFINITY
  }

  for (const item of normalizados) {
    // Item que começa depois do fim de tudo no grupo abre um grupo novo.
    if (item.inicioMin >= fimDoGrupo) fecharGrupo()
    grupo.push(item)
    fimDoGrupo = Math.max(fimDoGrupo, item.fimMin)
  }
  fecharGrupo()

  return saida
}

// ── Semana ───────────────────────────────────────────────────────────────────

export interface DiaDaGrade {
  /** 'YYYY-MM-DD' local. */
  readonly iso: string
  readonly diaSemana: DiaSemana
  readonly aberto: boolean
  readonly ehHoje: boolean
}

export interface EstruturaGrade {
  readonly dias: readonly DiaDaGrade[]
  readonly inicioMin: number
  readonly fimMin: number
  readonly alturaMin: number
  /** Marcas de hora para o eixo vertical. */
  readonly marcas: readonly number[]
}

/** Segunda-feira da semana que contém o dia informado. */
export function inicioDaSemana(diaIso: string): string {
  const d = new Date(`${diaIso}T00:00:00Z`)
  const dow = d.getUTCDay()
  // Domingo (0) pertence à semana que começou na segunda anterior.
  const recuo = dow === 0 ? 6 : dow - 1
  return addDias(diaIso, -recuo)
}

/**
 * Monta a estrutura da grade.
 *
 * `diasVisiveis` permite esconder os dias fechados: mostrar uma coluna de
 * domingo vazia em toda semana só rouba largura das colunas úteis.
 */
export function estruturaDaSemana({
  segundaIso,
  horario,
  hojeIso,
  incluirFechados = false,
}: {
  segundaIso: string
  horario: HorarioFuncionamento
  hojeIso: string
  incluirFechados?: boolean
}): EstruturaGrade {
  const todos: DiaDaGrade[] = Array.from({ length: 7 }, (_, i) => {
    const iso = addDias(segundaIso, i)
    const diaSemana = new Date(`${iso}T00:00:00Z`).getUTCDay() as DiaSemana
    return {
      iso,
      diaSemana,
      aberto: (horario[String(diaSemana)] ?? []).length > 0,
      ehHoje: iso === hojeIso,
    }
  })

  const dias = incluirFechados ? todos : todos.filter((d) => d.aberto || d.ehHoje)
  const { inicioMin, fimMin } = limitesDaGrade(
    horario,
    dias.map((d) => d.diaSemana),
  )

  return {
    dias,
    inicioMin,
    fimMin,
    alturaMin: fimMin - inicioMin,
    marcas: marcasDeHora(inicioMin, fimMin),
  }
}

/** Estrutura de um único dia — a visão que a recepção usa no balcão. */
export function estruturaDoDia({
  diaIso,
  horario,
  hojeIso,
}: {
  diaIso: string
  horario: HorarioFuncionamento
  hojeIso: string
}): EstruturaGrade {
  const diaSemana = new Date(`${diaIso}T00:00:00Z`).getUTCDay() as DiaSemana
  const dia: DiaDaGrade = {
    iso: diaIso,
    diaSemana,
    aberto: (horario[String(diaSemana)] ?? []).length > 0,
    ehHoje: diaIso === hojeIso,
  }
  const { inicioMin, fimMin } = limitesDaGrade(horario, [diaSemana])

  return {
    dias: [dia],
    inicioMin,
    fimMin,
    alturaMin: fimMin - inicioMin,
    marcas: marcasDeHora(inicioMin, fimMin),
  }
}

/** Horas cheias dentro dos limites, incluindo a de fechamento. */
function marcasDeHora(inicioMin: number, fimMin: number): readonly number[] {
  const marcas: number[] = []
  const primeira = Math.ceil(inicioMin / 60) * 60
  for (let m = primeira; m <= fimMin; m += 60) marcas.push(m)
  return marcas
}

/**
 * Agrupa itens por dia local. A chave é o dia do INÍCIO: um atendimento não
 * atravessa a meia-noite num consultório, e se atravessar aparece no dia em
 * que começou, que é onde a recepção vai procurar.
 */
export function agruparPorDia<T extends ItemGrade>(
  itens: readonly T[],
  fuso: string,
): ReadonlyMap<string, readonly T[]> {
  const mapa = new Map<string, T[]>()
  for (const item of itens) {
    const chave = diaLocalIso(item.inicio, fuso)
    const lista = mapa.get(chave)
    if (lista) lista.push(item)
    else mapa.set(chave, [item])
  }
  return mapa
}

/**
 * Posição da linha do "agora" na grade, ou `null` se estiver fora dela.
 * Referência visual mais usada pela recepção: mostra o que já passou.
 */
export function posicaoDoAgora({
  agora,
  diaIso,
  inicioMin,
  fimMin,
  fuso,
}: {
  agora: Date
  diaIso: string
  inicioMin: number
  fimMin: number
  fuso: string
}): number | null {
  if (diaLocalIso(agora, fuso) !== diaIso) return null
  const min = minutosDoDia(agora, fuso)
  if (min < inicioMin || min > fimMin) return null
  return min - inicioMin
}
