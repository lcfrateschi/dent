import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226), com `node:crypto`.
 *
 * MFA é obrigatório para staff: um sistema de prontuário protegido só por senha
 * cai no primeiro vazamento de credencial reaproveitada. Implementado aqui em
 * vez de importado pelo mesmo motivo de `senha.ts` — não colocar dependência de
 * terceiros no caminho da autenticação.
 *
 * SHA-1 com 6 dígitos e passo de 30s é o que Google Authenticator, Authy,
 * 1Password e Microsoft Authenticator suportam. Não é escolha de segurança, é
 * de interoperabilidade — o HMAC-SHA1 do TOTP não é afetado pelas colisões que
 * quebraram o SHA-1 como hash.
 */

const PASSO_SEGUNDOS = 30
const DIGITOS = 6
/** Aceita o código anterior e o seguinte: relógio de celular desalinhado é comum. */
const JANELA = 1

// ── base32 (RFC 4648, sem padding) — é o que os apps de autenticação leem ────

const ALFABETO_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function paraBase32(buf: Buffer): string {
  let bits = 0
  let valor = 0
  let saida = ''
  for (const byte of buf) {
    valor = (valor << 8) | byte
    bits += 8
    while (bits >= 5) {
      saida += ALFABETO_B32[(valor >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) saida += ALFABETO_B32[(valor << (5 - bits)) & 31]
  return saida
}

export function deBase32(s: string): Buffer {
  const limpo = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
  let bits = 0
  let valor = 0
  const bytes: number[] = []
  for (const c of limpo) {
    const i = ALFABETO_B32.indexOf(c)
    if (i === -1) throw new Error(`Caractere inválido em base32: "${c}"`)
    valor = (valor << 5) | i
    bits += 5
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** Segredo de 20 bytes (160 bits), o tamanho recomendado pela RFC 4226. */
export function gerarSegredoTotp(): string {
  return paraBase32(randomBytes(20))
}

// ── Geração e verificação ────────────────────────────────────────────────────

function hotp(segredo: Buffer, contador: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(contador))

  const digest = createHmac('sha1', segredo).update(buf).digest()
  // Truncagem dinâmica da RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f
  const codigo =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!

  return String(codigo % 10 ** DIGITOS).padStart(DIGITOS, '0')
}

/** Código do instante indicado (padrão: agora). */
export function gerarCodigoTotp(segredoBase32: string, emSegundos?: number): string {
  const agora = emSegundos ?? Math.floor(Date.now() / 1000)
  return hotp(deBase32(segredoBase32), Math.floor(agora / PASSO_SEGUNDOS))
}

/**
 * Verifica um código aceitando ±1 passo de tolerância.
 *
 * Comparação em tempo constante, e nunca lança: segredo malformado é `false`,
 * não erro 500 na tela de login.
 */
export function verificarCodigoTotp(
  segredoBase32: string,
  codigo: string,
  emSegundos?: number,
): boolean {
  try {
    const informado = codigo.replace(/\D/g, '')
    if (informado.length !== DIGITOS) return false

    const segredo = deBase32(segredoBase32)
    if (segredo.length === 0) return false

    const agora = emSegundos ?? Math.floor(Date.now() / 1000)
    const passo = Math.floor(agora / PASSO_SEGUNDOS)

    let valido = false
    for (let d = -JANELA; d <= JANELA; d++) {
      const esperado = hotp(segredo, passo + d)
      // Sem short-circuit: o tempo de resposta não deve revelar qual passo bateu.
      if (
        timingSafeEqual(Buffer.from(esperado, 'utf8'), Buffer.from(informado, 'utf8'))
      ) {
        valido = true
      }
    }
    return valido
  } catch {
    return false
  }
}

/**
 * URI `otpauth://` que os apps de autenticação leem no QR code.
 * O rótulo aparece na lista do app — por isso leva o nome da clínica.
 */
export function uriOtpauth({
  segredoBase32,
  email,
  emissor = 'Facilident',
}: {
  segredoBase32: string
  email: string
  emissor?: string
}): string {
  const rotulo = encodeURIComponent(`${emissor}:${email}`)
  const params = new URLSearchParams({
    secret: segredoBase32,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_SEGUNDOS),
  })
  return `otpauth://totp/${rotulo}?${params.toString()}`
}

/** Segundos restantes do código atual — a UI mostra isso ao usuário. */
export function segundosRestantes(emSegundos?: number): number {
  const agora = emSegundos ?? Math.floor(Date.now() / 1000)
  return PASSO_SEGUNDOS - (agora % PASSO_SEGUNDOS)
}
