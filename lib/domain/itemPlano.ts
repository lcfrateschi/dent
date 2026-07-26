import { type Face, exigirDente } from './dentes'
import { percentual, subtrair } from './dinheiro'
import { erro } from './erros'
import { exigirFacesValidas } from './faces'

export type StatusItemPlano =
  | 'proposto'
  | 'aprovado'
  | 'recusado'
  | 'executado'
  | 'faturado'
  | 'recebido'
  | 'glosado'
  | 'cancelado'

/**
 * Máquina de estados do item de plano — o caminho do dinheiro:
 *
 * proposto → aprovado → executado → faturado → recebido
 *      ↘ recusado                        ↘ glosado → faturado (recurso deferido)
 *      ↘ cancelado
 *
 * `glosado` é só de convênio (Fase 13) e não é terminal: cabe recurso, e um
 * recurso deferido volta o item para `faturado`.
 */
const TRANSICOES: Readonly<Record<StatusItemPlano, readonly StatusItemPlano[]>> = {
  proposto: ['aprovado', 'recusado', 'cancelado'],
  aprovado: ['executado', 'cancelado'],
  executado: ['faturado', 'cancelado'],
  faturado: ['recebido', 'glosado'],
  glosado: ['faturado', 'cancelado'],
  recebido: [],
  recusado: [],
  cancelado: [],
}

export function podeTransicionar(de: StatusItemPlano, para: StatusItemPlano): boolean {
  return TRANSICOES[de].includes(para)
}

export function exigirTransicao(de: StatusItemPlano, para: StatusItemPlano): void {
  if (!podeTransicionar(de, para)) {
    const possiveis = TRANSICOES[de]
    erro(
      'ITEM_TRANSICAO_INVALIDA',
      possiveis.length === 0
        ? `Item em "${de}" é estado final e não pode mudar.`
        : `Não é possível ir de "${de}" para "${para}". Possíveis: ${possiveis.join(', ')}.`,
      { de, para, possiveis },
    )
  }
}

/** Depois de executado o item entrou no prontuário — não se apaga, só se cancela com registro. */
export function podeExcluir(status: StatusItemPlano): boolean {
  return status === 'proposto'
}

export interface ProcedimentoRef {
  readonly id: string
  readonly nome: string
  readonly requerDente: boolean
  readonly requerFace: boolean
}

export interface ItemProposto {
  readonly procedimento: ProcedimentoRef
  readonly denteFdi?: number | null
  readonly faces?: readonly Face[] | null
}

/**
 * Coerência entre o catálogo e o que foi preenchido. O banco não consegue checar isto
 * num CHECK — `procedimento.requer_dente` está em outra tabela.
 */
export function exigirItemCoerente({ procedimento, denteFdi, faces }: ItemProposto): void {
  const temDente = denteFdi !== null && denteFdi !== undefined
  const listaFaces = faces ?? []

  // O catálogo em si tem que ser coerente. Sem isto, um procedimento cadastrado como
  // "por face mas não por dente" faria as faces passarem sem validação anatômica.
  // O banco impede via CHECK procedimento_face_implica_dente; aqui é a rede em memória.
  if (procedimento.requerFace && !procedimento.requerDente) {
    erro(
      'PROCEDIMENTO_INCOERENTE',
      `Catálogo inconsistente: "${procedimento.nome}" exige face mas não exige dente.`,
      { procedimentoId: procedimento.id },
    )
  }

  if (procedimento.requerDente && !temDente) {
    erro(
      'ITEM_SEM_DENTE',
      `"${procedimento.nome}" é um procedimento por dente — indique qual dente.`,
      { procedimentoId: procedimento.id },
    )
  }
  if (!procedimento.requerDente && temDente) {
    erro(
      'ITEM_DENTE_INDEVIDO',
      `"${procedimento.nome}" é um procedimento geral e não se aplica a um dente específico.`,
      { procedimentoId: procedimento.id, denteFdi },
    )
  }
  if (procedimento.requerFace && listaFaces.length === 0) {
    erro(
      'ITEM_SEM_FACE',
      `"${procedimento.nome}" exige indicar as faces atingidas.`,
      { procedimentoId: procedimento.id, denteFdi },
    )
  }
  if (!procedimento.requerFace && listaFaces.length > 0) {
    erro(
      'ITEM_FACE_INDEVIDA',
      `"${procedimento.nome}" não é por face — remova as faces indicadas.`,
      { procedimentoId: procedimento.id, faces: listaFaces },
    )
  }
  if (temDente) {
    exigirDente(denteFdi) // valida o código FDI
    if (listaFaces.length > 0) exigirFacesValidas(denteFdi, listaFaces)
  }
  // Faces sem dente não chega aqui: ou requerFace era falso (ITEM_FACE_INDEVIDA),
  // ou era verdadeiro e portanto requerDente também (ITEM_SEM_DENTE).
}

export interface PrecificacaoParticular {
  readonly cobertura: 'particular'
  /** `procedimento.valor_particular` */
  readonly valorTabela: string
}

export interface PrecificacaoConvenio {
  readonly cobertura: 'convenio'
  /** `preco_convenio.valor` */
  readonly valorConvenio: string
  /** `preco_convenio.cobertura_pct`, 0–100. */
  readonly coberturaPct: string
}

export interface ValorItem {
  /** Valor total da linha. */
  readonly valor: string
  /** Parte que o paciente paga: zero no particular integral, coparticipação no convênio. */
  readonly valorCoparticipacao: string
}

/**
 * Valor de um item conforme a cobertura.
 *
 * No convênio o `valor` é o negociado com a operadora e a coparticipação é a fatia
 * NÃO coberta, que o paciente paga direto à clínica. Cobertura de 100% → coparticipação zero.
 */
export function calcularValor(p: PrecificacaoParticular | PrecificacaoConvenio): ValorItem {
  if (p.cobertura === 'particular') {
    return { valor: p.valorTabela, valorCoparticipacao: '0.00' }
  }

  const pct = Number(p.coberturaPct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    erro('COBERTURA_INVALIDA', `Cobertura deve estar entre 0 e 100, recebido "${p.coberturaPct}".`, {
      coberturaPct: p.coberturaPct,
    })
  }

  const coberto = percentual(p.valorConvenio, p.coberturaPct)
  return {
    valor: p.valorConvenio,
    valorCoparticipacao: subtrair(p.valorConvenio, coberto),
  }
}
