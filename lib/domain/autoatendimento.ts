import { erro } from './erros'

/**
 * Regras do autoatendimento: o que o paciente pode fazer sozinho.
 *
 * Puras e testadas, como toda regra de domínio. A server action valida entrada,
 * chama isto, e persiste — ela não decide.
 *
 * ── O princípio que orienta as três regras ──────────────────────────────────
 * O paciente marcando sozinho é conveniência para ele e risco para a agenda. As
 * regras aqui existem para limitar o risco sem transformar o autoatendimento em
 * formulário de pedido — se toda marcação precisar de confirmação humana, o ganho
 * desaparece e a recepção passa a ter mais trabalho, não menos.
 *
 * Então: o paciente marca de verdade (o horário fica ocupado na hora), e o que
 * protege a clínica é **o que ele pode marcar**, não uma fila de aprovação.
 */

/** Configuração por clínica. Todos os limites são decisão da clínica, não do código. */
export interface RegraAutoatendimento {
  /** Desligado, o portal volta a dizer "fale com a clínica". */
  readonly ativo: boolean
  /**
   * Antecedência MÍNIMA em horas.
   *
   * Existe para o paciente não marcar para dentro de meia hora: ninguém prepara a
   * sala, e a agenda do dia já foi organizada. Zero seria "pode marcar agora",
   * que é o caso de uso do encaixe — e encaixe é a recepção que faz.
   */
  readonly antecedenciaMinimaHoras: number
  /**
   * Antecedência MÁXIMA em dias.
   *
   * Limita o horizonte: marcação para oito meses à frente atravessa mudança de
   * horário de funcionamento, férias e reajuste, e quase sempre vira falta.
   */
  readonly antecedenciaMaximaDias: number
  /**
   * Teto de agendamentos FUTUROS por paciente.
   *
   * A trava contra o dano bobo: uma sessão descuidada (ou um script) marcando vinte
   * horários e sumindo. Não é sobre má-fé — é que sem teto o custo de um erro é a
   * agenda de uma semana.
   */
  readonly maximoFuturosPorPaciente: number
}

export const REGRA_PADRAO: RegraAutoatendimento = {
  // **Desligado por padrão**, e isto é escolha. Uma clínica que atualiza o sistema
  // não deve descobrir que a agenda dela abriu para a internet — recurso que muda
  // quem pode escrever na agenda começa desligado e é ligado por decisão.
  ativo: false,
  antecedenciaMinimaHoras: 24,
  antecedenciaMaximaDias: 60,
  maximoFuturosPorPaciente: 2,
}

export type MotivoRecusa =
  | 'desligado'
  | 'procedimento_nao_liberado'
  | 'antecedencia_minima'
  | 'antecedencia_maxima'
  | 'teto_de_futuros'
  | 'horario_indisponivel'

export interface PedidoDeAgendamento {
  readonly inicio: Date
  readonly agora: Date
  /** `true` quando o catálogo marca o procedimento como liberado para o portal. */
  readonly procedimentoLiberado: boolean
  /** Quantos agendamentos futuros ativos o paciente já tem. */
  readonly futurosDoPaciente: number
  readonly regra: RegraAutoatendimento
}

export interface Recusa {
  readonly motivo: MotivoRecusa
  /** Texto para o paciente. Nunca menciona outro paciente nem a ocupação da agenda. */
  readonly mensagem: string
}

const HORA_MS = 3_600_000
const DIA_MS = 24 * HORA_MS

/**
 * Decide se o paciente pode marcar. Devolve `null` quando pode.
 *
 * ── Por que devolve o motivo, e por que a mensagem vive aqui ────────────────
 * A UI precisa dizer POR QUE não deu, senão o paciente tenta de novo no mesmo
 * horário. E a mensagem fica no domínio porque ela é parte da regra: "só posso
 * marcar com 24 h de antecedência" é a regra explicada, e duplicá-la na tela é como
 * as duas divergem.
 *
 * ── A ordem das checagens não é arbitrária ──────────────────────────────────
 * Do mais geral para o mais específico, para a mensagem ser a mais útil: quem tenta
 * marcar com o recurso desligado não deve ler sobre antecedência.
 */
export function avaliarPedido(p: PedidoDeAgendamento): Recusa | null {
  const { regra } = p

  if (!regra.ativo) {
    return {
      motivo: 'desligado',
      mensagem: 'Esta clínica ainda não abriu o agendamento pelo portal. Fale com a recepção.',
    }
  }

  if (!p.procedimentoLiberado) {
    return {
      motivo: 'procedimento_nao_liberado',
      // Sem detalhar o motivo clínico: "este procedimento exige avaliação" é
      // verdadeiro e não expõe a lista interna de quais são.
      mensagem:
        'Este atendimento precisa ser combinado com a clínica antes de marcar. Fale com a recepção.',
    }
  }

  const antecedenciaMs = p.inicio.getTime() - p.agora.getTime()

  if (antecedenciaMs < regra.antecedenciaMinimaHoras * HORA_MS) {
    return {
      motivo: 'antecedencia_minima',
      mensagem:
        regra.antecedenciaMinimaHoras >= 24
          ? `Marque com pelo menos ${Math.round(regra.antecedenciaMinimaHoras / 24)} dia(s) de antecedência. Para hoje ou amanhã, fale com a recepção.`
          : `Marque com pelo menos ${regra.antecedenciaMinimaHoras} hora(s) de antecedência.`,
    }
  }

  if (antecedenciaMs > regra.antecedenciaMaximaDias * DIA_MS) {
    return {
      motivo: 'antecedencia_maxima',
      mensagem: `Por aqui dá para marcar até ${regra.antecedenciaMaximaDias} dias à frente.`,
    }
  }

  if (p.futurosDoPaciente >= regra.maximoFuturosPorPaciente) {
    return {
      motivo: 'teto_de_futuros',
      mensagem: `Você já tem ${p.futurosDoPaciente} consulta(s) marcada(s). Para marcar outra, fale com a recepção.`,
    }
  }

  return null
}

/**
 * A janela de dias que a tela oferece.
 *
 * Derivada da mesma regra, para a grade não mostrar dia que o `avaliarPedido` vai
 * recusar — oferecer e depois recusar é a pior combinação, porque o paciente escolhe
 * um horário e leva um "não" que parece defeito.
 */
export function janelaDeDias(
  regra: RegraAutoatendimento,
  agora: Date,
): { readonly de: Date; readonly ate: Date } {
  return {
    de: new Date(agora.getTime() + regra.antecedenciaMinimaHoras * HORA_MS),
    ate: new Date(agora.getTime() + regra.antecedenciaMaximaDias * DIA_MS),
  }
}

/**
 * O paciente pode desmarcar o que ELE marcou?
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  Esta é a decisão mais delicada da fase, porque parece contradizer uma
 *  decisão fechada — e não contradiz.
 *
 *  A decisão fechada é: **"Não vou poder ir" no portal NÃO cancela o
 *  agendamento.** O motivo escrito é duplo: um toque errado no celular não pode
 *  custar o horário do paciente, e a clínica precisa saber para remarcar.
 *
 *  Os dois motivos pressupõem um agendamento que **a clínica** organizou. Para
 *  um horário que o paciente acabou de criar sozinho, nenhum dos dois vale:
 *
 *   • não há horário a perder que ele não tenha escolhido segundos antes;
 *   • a clínica não organizou nada em volta dele.
 *
 *  E há um custo em não deixar: quem marca errado e não pode desmarcar liga para
 *  a recepção — ou seja, o autoatendimento gera a ligação que existia para
 *  evitar. Pior, o horário fica ocupado por um atendimento que não vai acontecer,
 *  bloqueando quem queria marcar.
 *
 *  Então a permissão é **estreita**, e cada condição responde a um dos motivos
 *  da decisão original:
 *
 *   1. `origem === 'portal'` — só o que o paciente marcou. Horário dado pela
 *      recepção segue no caminho de "avisar".
 *   2. `status === 'agendado'` — a clínica ainda não confirmou. Confirmado
 *      significa que alguém do outro lado já contou com aquele horário.
 *   3. ainda dentro da antecedência mínima — dentro dela, a agenda do dia já foi
 *      organizada, e é aí que a clínica "precisa saber".
 *
 *  Fora dessas três, a resposta continua sendo avisar a recepção.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function podeDesmarcarSozinho(p: {
  readonly origem: string
  readonly status: string
  readonly inicio: Date
  readonly agora: Date
  readonly regra: RegraAutoatendimento
}): boolean {
  if (p.origem !== 'portal') return false
  if (p.status !== 'agendado') return false
  return p.inicio.getTime() - p.agora.getTime() >= p.regra.antecedenciaMinimaHoras * HORA_MS
}

// ── Assinatura eletrônica ────────────────────────────────────────────────────

/**
 * O nível da assinatura que este sistema produz. **Um só, e é de propósito.**
 *
 * ⚖️ Hash do texto + IP + `user_agent` + instante do aceite, gravados em
 * `consentimento`, é **assinatura eletrônica simples** na classificação da
 * MP 2.200-2/2001 (art. 10, §2º): vale entre as partes que a admitem como válida, e
 * é o que um termo de consentimento entre clínica e paciente precisa.
 *
 * **Não é** assinatura avançada nem qualificada: não há certificado ICP-Brasil, não
 * há carimbo de tempo de terceiro, e nada aqui prova a identidade do signatário além
 * do controle da conta do portal — que é e-mail e senha, sem segundo fator, por
 * decisão (ver CLAUDE.md).
 *
 * O nível é gravado **na linha**, não deduzido do código, porque a pergunta que
 * importa aparece anos depois, num litígio, sobre uma linha específica: "com que
 * nível isto foi assinado?". Se a resposta dependesse de qual versão do código
 * estava no ar naquele dia, não haveria resposta.
 *
 * ⚖️ **Advogado decide** se este nível basta para cada finalidade — em especial
 * consentimento para procedimento invasivo, onde a prática corrente é papel
 * assinado na clínica. O sistema não impede o papel: `consentimento` aceita as duas
 * origens.
 */
export const NIVEL_ASSINATURA = 'eletronica_simples' as const

/** Finalidades que o paciente pode assinar pelo portal. */
export const FINALIDADES_DO_PORTAL = {
  anamnese: 'anamnese_autodeclarada',
  termoDeAtendimento: 'termo_de_atendimento',
  politicaDePrivacidade: 'politica_de_privacidade',
} as const

export type FinalidadeDoPortal =
  (typeof FINALIDADES_DO_PORTAL)[keyof typeof FINALIDADES_DO_PORTAL]

/**
 * Quem assina: o próprio paciente, ou o responsável legal.
 *
 * **Menor não assina o próprio termo.** `paciente.responsavel_legal_id` existe desde
 * a Fase 1 e é ele quem tem conta no portal — então a sessão do responsável assina
 * PELO menor, e a linha registra os dois lados (`paciente_id` = o menor,
 * `assinado_por_id` = quem assinou).
 *
 * A função é pura e recebe a idade já calculada porque "quem é menor" depende do dia
 * civil no fuso da clínica, e essa conversão é do chamador — misturar as duas coisas
 * aqui faria o teste depender do relógio.
 */
export function quemAssina(p: {
  readonly pacienteId: string
  readonly responsavelLegalId: string | null
  readonly ehMenor: boolean
  /** Paciente dono da sessão que está assinando. */
  readonly sessaoPacienteId: string
}): { readonly pacienteId: string; readonly assinadoPorId: string | null } {
  if (!p.ehMenor) {
    if (p.sessaoPacienteId !== p.pacienteId) {
      erro(
        'ASSINATURA_DE_TERCEIRO',
        'Só o próprio paciente assina o termo dele.',
      )
    }
    return { pacienteId: p.pacienteId, assinadoPorId: null }
  }

  if (!p.responsavelLegalId) {
    erro(
      'MENOR_SEM_RESPONSAVEL',
      'Paciente menor de idade sem responsável legal cadastrado não pode assinar. Cadastre o responsável na clínica.',
    )
  }
  if (p.sessaoPacienteId !== p.responsavelLegalId) {
    erro(
      'MENOR_NAO_ASSINA',
      'O termo de um paciente menor de idade é assinado pelo responsável legal.',
    )
  }
  return { pacienteId: p.pacienteId, assinadoPorId: p.responsavelLegalId }
}

/** Idade em anos completos, no dia civil informado. Puro: o chamador traz o "hoje". */
export function idadeEmAnos(nascimentoIso: string, hojeIso: string): number {
  const [an, mn, dn] = nascimentoIso.split('-').map(Number) as [number, number, number]
  const [ah, mh, dh] = hojeIso.split('-').map(Number) as [number, number, number]
  let anos = ah - an
  if (mh < mn || (mh === mn && dh < dn)) anos--
  return anos
}
