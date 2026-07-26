import { comparaData } from './datas'
import { deCentavos, paraCentavos } from './dinheiro'
import { erro } from './erros'

/**
 * Regras de convênio: cobertura, coparticipação e elegibilidade.
 *
 * Este é o arquivo com maior densidade de erro caro do projeto, e cada regra aqui
 * corresponde a um jeito conhecido de perder dinheiro:
 *
 * 1. **O preço é o da DATA DA EXECUÇÃO, não o de hoje.** Tabela negociada muda por
 *    reajuste anual. Faturar em março um procedimento feito em janeiro com o preço
 *    de março é glosa garantida — e, se o preço caiu, é prejuízo silencioso.
 *
 * 2. **Coparticipação e repasse somam EXATO.** São duas partes do mesmo valor. Se
 *    a divisão perder um centavo, ou a clínica cobra a menos do paciente para
 *    sempre, ou a soma dos itens não fecha com o total da guia e a operadora glosa
 *    a guia inteira.
 *
 * 3. **Carência conta da adesão do paciente, não da data do contrato da clínica.**
 *    Procedimento dentro da carência não é coberto: se for faturado, vem glosado e
 *    o paciente já foi embora achando que estava pago.
 *
 * 4. **Carteirinha vencida não é convênio.** É particular, e o paciente precisa
 *    saber ANTES do procedimento.
 */

// ── Preço vigente ────────────────────────────────────────────────────────────

export interface PrecoNegociado {
  readonly convenioId: string
  readonly procedimentoId: string
  /** Valor que a operadora paga pelo procedimento. */
  readonly valor: string
  /** Percentual coberto pela operadora. O resto é coparticipação. */
  readonly coberturaPct: string
  readonly carenciaDias: number
  readonly vigenciaInicio: string
  readonly vigenciaFim: string | null
}

/**
 * O preço vigente numa data.
 *
 * Entre dois preços que valem na mesma data — o que não deveria existir, mas o
 * banco só impede duplicata de `vigencia_inicio` —, vence o de início mais
 * recente. É a leitura certa: uma tabela nova assinada depois substitui a
 * anterior.
 */
export function precoVigenteEm(
  precos: readonly PrecoNegociado[],
  dataIso: string,
): PrecoNegociado | null {
  const validos = precos.filter(
    (p) =>
      comparaData(p.vigenciaInicio, dataIso) <= 0 &&
      (p.vigenciaFim === null || comparaData(dataIso, p.vigenciaFim) <= 0),
  )
  if (validos.length === 0) return null

  return validos.reduce((melhor, atual) =>
    comparaData(atual.vigenciaInicio, melhor.vigenciaInicio) > 0 ? atual : melhor,
  )
}

// ── Divisão entre operadora e paciente ───────────────────────────────────────

export interface Rateio {
  /** Valor total do item, na tabela do convênio. */
  readonly total: string
  /** Quanto a operadora deve pagar. */
  readonly convenio: string
  /** Quanto o paciente paga de coparticipação. */
  readonly paciente: string
}

/**
 * Divide o valor entre operadora e paciente.
 *
 * Em centavos inteiros, e a sobra do arredondamento vai para o **paciente**, não
 * para a operadora. A escolha é deliberada: pedir à operadora um centavo a mais do
 * que a regra de cobertura produz é motivo de glosa do item inteiro, e perder o
 * item por um centavo é o pior desfecho possível. Cobrar um centavo a mais do
 * paciente é um arredondamento que ninguém discute.
 */
export function ratearCobertura(valorTotal: string, coberturaPct: string): Rateio {
  const totalCentavos = paraCentavos(valorTotal)
  const pct = Number(coberturaPct)

  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    erro('COBERTURA_INVALIDA', `Percentual de cobertura fora da faixa: ${coberturaPct}.`, {
      coberturaPct,
    })
  }
  if (totalCentavos < 0) {
    erro('VALOR_NEGATIVO', `Valor do item não pode ser negativo: ${valorTotal}.`, { valorTotal })
  }

  // `floor` na parte da operadora: nunca pedir mais do que a conta dá.
  const doConvenio = Math.floor((totalCentavos * pct) / 100)
  const doPaciente = totalCentavos - doConvenio

  return {
    total: deCentavos(totalCentavos),
    convenio: deCentavos(doConvenio),
    paciente: deCentavos(doPaciente),
  }
}

// ── Elegibilidade ────────────────────────────────────────────────────────────

export interface CarteirinhaParaElegibilidade {
  readonly numeroCarteirinha: string
  readonly ativo: boolean
  readonly adesaoEm: string | null
  readonly validade: string | null
}

export type MotivoInelegivel =
  | 'sem_carteirinha'
  | 'carteirinha_inativa'
  | 'carteirinha_vencida'
  | 'dentro_da_carencia'
  | 'sem_preco_negociado'

export interface Elegibilidade {
  readonly elegivel: boolean
  readonly motivo: MotivoInelegivel | null
  /** Texto para a recepção dizer ao paciente ANTES do procedimento. */
  readonly explicacao: string | null
  /** Quando a carência termina, se for o caso. */
  readonly carenciaTerminaEm: string | null
}

/**
 * Se o procedimento pode ser faturado ao convênio naquela data.
 *
 * Devolve **motivo legível**, não um booleano seco: a recepção precisa explicar ao
 * paciente por que aquilo vai sair particular, e "não elegível" não é explicação.
 */
export function avaliarElegibilidade(p: {
  readonly carteirinha: CarteirinhaParaElegibilidade | null
  readonly preco: PrecoNegociado | null
  readonly dataIso: string
}): Elegibilidade {
  const { carteirinha, preco, dataIso } = p

  if (!carteirinha) {
    return {
      elegivel: false,
      motivo: 'sem_carteirinha',
      explicacao: 'O paciente não tem carteirinha cadastrada deste convênio.',
      carenciaTerminaEm: null,
    }
  }

  if (!carteirinha.ativo) {
    return {
      elegivel: false,
      motivo: 'carteirinha_inativa',
      explicacao: 'A carteirinha está marcada como inativa. Confirme com a operadora.',
      carenciaTerminaEm: null,
    }
  }

  if (carteirinha.validade !== null && comparaData(carteirinha.validade, dataIso) < 0) {
    return {
      elegivel: false,
      motivo: 'carteirinha_vencida',
      explicacao: `A carteirinha venceu em ${formatarBr(carteirinha.validade)}. O atendimento sai como particular até a renovação.`,
      carenciaTerminaEm: null,
    }
  }

  if (!preco) {
    return {
      elegivel: false,
      motivo: 'sem_preco_negociado',
      // É o caso mais comum de todos: o plano simplesmente não cobre aquilo.
      explicacao:
        'Este procedimento não está na tabela negociada com o convênio nesta data. Sai como particular.',
      carenciaTerminaEm: null,
    }
  }

  if (preco.carenciaDias > 0) {
    if (!carteirinha.adesaoEm) {
      return {
        elegivel: false,
        motivo: 'dentro_da_carencia',
        explicacao:
          `Este procedimento tem carência de ${preco.carenciaDias} dias e a data de adesão do paciente não está cadastrada. ` +
          'Sem ela não é possível afirmar que a carência já passou.',
        carenciaTerminaEm: null,
      }
    }

    const fim = somarDiasIso(carteirinha.adesaoEm, preco.carenciaDias)
    if (comparaData(dataIso, fim) < 0) {
      return {
        elegivel: false,
        motivo: 'dentro_da_carencia',
        explicacao: `Carência de ${preco.carenciaDias} dias termina em ${formatarBr(fim)}. Antes disso o convênio não cobre.`,
        carenciaTerminaEm: fim,
      }
    }
  }

  return { elegivel: true, motivo: null, explicacao: null, carenciaTerminaEm: null }
}

// ── Glosa ────────────────────────────────────────────────────────────────────

/**
 * Motivos de glosa que aparecem na prática.
 *
 * Não é a tabela oficial da ANS (Tabela 38, "Motivo de glosa") — essa tem
 * dezenas de códigos e precisa ser importada junto com a TUSS. Esta é a
 * classificação **operacional** da clínica: o que fazer a respeito. A distinção
 * importa porque a ação é diferente: erro de digitação se corrige e recorre;
 * procedimento não coberto se cobra do paciente.
 */
export type ClasseGlosa =
  /** Erro nosso no preenchimento. Corrige e recorre. */
  | 'erro_de_envio'
  /** A operadora diz que não cobre. Vira particular, ou se recorre com laudo. */
  | 'nao_coberto'
  /** Carência, carteirinha, elegibilidade. Confere cadastro. */
  | 'elegibilidade'
  /** Divergência de valor. Confere a tabela negociada. */
  | 'valor'
  /** Falta documento: laudo, radiografia, autorização prévia. */
  | 'falta_documento'
  /** Prazo de envio perdido. Normalmente irrecuperável. */
  | 'prazo'
  | 'outro'

export const ROTULO_CLASSE_GLOSA: Readonly<Record<ClasseGlosa, string>> = {
  erro_de_envio: 'Erro de preenchimento',
  nao_coberto: 'Procedimento não coberto',
  elegibilidade: 'Elegibilidade do beneficiário',
  valor: 'Divergência de valor',
  falta_documento: 'Falta documento',
  prazo: 'Prazo de envio',
  outro: 'Outro',
}

/**
 * O que fazer com uma glosa.
 *
 * Existe porque "recorrer de tudo" é o comportamento errado: recurso tem prazo e
 * custa tempo de alguém, e insistir em glosa de prazo perdido não devolve
 * dinheiro. Quem decide é a clínica; isto orienta.
 */
export function orientacaoDeGlosa(classe: ClasseGlosa): {
  readonly recorrer: boolean
  readonly orientacao: string
} {
  switch (classe) {
    case 'erro_de_envio':
      return {
        recorrer: true,
        orientacao: 'Corrija o dado apontado e recorra — este é o tipo de glosa que volta.',
      }
    case 'falta_documento':
      return {
        recorrer: true,
        orientacao: 'Anexe o documento pedido (laudo, radiografia) e recorra.',
      }
    case 'valor':
      return {
        recorrer: true,
        orientacao:
          'Confira a tabela negociada na data da execução. Se o nosso valor estiver certo, recorra com o contrato.',
      }
    case 'elegibilidade':
      return {
        recorrer: false,
        orientacao:
          'Confira carteirinha e carência no cadastro. Se o paciente realmente não tinha cobertura, o valor passa a ser dele.',
      }
    case 'nao_coberto':
      return {
        recorrer: false,
        orientacao:
          'Se o plano não cobre, o valor é do paciente — e ele precisa ser avisado antes de virar cobrança.',
      }
    case 'prazo':
      return {
        recorrer: false,
        orientacao:
          'Glosa por prazo raramente volta. Vale entender por que a guia atrasou para não repetir.',
      }
    default:
      return { recorrer: true, orientacao: 'Analise o motivo informado pela operadora.' }
  }
}

// ── Conciliação do repasse ───────────────────────────────────────────────────

export interface ItemParaConciliar {
  readonly id: string
  /** Quanto foi apresentado na guia. */
  readonly valorApresentado: string
  /** Quanto a operadora pagou. Ausente = não veio no repasse. */
  readonly valorPago: string | null
}

export interface Conciliacao {
  readonly totalApresentado: string
  readonly totalPago: string
  readonly totalGlosado: string
  readonly itensPagosIntegralmente: number
  readonly itensGlosadosParcialmente: number
  readonly itensGlosadosTotalmente: number
  readonly itensSemRetorno: number
}

/**
 * Confere o repasse item a item.
 *
 * **Item a item, nunca pelo total.** Um repasse que fecha no total pode conter dois
 * erros que se cancelam — um item pago a mais e outro glosado —, e conferir só a
 * soma esconde exatamente o que precisa ser recorrido. Foi por isso que a Fase 8
 * conciliou pagamento por parcela em vez de por cobrança.
 */
export function conciliarRepasse(itens: readonly ItemParaConciliar[]): Conciliacao {
  let apresentado = 0
  let pago = 0
  let integrais = 0
  let parciais = 0
  let totais = 0
  let semRetorno = 0

  for (const item of itens) {
    const a = paraCentavos(item.valorApresentado)
    apresentado += a

    if (item.valorPago === null) {
      semRetorno++
      continue
    }

    const p = paraCentavos(item.valorPago)
    pago += p

    if (p >= a) integrais++
    else if (p > 0) parciais++
    else totais++
  }

  return {
    totalApresentado: deCentavos(apresentado),
    totalPago: deCentavos(pago),
    // Glosa é o que foi apresentado e não veio — incluindo o que não retornou.
    totalGlosado: deCentavos(Math.max(0, apresentado - pago)),
    itensPagosIntegralmente: integrais,
    itensGlosadosParcialmente: parciais,
    itensGlosadosTotalmente: totais,
    itensSemRetorno: semRetorno,
  }
}

// ── Prazo de pagamento ───────────────────────────────────────────────────────

/**
 * Quando o repasse é esperado.
 *
 * Contado do **envio** da guia, não da execução: o contrato fala do protocolo. Uma
 * guia executada em janeiro e enviada em março vence em abril, e cobrar antes disso
 * queima relação com a operadora sem base contratual.
 */
export function previsaoDeRepasse(enviadoEmIso: string, prazoDias: number): string {
  if (!Number.isInteger(prazoDias) || prazoDias < 0) {
    erro('PRAZO_INVALIDO', `Prazo de pagamento inválido: ${prazoDias}.`, { prazoDias })
  }
  return somarDiasIso(enviadoEmIso, prazoDias)
}

/** Dias de atraso do repasse, ou 0 se ainda está no prazo. */
export function atrasoDoRepasse(previstoIso: string, hojeIso: string): number {
  if (comparaData(hojeIso, previstoIso) <= 0) return 0
  return diasEntreIso(previstoIso, hojeIso)
}

// ── Utilidades de data ───────────────────────────────────────────────────────

function somarDiasIso(iso: string, dias: number): string {
  const [ano, mes, dia] = iso.split('-').map(Number)
  if (!ano || !mes || !dia) erro('DATA_INVALIDA', `Data inválida: "${iso}".`, { iso })
  const d = new Date(Date.UTC(ano, mes - 1, dia + dias))
  return d.toISOString().slice(0, 10)
}

function diasEntreIso(de: string, ate: string): number {
  const [a1, m1, d1] = de.split('-').map(Number)
  const [a2, m2, d2] = ate.split('-').map(Number)
  const ms = Date.UTC(a2!, m2! - 1, d2!) - Date.UTC(a1!, m1! - 1, d1!)
  return Math.round(ms / 86_400_000)
}

function formatarBr(iso: string): string {
  return iso.split('-').reverse().join('/')
}
