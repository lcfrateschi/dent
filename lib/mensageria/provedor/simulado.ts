import { createHash, randomUUID } from 'node:crypto'
import type {
  FalhaEnvio,
  MensagemSaida,
  ProvedorWhatsapp,
  ResultadoEnvio,
} from './tipos'

/**
 * Provedor simulado.
 *
 * Não é um stub que devolve `true`. Ele **reproduz as recusas da Meta** que
 * derrubam integração em produção, para que o código que trata erro seja
 * exercitado antes de existir conta:
 *
 * - destino fora de E.164 → erro definitivo (a Meta responde 131030 / 131026)
 * - corpo vazio → definitivo
 * - template exigido e ausente → definitivo (fora da janela de 24h)
 * - número de teste reservado → transitório, para exercitar o caminho de falha
 *
 * O `wamid` gerado imita o formato real (`wamid.` + base64-ish) para que nada no
 * resto do sistema dependa do formato bonito de um id fabricado.
 */

/** Qualquer destino terminando nestes 4 dígitos falha de propósito. */
const SUFIXO_FALHA_TRANSITORIA = '0000'
const SUFIXO_FALHA_DEFINITIVA = '9999'

export interface EnvioSimulado {
  readonly destino: string
  readonly corpo: string
  readonly idExterno: string
  readonly em: Date
}

export class ProvedorSimulado implements ProvedorWhatsapp {
  readonly nome = 'simulado' as const

  /**
   * O que "saiu". Em processo único isto é o que a tela de demonstração lê para
   * mostrar a mensagem como o paciente veria.
   */
  readonly enviados: EnvioSimulado[] = []

  constructor(private readonly agora: () => Date = () => new Date()) {}

  async enviar(m: MensagemSaida): Promise<ResultadoEnvio | FalhaEnvio> {
    if (!/^55[0-9]{10,11}$/.test(m.destino)) {
      return {
        ok: false,
        codigo: '131030',
        mensagem: `Destino "${m.destino}" não está em E.164 (55 + DDD + número).`,
        transitorio: false,
      }
    }
    if (m.corpo.trim().length === 0) {
      return { ok: false, codigo: '131009', mensagem: 'Corpo vazio.', transitorio: false }
    }
    if (m.template !== null && m.parametros.length === 0) {
      return {
        ok: false,
        codigo: '132000',
        mensagem: `Template "${m.template}" exige parâmetros e nenhum foi informado.`,
        transitorio: false,
      }
    }
    if (m.destino.endsWith(SUFIXO_FALHA_DEFINITIVA)) {
      return {
        ok: false,
        codigo: '131026',
        mensagem: 'Número não tem WhatsApp (simulado).',
        transitorio: false,
      }
    }
    if (m.destino.endsWith(SUFIXO_FALHA_TRANSITORIA)) {
      return {
        ok: false,
        codigo: '130429',
        mensagem: 'Limite de envio atingido, tente mais tarde (simulado).',
        transitorio: true,
      }
    }

    const idExterno = wamidSimulado(m.destino, m.corpo)
    this.enviados.push({
      destino: m.destino,
      corpo: m.corpo,
      idExterno,
      em: this.agora(),
    })
    return { ok: true, idExterno }
  }
}

/**
 * Id no formato da Meta. Determinístico por (destino, corpo, aleatório) para
 * parecer real sem colidir entre mensagens iguais reenviadas.
 */
function wamidSimulado(destino: string, corpo: string): string {
  const h = createHash('sha256').update(`${destino}|${corpo}|${randomUUID()}`).digest('base64url')
  return `wamid.SIMULADO${h.slice(0, 32).toUpperCase()}`
}
