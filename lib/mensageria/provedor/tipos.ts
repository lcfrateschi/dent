/**
 * A fronteira com o mundo externo.
 *
 * Tudo que fala com a Meta passa por esta interface, e por dois motivos
 * concretos, não por gosto de abstração:
 *
 * 1. **A clínica não tem conta da Meta hoje.** Aprovar um número de WhatsApp
 *    Business e um template leva dias e depende de gente. O sistema não pode
 *    ficar parado esperando: com o provedor simulado, a fila, o webhook, a
 *    confirmação na agenda e as telas ficam prontos e demonstráveis, e trocar
 *    para produção é uma variável de ambiente.
 *
 * 2. **Teste sem rede.** O caminho crítico (enfileirou → enviou → paciente
 *    respondeu → agenda confirmou) precisa rodar em CI. Com HTTP real, não roda.
 */

export interface ResultadoEnvio {
  readonly ok: true
  /** `wamid` na Meta. É a chave que liga o webhook de status a esta mensagem. */
  readonly idExterno: string
}

export interface FalhaEnvio {
  readonly ok: false
  readonly codigo: string
  readonly mensagem: string
  /**
   * `true` quando tentar de novo mais tarde pode funcionar (rede, 429, 5xx).
   * `false` para erro definitivo (número inválido, template reprovado) — aí
   * insistir só queima cota.
   */
  readonly transitorio: boolean
}

export interface MensagemSaida {
  readonly destino: string
  readonly corpo: string
  /** Template aprovado. Fora da janela de 24h, a Meta recusa texto livre. */
  readonly template: string | null
  readonly parametros: readonly string[]
}

export interface ProvedorWhatsapp {
  readonly nome: 'meta' | 'simulado'
  enviar(m: MensagemSaida): Promise<ResultadoEnvio | FalhaEnvio>
}
