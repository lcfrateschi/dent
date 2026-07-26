import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verificação da assinatura do webhook da Meta.
 *
 * **Por que isto não é opcional.** O endpoint do webhook é público — tem de ser,
 * a Meta chama de fora. Sem verificar assinatura, qualquer pessoa que descubra a
 * URL pode fazer um POST dizendo "o paciente respondeu NÃO" e **cancelar
 * consultas alheias**. É a rota mais exposta de todo o sistema e a única em que
 * um estranho pode alterar a agenda.
 *
 * Três armadilhas conhecidas, e como cada uma é tratada:
 *
 * 1. **O HMAC é sobre o corpo BRUTO.** `JSON.parse` seguido de `JSON.stringify`
 *    reordena chaves e muda espaços; a assinatura deixa de casar. Por isso a
 *    rota lê `await request.text()` e só faz `parse` depois de verificar.
 * 2. **Comparação em tempo constante.** `a === b` para em cima do primeiro byte
 *    diferente, e a diferença de tempo vaza o prefixo correto. `timingSafeEqual`
 *    não sai antes do fim.
 * 3. **Segredo ausente rejeita tudo.** Nunca "sem segredo configurado, aceita" —
 *    seria uma porta escancarada em produção com env pela metade.
 */

const PREFIXO = 'sha256='

export type ResultadoAssinatura =
  | { readonly valida: true }
  | { readonly valida: false; readonly motivo: string }

/**
 * Confere `X-Hub-Signature-256` contra o corpo bruto.
 *
 * `corpo` precisa ser exatamente os bytes recebidos.
 */
export function verificarAssinatura(
  corpo: string,
  cabecalho: string | null,
  segredo: string | undefined,
): ResultadoAssinatura {
  if (!segredo || segredo.length === 0) {
    return {
      valida: false,
      motivo: 'WHATSAPP_APP_SECRET não configurado — webhook recusado por segurança.',
    }
  }
  if (!cabecalho) {
    return { valida: false, motivo: 'Cabeçalho X-Hub-Signature-256 ausente.' }
  }
  if (!cabecalho.startsWith(PREFIXO)) {
    return { valida: false, motivo: 'Assinatura sem o prefixo sha256=.' }
  }

  const recebida = cabecalho.slice(PREFIXO.length).trim()
  // Um hex de sha256 tem 64 caracteres. Fora disso não vale nem comparar, e
  // `Buffer.from` com hex ímpar trunca em silêncio — o que faria um hex curto
  // casar com o prefixo do correto.
  if (!/^[0-9a-f]{64}$/i.test(recebida)) {
    return { valida: false, motivo: 'Assinatura não é um hex sha256 de 64 caracteres.' }
  }

  const esperada = createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex')

  const a = Buffer.from(recebida.toLowerCase(), 'hex')
  const b = Buffer.from(esperada, 'hex')
  if (a.length !== b.length) {
    return { valida: false, motivo: 'Assinatura com tamanho inesperado.' }
  }
  if (!timingSafeEqual(a, b)) {
    return { valida: false, motivo: 'Assinatura não corresponde ao corpo recebido.' }
  }
  return { valida: true }
}

/** Gera a assinatura de um corpo — usada nos testes e pelo simulador. */
export function assinar(corpo: string, segredo: string): string {
  return `${PREFIXO}${createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex')}`
}

/**
 * Handshake de verificação do webhook (GET).
 *
 * A Meta chama uma vez com um token combinado e espera o `challenge` de volta em
 * texto puro. Token errado devolve 403 — mesma lógica do POST: sem prova, nada.
 */
export function conferirDesafio(
  parametros: URLSearchParams,
  tokenEsperado: string | undefined,
): { readonly ok: true; readonly desafio: string } | { readonly ok: false; readonly motivo: string } {
  if (!tokenEsperado || tokenEsperado.length === 0) {
    return { ok: false, motivo: 'WHATSAPP_VERIFY_TOKEN não configurado.' }
  }
  if (parametros.get('hub.mode') !== 'subscribe') {
    return { ok: false, motivo: 'hub.mode diferente de subscribe.' }
  }
  const token = parametros.get('hub.verify_token')
  const desafio = parametros.get('hub.challenge')
  if (!token || !desafio) {
    return { ok: false, motivo: 'hub.verify_token ou hub.challenge ausente.' }
  }

  const a = Buffer.from(token, 'utf8')
  const b = Buffer.from(tokenEsperado, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, motivo: 'hub.verify_token não corresponde.' }
  }
  return { ok: true, desafio }
}
