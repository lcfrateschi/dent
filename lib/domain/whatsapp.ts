import { apenasDigitos } from './cpf'
import { erro } from './erros'

/**
 * Regras de WhatsApp que não dependem de rede.
 *
 * Duas coisas moram aqui, e as duas são fonte de bug caro:
 *
 * 1. **Telefone em E.164.** A Meta Cloud API só aceita o número no formato
 *    internacional sem sinais. Brasil tem o nono dígito, DDD de dois dígitos e o
 *    hábito de escrever com `0` na frente para interurbano — três formas de errar.
 *
 * 2. **Interpretar a resposta do paciente.** Ele responde texto livre, não botão.
 *    Ler "não posso" como confirmação deixa a cadeira vazia; é o oposto do que a
 *    fase existe para resolver.
 */

// ── E.164 ────────────────────────────────────────────────────────────────────

/** DDDs válidos no Brasil. Não é sequência: 20, 23, 25, 26, 29, 36, 39… não existem. */
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
])

export function dddEhValido(ddd: number): boolean {
  return DDDS_VALIDOS.has(ddd)
}

/**
 * Normaliza um telefone brasileiro para E.164 sem `+`, como a Meta espera:
 * `5511987654321`.
 *
 * Trata: `+55` já presente, `0` de interurbano, celular de 8 dígitos legado
 * (acrescenta o nono), e fixo de 8 dígitos (mantém, fixo não tem nono dígito).
 *
 * Lança em número que não dá para salvar — melhor falhar no cadastro do que
 * enfileirar mensagem para um destino inválido e descobrir no relatório de erro.
 */
export function paraE164(telefone: string): string {
  let d = apenasDigitos(telefone)

  if (d.length === 0) {
    erro('TELEFONE_VAZIO', 'Telefone não informado.')
  }

  // Já vem com código do país.
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    d = d.slice(2)
  }
  // `0` de interurbano. São duas formas diferentes e só o TAMANHO as separa —
  // um regex guloso come o DDD junto com o zero:
  //   0 + DDD(2) + numero(8|9)                → 11 ou 12 dígitos
  //   0 + operadora(2) + DDD(2) + numero(8|9) → 13 ou 14 dígitos
  if (d.startsWith('0')) {
    if (d.length === 11 || d.length === 12) d = d.slice(1)
    else if (d.length === 13 || d.length === 14) d = d.slice(3)
  }

  if (d.length < 10 || d.length > 11) {
    erro(
      'TELEFONE_INVALIDO',
      `Telefone "${telefone}" não tem DDD + número. Use (11) 98765-4321.`,
      { telefone },
    )
  }

  const ddd = Number(d.slice(0, 2))
  if (!dddEhValido(ddd)) {
    erro('DDD_INVALIDO', `DDD ${d.slice(0, 2)} não existe.`, { telefone })
  }

  let numero = d.slice(2)

  if (numero.length === 8) {
    // Celular antigo começa com 6, 7, 8 ou 9 e ganhou o nono dígito em 2016.
    // Fixo começa com 2, 3, 4 ou 5 e continua com 8 dígitos.
    if (/^[6-9]/.test(numero)) numero = `9${numero}`
  } else if (numero.length === 9 && !numero.startsWith('9')) {
    erro(
      'CELULAR_INVALIDO',
      `Número de 9 dígitos precisa começar com 9: "${telefone}".`,
      { telefone },
    )
  }

  return `55${ddd}${numero}`
}

/** `true` quando o número normalizado é celular — só celular recebe WhatsApp. */
export function ehCelular(telefone: string): boolean {
  try {
    const e164 = paraE164(telefone)
    // 55 + DDD(2) + 9 dígitos = 13.
    return e164.length === 13 && e164[4] === '9'
  } catch {
    return false
  }
}

/** Formata o E.164 para exibição: `+55 (11) 98765-4321`. */
export function formatarE164(e164: string): string {
  const d = apenasDigitos(e164)
  if (d.length !== 12 && d.length !== 13) return e164
  const ddd = d.slice(2, 4)
  const n = d.slice(4)
  return n.length === 9
    ? `+55 (${ddd}) ${n.slice(0, 5)}-${n.slice(5)}`
    : `+55 (${ddd}) ${n.slice(0, 4)}-${n.slice(4)}`
}

// ── Interpretação da resposta ────────────────────────────────────────────────

export type Interpretacao = 'confirmou' | 'cancelou' | 'nao_entendido'

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Casamento por PALAVRA. `sim` dentro de `assim` não conta. */
function temPalavra(texto: string, palavras: readonly string[]): boolean {
  const tokens = texto.split(' ')
  return palavras.some((p) => tokens.includes(p))
}

/** Casamento por INÍCIO de palavra, para cobrir conjugação (`cancel` → `cancele`). */
function temRadical(texto: string, radicais: readonly string[]): boolean {
  const tokens = texto.split(' ')
  return tokens.some((tk) => radicais.some((r) => tk.startsWith(r)))
}

/**
 * Palavras que, sozinhas, significam sim.
 *
 * `vou`, `irei` e `estarei` ficaram DE FORA de propósito: são intenção sem
 * compromisso e aparecem tanto no sim quanto no não — "vou precisar remarcar",
 * "vou ver se consigo". Quem realmente confirma escreve junto uma palavra desta
 * lista ("estarei lá" vem depois de "confirmado").
 */
const AFIRMATIVAS = ['sim', 's', '1', 'ok', 'okay', 'confirmo', 'confirmado', 'confirmar',
  'positivo', 'certo', 'isso', 'claro', 'combinado', 'blz', 'beleza'] as const

const NEGATIVAS = ['nao', 'n', '2', 'negativo', 'impossivel', 'adiar', 'adie', 'adiando',
  'nunca'] as const

/**
 * Radicais de negação. Enumerar conjugação por conjugação sempre esquece uma —
 * `cancele` escapou da primeira versão e "confirmo mas talvez cancele" virou
 * confirmação, que é exatamente o erro que deixa a cadeira vazia.
 */
const RADICAIS_NEGATIVOS = ['cancel', 'desmarc', 'remarc', 'reagend'] as const

/** Palavras que invertem o sentido de uma afirmativa próxima. */
const NEGADORES = ['nao', 'n', 'nem', 'sem'] as const

/**
 * Marcas de INCERTEZA — e por que elas vêm antes de tudo.
 *
 * "ainda não sei se consigo, meu filho está doente" contém `nao`, e a regra de
 * negativa sozinha cancelava o atendimento. Mas o paciente não cancelou nada:
 * ele disse que não sabe. Liberar a cadeira aí é pior que não fazer nada — o
 * horário vai para outra pessoa e ele aparece.
 *
 * Dúvida é dúvida: vai para um humano.
 */
const INCERTEZAS = [
  /\bnao sei\b/,
  /\bnao tenho certeza\b/,
  /\bnao garanto\b/,
  /\btalvez\b/,
  /\bpossivelmente\b/,
  /\bprovavelmente\b/,
  /\bacho que\b/,
  /\bvou ver\b/,
  /\bpreciso ver\b/,
  /\btenho que ver\b/,
  /\bse (eu )?(der|conseguir|puder)\b/,
  /\bdepende\b/,
] as const

/**
 * Interpreta a resposta do paciente.
 *
 * **Conservador de propósito.** As consequências dos dois erros são muito
 * diferentes:
 *   - falso "confirmou" → a recepção não liga, o paciente não vem, cadeira vazia
 *   - falso "não entendido" → a recepção liga, gasta dois minutos
 *
 * Então só decide quando a resposta é curta e sem ambiguidade. Texto longo,
 * sinais mistos ("não sei se consigo confirmar") e pergunta caem em
 * `nao_entendido` para um humano ler — que é o comportamento seguro.
 */
export function interpretarResposta(texto: string): Interpretacao {
  const t = normalizar(texto)
  if (t.length === 0) return 'nao_entendido'

  const tokens = t.split(' ')

  // Pergunta não é resposta, mesmo que contenha "sim" ou "não".
  if (/\?/.test(texto)) return 'nao_entendido'

  // Incerteza antes de tudo: "não sei se consigo" tem `nao`, mas não é
  // cancelamento. Ver o comentário de INCERTEZAS.
  if (INCERTEZAS.some((r) => r.test(t))) return 'nao_entendido'

  const temAfirmativa = temPalavra(t, AFIRMATIVAS)
  const temNegativa = temPalavra(t, NEGATIVAS) || temRadical(t, RADICAIS_NEGATIVOS)

  // Sinais nos dois sentidos: humano decide.
  if (temAfirmativa && temNegativa) return 'nao_entendido'

  // Negativa é aceita mesmo em frase longa: "infelizmente preciso desmarcar".
  // O custo de errar aqui é baixo — a recepção confere o cancelamento de todo
  // jeito antes de liberar o horário.
  if (temNegativa) return 'cancelou'

  if (temAfirmativa) {
    // Afirmativa precedida de negador: "nao vou", "nem vou", "sem confirmar".
    const i = tokens.findIndex((tk) => (AFIRMATIVAS as readonly string[]).includes(tk))
    const antes = tokens.slice(Math.max(0, i - 2), i)
    if (antes.some((tk) => (NEGADORES as readonly string[]).includes(tk))) {
      return 'nao_entendido'
    }

    // Frase longa com afirmativa é ambígua: "assim que eu puder confirmo",
    // "vou ver se consigo". Curta é clara: "sim", "ok, confirmado".
    if (tokens.length > 4) return 'nao_entendido'

    return 'confirmou'
  }

  return 'nao_entendido'
}

/** Se a interpretação exige alguém olhar antes de agir. */
export function precisaDeHumano(i: Interpretacao): boolean {
  return i === 'nao_entendido'
}

export const ROTULO_INTERPRETACAO: Readonly<Record<Interpretacao, string>> = {
  confirmou: 'Confirmou',
  cancelou: 'Pediu cancelamento',
  nao_entendido: 'Resposta não interpretada',
}
