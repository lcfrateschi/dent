import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assinar, conferirDesafio, verificarAssinatura } from './assinatura'

const SEGREDO = 'segredo-de-app-da-meta'
const CORPO = '{"object":"whatsapp_business_account","entry":[{"id":"123"}]}'

describe('verificar assinatura do webhook', () => {
  it('aceita assinatura correta', () => {
    expect(verificarAssinatura(CORPO, assinar(CORPO, SEGREDO), SEGREDO)).toEqual({ valida: true })
  })

  it('recusa quando o corpo foi alterado em um único byte', () => {
    const assinatura = assinar(CORPO, SEGREDO)
    const adulterado = CORPO.replace('"123"', '"124"')
    expect(verificarAssinatura(adulterado, assinatura, SEGREDO).valida).toBe(false)
  })

  it('recusa assinatura de outro segredo', () => {
    expect(verificarAssinatura(CORPO, assinar(CORPO, 'outro'), SEGREDO).valida).toBe(false)
  })

  it('RECUSA quando o segredo não está configurado', () => {
    // Nunca "sem segredo, aceita" — seria porta aberta em produção mal configurada.
    for (const s of [undefined, '']) {
      const r = verificarAssinatura(CORPO, assinar(CORPO, SEGREDO), s)
      expect(r.valida).toBe(false)
      if (!r.valida) expect(r.motivo).toContain('WHATSAPP_APP_SECRET')
    }
  })

  it('recusa cabeçalho ausente ou malformado', () => {
    for (const c of [
      null,
      '',
      'abc',
      'sha1=abc',
      `sha256=${'0'.repeat(63)}`,
      `sha256=${'0'.repeat(65)}`,
      'sha256=nao-e-hex-nao-e-hex-nao-e-hex-nao-e-hex-nao-e-hex-nao-e-hexxx',
    ]) {
      expect(verificarAssinatura(CORPO, c, SEGREDO).valida, String(c)).toBe(false)
    }
  })

  it('não deixa hex curto casar por prefixo', () => {
    // Buffer.from com hex truncado silenciosamente é como este ataque passa.
    const certo = createHmac('sha256', SEGREDO).update(CORPO).digest('hex')
    expect(verificarAssinatura(CORPO, `sha256=${certo.slice(0, 32)}`, SEGREDO).valida).toBe(false)
    expect(verificarAssinatura(CORPO, `sha256=${certo.slice(0, 2)}`, SEGREDO).valida).toBe(false)
  })

  it('aceita hex em maiúsculas', () => {
    const a = assinar(CORPO, SEGREDO).toUpperCase().replace('SHA256=', 'sha256=')
    expect(verificarAssinatura(CORPO, a, SEGREDO)).toEqual({ valida: true })
  })

  it('é sensível a espaço e ordem — o HMAC é sobre o corpo bruto', () => {
    // Reserializar o JSON quebra a assinatura; a rota precisa usar o texto cru.
    const assinatura = assinar(CORPO, SEGREDO)
    const reserializado = JSON.stringify(JSON.parse(CORPO))
    if (reserializado !== CORPO) {
      expect(verificarAssinatura(reserializado, assinatura, SEGREDO).valida).toBe(false)
    }
    expect(verificarAssinatura(`${CORPO} `, assinatura, SEGREDO).valida).toBe(false)
  })

  it('lida com acento e emoji no corpo', () => {
    const corpo = '{"texto":"não posso 😕"}'
    expect(verificarAssinatura(corpo, assinar(corpo, SEGREDO), SEGREDO)).toEqual({ valida: true })
  })
})

describe('handshake de verificação', () => {
  const TOKEN = 'token-combinado'

  function p(o: Record<string, string>): URLSearchParams {
    return new URLSearchParams(o)
  }

  it('devolve o challenge quando o token confere', () => {
    const r = conferirDesafio(
      p({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1234' }),
      TOKEN,
    )
    expect(r).toEqual({ ok: true, desafio: '1234' })
  })

  it('recusa token errado, mode errado e parâmetro ausente', () => {
    const casos: Record<string, string>[] = [
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '1' },
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' },
      { 'hub.mode': 'subscribe', 'hub.challenge': '1' },
      { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN },
      {},
    ]
    for (const c of casos) {
      expect(conferirDesafio(p(c), TOKEN).ok, JSON.stringify(c)).toBe(false)
    }
  })

  it('recusa quando o token esperado não está configurado', () => {
    const params = p({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' })
    expect(conferirDesafio(params, undefined).ok).toBe(false)
    expect(conferirDesafio(params, '').ok).toBe(false)
  })

  it('token de prefixo correto mas tamanho diferente não passa', () => {
    const params = p({
      'hub.mode': 'subscribe',
      'hub.verify_token': TOKEN.slice(0, 5),
      'hub.challenge': '1',
    })
    expect(conferirDesafio(params, TOKEN).ok).toBe(false)
  })
})
