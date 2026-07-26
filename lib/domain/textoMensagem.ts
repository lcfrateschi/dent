import { erro } from './erros'
import { FUSO_PADRAO, diaLocalIso, horaLocal, partesLocais } from './fuso'

/**
 * O texto que o paciente lê, e a chave que impede mandá-lo duas vezes.
 *
 * Pura de propósito: o texto de uma mensagem é a parte do sistema que mais gente
 * quer revisar ("põe o endereço", "tira o 'prezado'") e a que menos deveria
 * exigir subir o banco para conferir.
 */

const DIAS_SEMANA = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
] as const

/**
 * Primeiro nome, para tratar o paciente como uma pessoa.
 *
 * "Olá, Maria Aparecida da Silva dos Santos Ferreira" é o cumprimento de um
 * sistema. Se houver nome social, é ele que se usa — quem chama pelo nome de
 * registro erra em público.
 */
export function primeiroNome(nome: string): string {
  const limpo = nome.trim().replace(/\s+/g, ' ')
  if (limpo.length === 0) erro('NOME_VAZIO', 'Nome não informado.')
  return limpo.split(' ')[0]!
}

/**
 * Chave de idempotência do lembrete.
 *
 * Inclui o INÍCIO do atendimento, não só o id: remarcar muda o início, logo
 * muda a chave, logo o horário novo ganha lembrete próprio. Reprocessar o mesmo
 * horário colide na UNIQUE e não manda nada — que é exatamente o que se quer de
 * um job que pode rodar duas vezes.
 */
export function chaveLembrete(agendamentoId: string, inicio: Date): string {
  if (agendamentoId.trim().length === 0) {
    erro('AGENDAMENTO_OBRIGATORIO', 'Lembrete precisa de agendamento.')
  }
  if (Number.isNaN(inicio.getTime())) {
    erro('DATA_INVALIDA', 'Início do atendimento inválido.')
  }
  return `lembrete:${agendamentoId}:${inicio.toISOString()}`
}

/** Chave da resposta automática a uma resposta recebida — uma por resposta. */
export function chaveRetorno(respostaId: string): string {
  if (respostaId.trim().length === 0) {
    erro('RESPOSTA_OBRIGATORIA', 'Retorno precisa da resposta que o originou.')
  }
  return `retorno:${respostaId}`
}

export interface DadosLembrete {
  readonly pacienteNome: string
  readonly profissionalNome: string
  readonly clinicaNome: string
  readonly inicio: Date
  readonly fuso?: string
}

/** 'quinta-feira, 13/08 às 14:00' — como uma pessoa diria ao telefone. */
export function quandoEmPortugues(inicio: Date, fuso: string = FUSO_PADRAO): string {
  const p = partesLocais(inicio, fuso)
  const dia = String(p.dia).padStart(2, '0')
  const mes = String(p.mes).padStart(2, '0')
  return `${DIAS_SEMANA[p.diaSemana]}, ${dia}/${mes} às ${horaLocal(inicio, fuso)}`
}

/**
 * Texto do lembrete.
 *
 * Três decisões que vieram de ler mensagens de clínica de verdade:
 *
 * - **Diz o dia da semana junto com a data.** "13/08" faz o paciente conferir o
 *   calendário; "quinta-feira, 13/08" ele já sabe.
 * - **Instrução de resposta explícita e curta.** Sem "responda SIM para
 *   confirmar ou NÃO para cancelar" o paciente escreve "bom dia, tudo bem?" e
 *   ninguém confirma nada.
 * - **Não diz o procedimento.** Dado de saúde não vai para o WhatsApp: a tela do
 *   celular é lida por outras pessoas, e "canal + coroa" não é assunto do ônibus.
 *   Só nome, profissional, data e hora.
 */
export function textoLembrete(d: DadosLembrete): string {
  const fuso = d.fuso ?? FUSO_PADRAO
  return [
    `Olá, ${primeiroNome(d.pacienteNome)}! Passando para lembrar da sua consulta na ${d.clinicaNome.trim()}.`,
    '',
    `📅 ${quandoEmPortugues(d.inicio, fuso)}`,
    `🦷 com ${d.profissionalNome.trim()}`,
    '',
    'Responda *SIM* para confirmar ou *NÃO* se precisar remarcar.',
  ].join('\n')
}

/**
 * Parâmetros do template aprovado na Meta.
 *
 * Fora da janela de 24 horas desde a última mensagem do paciente, a Meta recusa
 * texto livre e só aceita template com variáveis posicionais. A ordem aqui é a
 * ordem do template cadastrado — trocar uma pela outra manda o nome do dentista
 * onde deveria estar a data.
 */
export function parametrosLembrete(d: DadosLembrete): readonly string[] {
  const fuso = d.fuso ?? FUSO_PADRAO
  return [
    primeiroNome(d.pacienteNome),
    d.clinicaNome.trim(),
    quandoEmPortugues(d.inicio, fuso),
    d.profissionalNome.trim(),
  ]
}

export const TEMPLATE_LEMBRETE = 'lembrete_consulta_pt_br'

/** Confirmação recebida — fecha o assunto para o paciente. */
export function textoConfirmado(d: DadosLembrete): string {
  const fuso = d.fuso ?? FUSO_PADRAO
  return `Obrigado, ${primeiroNome(d.pacienteNome)}! Sua consulta de ${quandoEmPortugues(d.inicio, fuso)} está confirmada. Até lá!`
}

/**
 * Cancelamento registrado.
 *
 * Não promete horário novo: quem remarca é a recepção, olhando a agenda. Dizer
 * "vamos remarcar" sem remarcar cria paciente que acha que tem horário.
 */
export function textoCancelado(d: DadosLembrete): string {
  return `Tudo bem, ${primeiroNome(d.pacienteNome)}. Sua consulta foi cancelada e a recepção vai entrar em contato para remarcar.`
}

/** Quando a máquina não entendeu — honesto, sem fingir que resolveu. */
export function textoNaoEntendido(d: DadosLembrete): string {
  return `${primeiroNome(d.pacienteNome)}, não consegui entender sua resposta. Já avisei a recepção e alguém vai falar com você. Se preferir, responda apenas *SIM* ou *NÃO*.`
}

/** Dia local do atendimento, para agrupar lembretes na tela. */
export function diaDoLembrete(inicio: Date, fuso: string = FUSO_PADRAO): string {
  return diaLocalIso(inicio, fuso)
}
