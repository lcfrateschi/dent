/**
 * Bloqueio por tentativas de senha erradas.
 *
 * O portal do paciente não tem segundo fator. O que sobra contra quem tenta
 * adivinhar senha é **encarecer a tentativa**, e é isso que este arquivo decide.
 *
 * As três escolhas que importam:
 *
 * 1. **Atraso crescente, não bloqueio permanente.** Bloquear a conta para sempre
 *    depois de N erros transforma o ataque em *negação de serviço*: qualquer
 *    pessoa que saiba o e-mail do paciente consegue trancá-lo fora do portal. O
 *    atraso cresce e passa — quem está atacando desiste, quem esqueceu a senha
 *    espera.
 *
 * 2. **A mensagem nunca diz se o e-mail existe.** "E-mail não cadastrado" entrega
 *    ao atacante metade do trabalho: ele descobre quem é paciente da clínica, o
 *    que já é dado de saúde. A resposta é sempre a mesma.
 *
 * 3. **A contagem é por conta E por IP.** Só por conta deixa passar quem varre
 *    muitas contas com uma senha comum (credential stuffing); só por IP pune a
 *    família que compartilha internet. Os dois juntos cobrem os dois casos.
 */

export interface EscadaBloqueio {
  /** Tentativas erradas antes de começar a atrasar. */
  readonly toleradas: number
  /** Minutos de bloqueio por faixa, aplicados em ordem. */
  readonly minutos: readonly number[]
}

/**
 * A escada padrão.
 *
 * Três erros passam batido — é o normal de quem tem duas senhas na cabeça. Do
 * quarto em diante o custo cresce: 1, 5, 15 e 60 minutos. Quem tenta força bruta
 * chega a 60 minutos por tentativa em menos de dez tentativas; quem esqueceu a
 * senha espera um minuto na primeira vez.
 */
export const ESCADA_PADRAO: EscadaBloqueio = {
  toleradas: 3,
  minutos: [1, 5, 15, 60],
}

export interface DecisaoBloqueio {
  readonly bloqueado: boolean
  /** Até quando. `null` quando não há bloqueio. */
  readonly ate: Date | null
  readonly minutos: number
  /** Texto para a tela, sem revelar se a conta existe. */
  readonly mensagem: string | null
}

/**
 * Decide o bloqueio a partir do número de falhas recentes.
 *
 * `falhas` é a contagem na janela de observação — quem conta é quem chama, lendo
 * o `audit_log` (que já registra `login_falho` e é append-only, então não há como
 * um atacante zerar o contador).
 */
export function decidirBloqueio(
  falhas: number,
  agora: Date,
  escada: EscadaBloqueio = ESCADA_PADRAO,
): DecisaoBloqueio {
  if (!Number.isInteger(falhas) || falhas < 0) {
    return { bloqueado: false, ate: null, minutos: 0, mensagem: null }
  }

  const excedente = falhas - escada.toleradas
  if (excedente <= 0) {
    return { bloqueado: false, ate: null, minutos: 0, mensagem: null }
  }

  // Passou do fim da escada: fica no último degrau. Não escala para sempre —
  // bloqueio de 30 dias é indistinguível de conta perdida.
  const indice = Math.min(excedente - 1, escada.minutos.length - 1)
  const minutos = escada.minutos[indice]!

  return {
    bloqueado: true,
    ate: new Date(agora.getTime() + minutos * 60_000),
    minutos,
    mensagem: `Muitas tentativas. Tente de novo em ${descreverEspera(minutos)}.`,
  }
}

/** Se um bloqueio já registrado ainda vale. */
export function bloqueioAtivo(bloqueadoAte: Date | null, agora: Date = new Date()): boolean {
  if (!bloqueadoAte) return false
  return bloqueadoAte.getTime() > agora.getTime()
}

/** Quanto falta de um bloqueio ativo, para a tela. */
export function esperaRestante(bloqueadoAte: Date | null, agora: Date = new Date()): string | null {
  if (!bloqueioAtivo(bloqueadoAte, agora)) return null
  const minutos = Math.ceil((bloqueadoAte!.getTime() - agora.getTime()) / 60_000)
  return descreverEspera(minutos)
}

export function descreverEspera(minutos: number): string {
  if (minutos <= 1) return '1 minuto'
  if (minutos < 60) return `${minutos} minutos`
  const horas = Math.round(minutos / 60)
  return horas === 1 ? '1 hora' : `${horas} horas`
}

/** Janela de observação das falhas. */
export const JANELA_MINUTOS = 30

/**
 * Limite por IP na janela.
 *
 * Mais folgado que o da conta porque uma família — ou uma sala de espera com
 * wi-fi — compartilha IP. Mas existe, porque sem ele varrer cem contas com a
 * senha `12345678` custaria nada.
 */
export const LIMITE_POR_IP = 20

export function ipExcedeu(falhasDoIp: number): boolean {
  return falhasDoIp >= LIMITE_POR_IP
}

/**
 * A única mensagem de falha de login.
 *
 * Não distingue "e-mail não existe" de "senha errada" de "conta inativa". A
 * distinção seria útil para o paciente e é útil demais para quem ataca: revela
 * quem é paciente da clínica, e ser paciente de consultório odontológico já é
 * informação de saúde.
 */
export const MENSAGEM_CREDENCIAL_INVALIDA = 'E-mail ou senha incorretos.'
