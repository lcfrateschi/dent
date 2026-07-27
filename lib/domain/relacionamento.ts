import { addDias, addMeses } from './datas'
import { erro } from './erros'

/**
 * Regras puras das filas de relacionamento.
 *
 * O que mora aqui é o que decide **se** e **quando** falar com alguém — e por que
 * não falar. Nada disto toca banco, porque nada disto depende de banco: são
 * decisões da clínica que precisam de teste rápido e de revisão por quem entende
 * do assunto, não de um Postgres de pé.
 */

export type TipoTarefa =
  | 'orcamento_sem_resposta'
  | 'inadimplencia'
  | 'aprovado_nao_executado'
  | 'falta_sem_remarcar'
  | 'retorno_programado'

export type SituacaoTarefa = 'aberta' | 'em_andamento' | 'resolvida' | 'dispensada'

export type ResultadoContato = 'falou' | 'nao_atendeu' | 'numero_errado' | 'remarcou' | 'nao_quer'

// ── A chave de idempotência ──────────────────────────────────────────────────

/**
 * A chave que impede a fila de duplicar — e de **reabrir o que foi dispensado**.
 *
 * ── O detalhe que decide tudo ──────────────────────────────────────────────
 * A chave é uma por FATO gerador, não uma por tarefa aberta. `orcamento:{id}`
 * existe uma vez na história daquele orçamento, e é isso que faz o `ON CONFLICT DO
 * NOTHING` do gerador colidir com a tarefa **dispensada** e não inserir nada.
 *
 * O gerador ingênuo — "existe tarefa aberta para este orçamento? se não, cria" —
 * passaria em qualquer teste de idempotência que rodasse duas vezes seguidas, e
 * falharia no cenário que importa: a recepção dispensa ("paciente disse que não
 * quer"), o job roda de novo daqui a dez minutos, a tarefa volta, e alguém liga
 * outra vez. O paciente não vê um bug de software; vê uma clínica que não escuta.
 *
 * ── Por que NÃO leva data ──────────────────────────────────────────────────
 * `chaveLembrete` (mensageria) inclui o início do atendimento de propósito:
 * remarcar deve gerar lembrete novo. Aqui é o oposto — a segunda chance de falar
 * do mesmo orçamento não é um fato novo, é insistência. Sem data na chave, cada
 * fato gera **uma** tarefa e uma só.
 */
export function chaveDaTarefa(tipo: TipoTarefa, referenciaId: string): string {
  if (referenciaId.trim().length === 0) {
    erro('REFERENCIA_OBRIGATORIA', 'Tarefa de relacionamento precisa da referência que a gerou.')
  }
  return `${tipo}:${referenciaId}`
}

// ── Prazos ───────────────────────────────────────────────────────────────────

/**
 * Quantos dias a clínica espera antes de cobrar cada coisa.
 *
 * São padrões de partida, no espírito dos mínimos de estoque: a ordem de grandeza
 * de um consultório de duas cadeiras. O número certo sai do uso.
 */
export const PRAZOS_EM_DIAS: Readonly<Record<TipoTarefa, number>> = {
  /** Orçamento enviado sem resposta: uma semana é o intervalo em que ligar ainda
   *  soa como atenção, e não como cobrança. */
  orcamento_sem_resposta: 7,
  /** Parcela vencida: três dias evita ligar por causa de um boleto que cruzou o
   *  fim de semana. */
  inadimplencia: 3,
  /** Aprovado e não executado: trinta dias. Antes disso o paciente ainda está
   *  organizando a agenda dele. */
  aprovado_nao_executado: 30,
  /** Faltou: dois dias. Passa disso, a conversa deixa de ser "o que aconteceu?" e
   *  passa a ser cobrança de horário perdido. */
  falta_sem_remarcar: 2,
  /** Retorno programado: o prazo é a data devida, sem folga — ela já é o próprio
   *  intervalo clínico. */
  retorno_programado: 0,
}

/** Rótulos da tela. Aqui porque a fila e o relatório precisam dos mesmos. */
export const ROTULO_DO_TIPO: Readonly<Record<TipoTarefa, string>> = {
  orcamento_sem_resposta: 'Orçamento sem resposta',
  inadimplencia: 'Parcela vencida',
  aprovado_nao_executado: 'Aprovado e não executado',
  falta_sem_remarcar: 'Faltou e não remarcou',
  retorno_programado: 'Retorno programado',
}

/**
 * Quando o paciente deve ser chamado de volta, a partir da execução.
 *
 * `addMeses` e não "× 30 dias": raspagem feita em 31 de janeiro com retorno de um
 * mês é 28 de fevereiro, não 2 de março. Dia civil, no calendário — é assim que a
 * clínica conta, e `lib/domain/datas.ts` já resolve o mês curto.
 */
export function dataDoRetorno(executadoEmIso: string, meses: number): string {
  if (!Number.isInteger(meses) || meses < 1) {
    erro('MESES_INVALIDO', `Intervalo de retorno inválido: ${meses}.`, { meses })
  }
  return addMeses(executadoEmIso, meses)
}

/** O prazo da tarefa, a partir do dia do fato. */
export function prazoDaTarefa(tipo: TipoTarefa, dataDoFatoIso: string): string {
  return addDias(dataDoFatoIso, PRAZOS_EM_DIAS[tipo])
}

// ── Não incomodar duas vezes ─────────────────────────────────────────────────

/**
 * O paciente pode ser contatado hoje?
 *
 * `naoContatarAte` é um dia civil **inclusivo**: pedir "não me liguem até dia 30"
 * significa que dia 30 ainda não. Fazer a comparação exclusiva economizaria um
 * caractere e produziria uma ligação no dia em que a pessoa pediu para não receber
 * — que é o único dia em que ela vai lembrar do pedido.
 */
export function podeContatar(naoContatarAte: string | null, hojeIso: string): boolean {
  if (naoContatarAte === null) return true
  return hojeIso > naoContatarAte
}

/**
 * O resultado do contato encerra a fila para este paciente?
 *
 * `nao_quer` e `numero_errado` são os dois casos em que insistir é pior que
 * desistir — o primeiro porque a pessoa pediu, o segundo porque não é ela quem
 * atende. Os dois viram `dispensada`; os outros mantêm a tarefa em andamento.
 */
export function contatoEncerra(resultado: ResultadoContato): boolean {
  return resultado === 'nao_quer' || resultado === 'numero_errado'
}

/** `remarcou` é o único resultado que resolve a tarefa: o objetivo foi cumprido. */
export function contatoResolve(resultado: ResultadoContato): boolean {
  return resultado === 'remarcou'
}

// ── Transições ───────────────────────────────────────────────────────────────

export type ResultadoTransicao =
  | { readonly ok: true; readonly situacao: SituacaoTarefa }
  | { readonly ok: false; readonly motivo: string }

/**
 * Uma tarefa fechada não volta a abrir por ação de tela.
 *
 * Não é rigidez: `resolvida` e `dispensada` são as duas situações que a chave de
 * idempotência usa como "já tratamos disto". Reabrir por clique deixaria a fila
 * com uma tarefa aberta cuja chave já existe — e o gerador, que é o dono da
 * criação, não teria como saber disso. Se for preciso falar de novo com o
 * paciente, o caminho é registrar um contato novo, que a tarefa aceita em
 * qualquer situação.
 */
export function podeTransitar(de: SituacaoTarefa, para: SituacaoTarefa): ResultadoTransicao {
  if (de === para) return { ok: true, situacao: para }
  if (de === 'resolvida' || de === 'dispensada') {
    return {
      ok: false,
      motivo: `Tarefa já ${de === 'resolvida' ? 'resolvida' : 'dispensada'} — não reabre. Registre um contato novo se precisar falar de novo.`,
    }
  }
  if (para === 'aberta' && de === 'em_andamento') return { ok: true, situacao: 'aberta' }
  if (para === 'em_andamento' || para === 'resolvida' || para === 'dispensada') {
    return { ok: true, situacao: para }
  }
  return { ok: false, motivo: `Transição inválida: ${de} → ${para}.` }
}

/** Dispensar exige motivo — o CHECK do banco cobra a mesma coisa. */
export function exigirMotivoDeDispensa(motivo: string | null | undefined): string {
  const limpo = (motivo ?? '').trim()
  if (limpo.length < 3) {
    erro(
      'MOTIVO_OBRIGATORIO',
      'Dispensar exige motivo: sem ele, "não insista" fica indistinguível de clique errado.',
    )
  }
  return limpo
}

// ── Atraso, para a tela ordenar e colorir ────────────────────────────────────

export type UrgenciaDaTarefa = 'no_prazo' | 'vence_hoje' | 'atrasada'

export function urgenciaDaTarefa(prazoIso: string, hojeIso: string): UrgenciaDaTarefa {
  if (prazoIso < hojeIso) return 'atrasada'
  if (prazoIso === hojeIso) return 'vence_hoje'
  return 'no_prazo'
}
