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

      for (const item of comoLista(valor.messages)) {
        const m = lerMensagem(item)
        if (m) mensagens.push(m)
        else ignorados++
      }

      for (const item of comoLista(valor.statuses)) {
        const s = lerStatus(item)
        if (s) statuses.push(s)
        else ignorados++
      }
    }
  }

  return { mensagens, statuses, ignorados }
}

function lerMensagem(bruto: unknown): MensagemRecebida | null {
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

function lerStatus(bruto: unknown): AtualizacaoStatus | null {
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
