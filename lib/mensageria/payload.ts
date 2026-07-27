import { type Interpretacao, interpretarResposta } from '@/lib/domain/whatsapp'

/**
 * Leitura do payload do webhook da Meta.
 *
 * Pura e tolerante de propósito. O formato vem de fora e muda sem avisar: campo
 * novo, tipo de mensagem que não existia, entrega em lote com coisas
 * misturadas. Um parser rígido responderia 500, e **a Meta reentrega quem
 * responde erro** — viraria uma tempestade de reentregas por causa de um campo
 * inesperado.
 *
 * Então a regra é: extrai o que reconhece, conta o que ignorou, nunca lança.
 */

export type TipoRecebido = 'texto' | 'botao' | 'outro'

export interface MensagemRecebida {
  /** `wamid`. É a chave contra reentrega de webhook. */
  readonly idExterno: string
  /**
   * `phone_number_id` do número que RECEBEU a mensagem — **a única pista de
   * tenant que o webhook tem**. Vem de `changes[].value.metadata`, não da
   * mensagem, então é preenchido por `extrairEventos` e não por `lerMensagem`.
   *
   * `null` quando a Meta manda um lote sem `metadata`. Não é motivo para recusar o
   * evento aqui: quem decide o que fazer sem tenant é a rota.
   *
   * **Opcional** de propósito, e não por comodidade: `extrairEventos` sempre
   * preenche a chave (com `null` se não houver metadata), mas evento montado à mão
   * — nas demonstrações e nos testes — legitimamente não tem número de origem
   * nenhum. O tipo dizer "pode não existir" descreve a realidade melhor que
   * obrigar todo teste a escrever `phoneNumberId: null`. A rota trata ausente e
   * `null` igual: sem tenant, não processa.
   */
  readonly phoneNumberId?: string | null
  /** Remetente em E.164 sem `+`, como a Meta manda. */
  readonly remetente: string
  /** Texto para interpretar. Para áudio/imagem, um marcador legível. */
  readonly texto: string
  readonly tipo: TipoRecebido
  readonly recebidoEm: Date
  readonly interpretacao: Interpretacao
}

export type SituacaoExterna = 'entregue' | 'lida' | 'falhou'

export interface AtualizacaoStatus {
  readonly idExterno: string
  /** Mesmo `phone_number_id` da mensagem — ver `MensagemRecebida`. */
  readonly phoneNumberId?: string | null
  readonly situacao: SituacaoExterna
  readonly em: Date
  readonly erro?: string
}

export interface EventosWebhook {
  readonly mensagens: readonly MensagemRecebida[]
  readonly statuses: readonly AtualizacaoStatus[]
  /** Quantas entradas o parser não reconheceu. Vira log, não erro. */
  readonly ignorados: number
}

/**
 * Mensagem que não é texto (áudio, foto, figurinha, localização).
 *
 * Vira `nao_entendido` com um marcador do que chegou, e não silêncio: o paciente
 * mandou áudio dizendo "não posso amanhã", e alguém da recepção precisa ouvir.
 * Descartar seria perder a informação exatamente quando ela é urgente.
 */
const MARCADOR: Readonly<Record<string, string>> = {
  audio: '[mensagem de áudio recebida]',
  voice: '[mensagem de áudio recebida]',
  image: '[imagem recebida]',
  document: '[documento recebido]',
  video: '[vídeo recebido]',
  sticker: '[figurinha recebida]',
  location: '[localização recebida]',
  contacts: '[contato recebido]',
  reaction: '[reação recebida]',
  unsupported: '[mensagem em formato não suportado]',
}

export function extrairEventos(bruto: unknown): EventosWebhook {
  const mensagens: MensagemRecebida[] = []
  const statuses: AtualizacaoStatus[] = []
  let ignorados = 0

  const raiz = comoObjeto(bruto)
  const entradas = comoLista(raiz?.entry)

  for (const entrada of entradas) {
    for (const mudanca of comoLista(comoObjeto(entrada)?.changes)) {
      const valor = comoObjeto(comoObjeto(mudanca)?.value)
      if (!valor) {
        ignorados++
        continue
      }

      /**
       * O tenant do lote.
       *
       * Fica no `value.metadata`, uma vez por `change` — não em cada mensagem. Por
       * isso é lido aqui e colado em cada evento: um webhook pode trazer mudanças
       * de números diferentes na mesma entrega, e resolver o tenant uma vez por
       * requisição daria a clínica errada para o segundo bloco.
       */
      const phoneNumberId = comoTexto(comoObjeto(valor.metadata)?.phone_number_id)

      for (const item of comoLista(valor.messages)) {
        const m = lerMensagem(item)
        if (m) mensagens.push({ ...m, phoneNumberId })
        else ignorados++
      }

      for (const item of comoLista(valor.statuses)) {
        const s = lerStatus(item)
        if (s) statuses.push({ ...s, phoneNumberId })
        else ignorados++
      }
    }
  }

  return { mensagens, statuses, ignorados }
}

/**
 * `Omit<…, 'phoneNumberId'>` porque o tenant não está na mensagem: está no
 * `metadata` do bloco que a contém. O tipo diz isso — assim ninguém tenta ler
 * `m.phone_number_id` aqui e recebe `undefined` calado.
 */
function lerMensagem(bruto: unknown): Omit<MensagemRecebida, 'phoneNumberId'> | null {
  const m = comoObjeto(bruto)
  if (!m) return null

  const idExterno = comoTexto(m.id)
  const remetente = comoTexto(m.from)
  if (!idExterno || !remetente) return null

  const tipoBruto = comoTexto(m.type) ?? 'unsupported'
  let texto: string | null = null
  let tipo: TipoRecebido = 'outro'

  if (tipoBruto === 'text') {
    texto = comoTexto(comoObjeto(m.text)?.body)
    tipo = 'texto'
  } else if (tipoBruto === 'button') {
    // Botão de resposta rápida em template.
    texto = comoTexto(comoObjeto(m.button)?.text) ?? comoTexto(comoObjeto(m.button)?.payload)
    tipo = 'botao'
  } else if (tipoBruto === 'interactive') {
    const i = comoObjeto(m.interactive)
    texto =
      comoTexto(comoObjeto(i?.button_reply)?.title) ??
      comoTexto(comoObjeto(i?.list_reply)?.title)
    tipo = 'botao'
  }

  if (texto === null || texto.trim().length === 0) {
    texto = MARCADOR[tipoBruto] ?? `[mensagem de tipo "${tipoBruto}" recebida]`
    tipo = tipoBruto === 'text' ? 'texto' : 'outro'
  }

  return {
    idExterno,
    remetente,
    texto,
    tipo,
    recebidoEm: lerCarimbo(m.timestamp),
    // Marcador de áudio/imagem cai em `nao_entendido` naturalmente: não contém
    // nem afirmativa nem negativa.
    interpretacao: interpretarResposta(texto),
  }
}

function lerStatus(bruto: unknown): Omit<AtualizacaoStatus, 'phoneNumberId'> | null {
  const s = comoObjeto(bruto)
  if (!s) return null
  const idExterno = comoTexto(s.id)
  const status = comoTexto(s.status)
  if (!idExterno || !status) return null

  const situacao: SituacaoExterna | null =
    status === 'delivered'
      ? 'entregue'
      : status === 'read'
        ? 'lida'
        : status === 'failed'
          ? 'falhou'
          : null
  // 'sent' não interessa: quem marca `enviada` é o nosso despacho, com o wamid
  // que a própria chamada devolveu. Registrar de novo pelo webhook seria uma
  // segunda fonte de verdade para o mesmo fato.
  if (!situacao) return null

  const erros = comoLista(s.errors)
  const primeiro = comoObjeto(erros[0])
  const erro = primeiro
    ? (comoTexto(comoObjeto(primeiro.error_data)?.details) ??
      comoTexto(primeiro.title) ??
      comoTexto(primeiro.message) ??
      'Falha relatada pela Meta sem detalhe.')
    : undefined

  return { idExterno, situacao, em: lerCarimbo(s.timestamp), erro }
}

/** A Meta manda epoch em SEGUNDOS, como string. Milissegundos daria 1970. */
function lerCarimbo(bruto: unknown): Date {
  const n = typeof bruto === 'string' ? Number(bruto) : typeof bruto === 'number' ? bruto : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return new Date()
  const d = new Date(n * 1000)
  return Number.isNaN(d.getTime()) ? new Date() : d
}

function comoObjeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function comoLista(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : []
}

function comoTexto(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
