import { describe, expect, it } from 'vitest'
import {
  deBase32,
  gerarCodigoTotp,
  gerarSegredoTotp,
  paraBase32,
  segundosRestantes,
  uriOtpauth,
  verificarCodigoTotp,
} from './totp'

describe('base32', () => {
  it('faz ida e volta', () => {
    for (const texto of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      const buf = Buffer.from(texto, 'utf8')
      expect(deBase32(paraBase32(buf)).toString('utf8'), `"${texto}"`).toBe(texto)
    }
  })

  it('produz o vetor conhecido da RFC 4648', () => {
    expect(paraBase32(Buffer.from('foobar', 'utf8'))).toBe('MZXW6YTBOI')
  })

  it('ignora espaço e padding, e não diferencia caixa', () => {
    const esperado = deBase32('MZXW6YTBOI')
    expect(deBase32('mzxw6ytboi')).toEqual(esperado)
    expect(deBase32('MZXW 6YTB OI')).toEqual(esperado)
    expect(deBase32('MZXW6YTBOI======')).toEqual(esperado)
  })

  it('rejeita caractere fora do alfabeto', () => {
    // 0, 1 e 8 não existem no base32 da RFC 4648 justamente por ambiguidade.
    expect(() => deBase32('MZXW6YTB01')).toThrowError(/inválido/)
  })
})

describe('TOTP — vetores da RFC 6238', () => {
  // A RFC usa o segredo ASCII "12345678901234567890" com HMAC-SHA1.
  const segredo = paraBase32(Buffer.from('12345678901234567890', 'utf8'))

  it('reproduz os códigos oficiais de 6 dígitos', () => {
    // Valores do Apêndice B da RFC 6238, coluna SHA1.
    const casos: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ]
    for (const [t, esperado] of casos) {
      expect(gerarCodigoTotp(segredo, t), `t=${t}`).toBe(esperado)
    }
  })
})

describe('verificação de código', () => {
  const segredo = gerarSegredoTotp()
  const agora = 1_700_000_000

  it('aceita o código do momento', () => {
    const codigo = gerarCodigoTotp(segredo, agora)
    expect(verificarCodigoTotp(segredo, codigo, agora)).toBe(true)
  })

  it('tolera um passo para trás e um para frente — relógio de celular desalinha', () => {
    expect(verificarCodigoTotp(segredo, gerarCodigoTotp(segredo, agora - 30), agora)).toBe(true)
    expect(verificarCodigoTotp(segredo, gerarCodigoTotp(segredo, agora + 30), agora)).toBe(true)
  })

  it('recusa além da janela de tolerância', () => {
    expect(verificarCodigoTotp(segredo, gerarCodigoTotp(segredo, agora - 90), agora)).toBe(false)
    expect(verificarCodigoTotp(segredo, gerarCodigoTotp(segredo, agora + 90), agora)).toBe(false)
  })

  it('aceita código digitado com espaço ou hífen', () => {
    const codigo = gerarCodigoTotp(segredo, agora)
    const comEspaco = `${codigo.slice(0, 3)} ${codigo.slice(3)}`
    expect(verificarCodigoTotp(segredo, comEspaco, agora)).toBe(true)
  })

  it('recusa código errado, tamanho errado e vazio', () => {
    expect(verificarCodigoTotp(segredo, '000000', agora)).toBe(
      gerarCodigoTotp(segredo, agora) === '000000',
    )
    for (const ruim of ['', '12345', '1234567', 'abcdef']) {
      expect(verificarCodigoTotp(segredo, ruim, agora), `"${ruim}"`).toBe(false)
    }
  })

  it('nunca lança — segredo inválido vira false, não erro 500 no login', () => {
    for (const segredoRuim of ['', '!!!!', 'MZXW6YTB01']) {
      expect(() => verificarCodigoTotp(segredoRuim, '123456', agora)).not.toThrow()
      expect(verificarCodigoTotp(segredoRuim, '123456', agora)).toBe(false)
    }
  })

  it('segredos diferentes não validam o mesmo código', () => {
    const outro = gerarSegredoTotp()
    const codigo = gerarCodigoTotp(segredo, agora)
    expect(verificarCodigoTotp(outro, codigo, agora)).toBe(false)
  })
})

describe('segredo gerado', () => {
  it('tem 160 bits, como recomenda a RFC 4226', () => {
    const s = gerarSegredoTotp()
    expect(deBase32(s)).toHaveLength(20)
    expect(s).toMatch(/^[A-Z2-7]+$/)
  })

  it('é diferente a cada chamada', () => {
    const amostras = new Set(Array.from({ length: 20 }, () => gerarSegredoTotp()))
    expect(amostras.size).toBe(20)
  })
})

describe('URI otpauth', () => {
  it('monta a URI que o app de autenticação lê no QR', () => {
    const uri = uriOtpauth({ segredoBase32: 'ABCDEFGH', email: 'ana@clinica.com.br' })
    expect(uri).toContain('otpauth://totp/Facilident%3Aana%40clinica.com.br')
    expect(uri).toContain('secret=ABCDEFGH')
    expect(uri).toContain('issuer=Facilident')
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })

  it('usa o emissor informado — é o nome que aparece na lista do app', () => {
    const uri = uriOtpauth({
      segredoBase32: 'ABCDEFGH',
      email: 'ana@x.com',
      emissor: 'Clínica Sorriso',
    })
    expect(uri).toContain(encodeURIComponent('Clínica Sorriso:ana@x.com'))
  })
})

describe('contagem de tempo', () => {
  it('devolve os segundos que faltam para o código virar', () => {
    expect(segundosRestantes(1_699_999_980)).toBe(30) // múltiplo exato de 30
    expect(segundosRestantes(1_699_999_981)).toBe(29)
    expect(segundosRestantes(1_700_000_009)).toBe(1)
    // 1.700.000.000 não é múltiplo de 30: sobram 20 s do passo.
    expect(segundosRestantes(1_700_000_000)).toBe(10)
  })
})
