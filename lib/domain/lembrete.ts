import { addDias } from './datas'
import { erro } from './erros'
import {
  FUSO_PADRAO,
  diaLocalIso,
  hhmmParaMinutos,
  instanteDe,
  minutosDoDia,
  minutosParaHhmm,
} from './fuso'

/**
 * Quando o lembrete deve sair.
 *
 * Parece trivial ("24 horas antes") e não é, por três motivos que só aparecem em
 * produção:
 *
 * 1. **Ninguém recebe mensagem de clínica às 3 da manhã.** Um atendimento às
 *    07:00 tem "24 horas antes" às 07:00 do dia anterior — ok. Um às 02:00 de
 *    plantão, não. E se o job atrasar e rodar de madrugada, o horário ideal já
 *    passou e a mensagem sai na hora errada. A janela é uma regra, não um
 *    detalhe de agendador.
 *
 * 2. **Agendamento marcado em cima da hora.** Paciente marca hoje às 16:00 para
 *    amanhã às 09:00: o instante "24h antes" está no passado. Mandar assim que
 *    possível é melhor que não mandar.
 *
 * 3. **Perto demais não vale a pena.** Faltando uma hora, o paciente não tem
 *    tempo de responder e a recepção não tem tempo de reagir à resposta. Aí a
 *    decisão honesta é *não enviar* e deixar claro que é caso de telefone — em
 *    vez de enfileirar uma mensagem inútil e registrar o lembrete como feito.
 *
 * Isto é uma função pura de (início do atendimento, agora, regra). Nenhuma
 * decisão de horário fica no agendador, que só executa o que já foi decidido.
 */

export interface RegraLembrete {
  /** Antecedência desejada, em horas. 24 = "no dia anterior, mesma hora". */
  readonly antecedenciaHoras: number
  /** Abaixo disto não há tempo de responder nem de reagir. Não envia. */
  readonly minimoHoras: number
  /** Primeiro horário local aceitável para enviar. */
  readonly janelaAbertura: string
  /** Último horário local aceitável para enviar. */
  readonly janelaFechamento: string
  readonly fuso: string
}

export const REGRA_PADRAO: RegraLembrete = {
  antecedenciaHoras: 24,
  minimoHoras: 3,
  janelaAbertura: '08:00',
  janelaFechamento: '20:00',
  fuso: FUSO_PADRAO,
}

export type MotivoEnvio =
  /** Saiu exatamente na antecedência pedida. */
  | 'ideal'
  /** A hora ideal caía fora da janela; empurrado para a próxima abertura. */
  | 'adiado_para_janela'
  /** A hora ideal já passou (agendamento em cima da hora); sai agora. */
  | 'imediato'

export type MotivoRecusa =
  /** O atendimento já começou ou já passou. */
  | 'ja_passou'
  /** Falta menos que o mínimo — não dá tempo de responder. */
  | 'muito_proximo'
  /** Não existe momento dentro da janela que ainda chegue em tempo útil. */
  | 'sem_janela_util'

export type DecisaoLembrete =
  | { readonly enviar: true; readonly quando: Date; readonly motivo: MotivoEnvio }
  | { readonly enviar: false; readonly motivo: MotivoRecusa }

const HORA_MS = 3_600_000

function validar(regra: RegraLembrete): { abertura: number; fechamento: number } {
  const abertura = hhmmParaMinutos(regra.janelaAbertura)
  const fechamento = hhmmParaMinutos(regra.janelaFechamento)
  if (abertura >= fechamento) {
    erro(
      'JANELA_INVALIDA',
      `Janela de envio inválida: ${regra.janelaAbertura}–${regra.janelaFechamento}.`,
      { regra },
    )
  }
  if (regra.antecedenciaHoras <= 0 || regra.minimoHoras < 0) {
    erro('REGRA_INVALIDA', 'Antecedência deve ser positiva e mínimo não negativo.', { regra })
  }
  if (regra.minimoHoras >= regra.antecedenciaHoras) {
    erro(
      'REGRA_INVALIDA',
      `Mínimo (${regra.minimoHoras}h) precisa ser menor que a antecedência (${regra.antecedenciaHoras}h).`,
      { regra },
    )
  }
  return { abertura, fechamento }
}

/** `true` se o instante cai dentro da janela local de envio. */
export function dentroDaJanela(instante: Date, regra: RegraLembrete = REGRA_PADRAO): boolean {
  const { abertura, fechamento } = validar(regra)
  const m = minutosDoDia(instante, regra.fuso)
  return m >= abertura && m <= fechamento
}

/**
 * Primeiro instante dentro da janela a partir de `instante` (ele mesmo, se já
 * estiver dentro). Antes da abertura sobe para a abertura do mesmo dia; depois
 * do fechamento pula para a abertura do dia seguinte.
 */
export function proximaJanela(instante: Date, regra: RegraLembrete = REGRA_PADRAO): Date {
  const { abertura, fechamento } = validar(regra)
  const m = minutosDoDia(instante, regra.fuso)
  const dia = diaLocalIso(instante, regra.fuso)

  if (m < abertura) return instanteDe(dia, minutosParaHhmm(abertura), regra.fuso)
  if (m > fechamento) {
    return instanteDe(addDias(dia, 1), minutosParaHhmm(abertura), regra.fuso)
  }
  return instante
}

/**
 * Decide se e quando enviar o lembrete de um atendimento.
 *
 * `agora` é parâmetro, não `new Date()` — é o que permite testar a virada da
 * janela e a madrugada sem depender do relógio da máquina.
 */
export function quandoEnviarLembrete(
  inicioAtendimento: Date,
  agora: Date,
  regra: RegraLembrete = REGRA_PADRAO,
): DecisaoLembrete {
  validar(regra)

  const inicio = inicioAtendimento.getTime()
  const t = agora.getTime()
  if (Number.isNaN(inicio) || Number.isNaN(t)) {
    erro('DATA_INVALIDA', 'Instante inválido na decisão de lembrete.')
  }

  if (inicio <= t) return { enviar: false, motivo: 'ja_passou' }

  // Último instante em que a mensagem ainda serve para algo.
  const limite = inicio - regra.minimoHoras * HORA_MS
  if (limite <= t) return { enviar: false, motivo: 'muito_proximo' }

  const ideal = inicio - regra.antecedenciaHoras * HORA_MS

  // Marcado em cima da hora: o ideal está no passado, então é "agora".
  const base = ideal <= t ? agora : new Date(ideal)
  const imediato = ideal <= t

  const quando = proximaJanela(base, regra)

  // A janela pode ter empurrado para depois do último instante útil — por
  // exemplo, atendimento amanhã às 09:00 decidido hoje às 22:00 com janela até
  // 20:00: a próxima abertura é amanhã às 08:00, uma hora antes. Não envia; é
  // caso de telefone, e dizer isso é mais útil que enfileirar.
  if (quando.getTime() > limite) return { enviar: false, motivo: 'sem_janela_util' }

  if (imediato && quando.getTime() === agora.getTime()) {
    return { enviar: true, quando, motivo: 'imediato' }
  }
  if (quando.getTime() !== base.getTime() || imediato) {
    return { enviar: true, quando, motivo: 'adiado_para_janela' }
  }
  return { enviar: true, quando, motivo: 'ideal' }
}

export const ROTULO_MOTIVO: Readonly<Record<MotivoEnvio | MotivoRecusa, string>> = {
  ideal: 'No horário previsto',
  adiado_para_janela: 'Adiado para o horário permitido',
  imediato: 'Enviado assim que possível',
  ja_passou: 'Atendimento já ocorreu',
  muito_proximo: 'Muito próximo — ligar para o paciente',
  sem_janela_util: 'Sem horário permitido em tempo útil — ligar para o paciente',
}
