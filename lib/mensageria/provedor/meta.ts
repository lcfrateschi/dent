import type {
  FalhaEnvio,
  MensagemSaida,
  ProvedorWhatsapp,
  ResultadoEnvio,
} from './tipos'

/**
 * Provedor real: WhatsApp Cloud API da Meta.
 *
 * ⚠️ **Nunca foi executado contra a API de verdade.** A clínica não tem conta
 * Business aprovada, então este arquivo foi escrito a partir da documentação da
 * Cloud API v21 e a forma do payload não foi confirmada em rede. Está isolado
 * atrás de `ProvedorWhatsapp` exatamente para isto: quando as credenciais
 * existirem, o que precisa de conferência é só este arquivo, não o fluxo.
 *
 * O que fica verificado sem conta: fila, idempotência, decisão de horário,
 * interpretação da resposta, webhook e efeito na agenda — tudo pelo
 * `ProvedorSimulado`.
 */

const BASE = 'https://graph.facebook.com/v21.0'

export interface CredenciaisMeta {
  /** Id do número remetente (Phone Number ID), não o telefone. */
  readonly phoneNumberId: string
  readonly token: string
  /** Idioma do template aprovado. */
  readonly idioma?: string
  readonly tempoLimiteMs?: number
}

export class ProvedorMeta implements ProvedorWhatsapp {
  readonly nome = 'meta' as const

  constructor(private readonly cred: CredenciaisMeta) {
    if (!cred.phoneNumberId || !cred.token) {
      throw new Error('Credenciais da Meta incompletas: phoneNumberId e token são obrigatórios.')
    }
  }

  async enviar(m: MensagemSaida): Promise<ResultadoEnvio | FalhaEnvio> {
    const corpo = m.template
      ? {
          messaging_product: 'whatsapp',
          to: m.destino,
          type: 'template',
          template: {
            name: m.template,
            language: { code: this.cred.idioma ?? 'pt_BR' },
            components: [
              {
                type: 'body',
                parameters: m.parametros.map((p) => ({ type: 'text', text: p })),
              },
            ],
          },
        }
      : {
          messaging_product: 'whatsapp',
          to: m.destino,
          type: 'text',
          // `preview_url: false` evita que um link no texto virasse cartão.
          text: { body: m.corpo, preview_url: false },
        }

    const controle = new AbortController()
    const prazo = setTimeout(() => controle.abort(), this.cred.tempoLimiteMs ?? 10_000)

    try {
      const r = await fetch(`${BASE}/${this.cred.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cred.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(corpo),
        signal: controle.signal,
      })

      const texto = await r.text()

      if (!r.ok) {
        const erro = extrairErro(texto)
        return {
          ok: false,
          codigo: erro.codigo ?? String(r.status),
          mensagem: erro.mensagem ?? `HTTP ${r.status}: ${texto.slice(0, 200)}`,
          // 4xx é problema do nosso pedido — insistir não muda nada, exceto 429.
          transitorio: r.status === 429 || r.status >= 500,
        }
      }

      const id = extrairWamid(texto)
      if (!id) {
        // Aceitou mas não devolveu id: não temos como ligar o status depois.
        // Tratar como falha é mais honesto que gravar `enviada` sem rastro.
        return {
          ok: false,
          codigo: 'SEM_WAMID',
          mensagem: `Resposta 200 sem message id: ${texto.slice(0, 200)}`,
          transitorio: true,
        }
      }
      return { ok: true, idExterno: id }
    } catch (e) {
      const abortou = e instanceof Error && e.name === 'AbortError'
      return {
        ok: false,
        codigo: abortou ? 'TIMEOUT' : 'REDE',
        mensagem: e instanceof Error ? e.message : 'Falha de rede desconhecida.',
        transitorio: true,
      }
    } finally {
      clearTimeout(prazo)
    }
  }
}

function extrairErro(texto: string): { codigo?: string; mensagem?: string } {
  try {
    const j = JSON.parse(texto) as {
      error?: { code?: number; message?: string; error_data?: { details?: string } }
    }
    if (!j.error) return {}
    return {
      codigo: j.error.code !== undefined ? String(j.error.code) : undefined,
      mensagem: j.error.error_data?.details ?? j.error.message,
    }
  } catch {
    return {}
  }
}

function extrairWamid(texto: string): string | null {
  try {
    const j = JSON.parse(texto) as { messages?: { id?: string }[] }
    return j.messages?.[0]?.id ?? null
  } catch {
    return null
  }
}
