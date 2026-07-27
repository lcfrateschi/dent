import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gerarCodigoTotp, gerarSegredoTotp, verificarCodigoTotp } from './totp'
import { cifrarSegredo, decifrarSegredo, ehTextoClaro, segredosIguais } from './mfaSegredo'

/**
 * A cifra do segredo TOTP.
 *
 * O que estes casos protegem, em ordem de importância: que o segundo fator continue
 * FUNCIONANDO depois de cifrado (senão a clínica inteira perde o login), que
 * adulterar a linha FALHE em vez de devolver lixo, e que o segredo legado em texto
 * claro continue valendo — porque a alternativa é uma janela de manutenção em que
 * ninguém entra.
 */

const original = { ...process.env }
const CHAVE = 'K'.repeat(64)
const USUARIO = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
const OUTRO_USUARIO = '00000000-0000-4000-8000-000000000001'

beforeEach(() => {
  process.env = { ...original, MFA_CHAVE: CHAVE } as NodeJS.ProcessEnv
})

afterEach(() => {
  process.env = { ...original }
})

describe('cifrar e decifrar', () => {
  it('devolve exatamente o mesmo segredo', () => {
    const segredo = gerarSegredoTotp()
    const guardado = cifrarSegredo(segredo, USUARIO)

    expect(guardado).not.toContain(segredo)
    expect(decifrarSegredo(guardado, USUARIO)).toEqual({ segredo, precisaRecifrar: false })
  })

  it('o segredo decifrado ainda gera código TOTP válido', () => {
    // A prova que importa de verdade: cifrar não pode alterar o segredo de um jeito
    // que passe nos testes de string e quebre o autenticador do usuário.
    const segredo = gerarSegredoTotp()
    const guardado = cifrarSegredo(segredo, USUARIO)
    const { segredo: recuperado } = decifrarSegredo(guardado, USUARIO)

    expect(verificarCodigoTotp(recuperado, gerarCodigoTotp(segredo))).toBe(true)
  })

  it('o texto cifrado muda a cada execução — o nonce nunca repete', () => {
    // Nonce repetido em GCM é catastrófico: dois textos cifrados com o mesmo nonce
    // permitem recuperar o XOR dos claros e forjar a tag. Se este caso falhar, o
    // nonce virou fixo.
    const segredo = gerarSegredoTotp()
    const a = cifrarSegredo(segredo, USUARIO)
    const b = cifrarSegredo(segredo, USUARIO)

    expect(a).not.toBe(b)
    expect(decifrarSegredo(a, USUARIO).segredo).toBe(decifrarSegredo(b, USUARIO).segredo)
  })

  it('tem o prefixo de versão, para a rotação ser possível sem parada', () => {
    expect(cifrarSegredo(gerarSegredoTotp(), USUARIO).startsWith('v1$')).toBe(true)
  })

  it('recusa segredo vazio', () => {
    expect(() => cifrarSegredo('', USUARIO)).toThrowError(/vazio/i)
  })
})

describe('adulteração', () => {
  it('trocar um byte do texto cifrado FALHA — não devolve lixo', () => {
    // É a razão de ser do GCM neste projeto. Com CBC, isto devolveria um "segredo"
    // diferente e plausível, e o sintoma seria um usuário que simplesmente não
    // entra mais, sem nada dizendo que a linha foi mexida.
    const guardado = cifrarSegredo(gerarSegredoTotp(), USUARIO)
    const [versao, nonce, corpo] = guardado.split('$') as [string, string, string]

    const bytes = Buffer.from(corpo, 'base64url')
    bytes[0] = bytes[0]! ^ 0x01
    const mexido = `${versao}$${nonce}$${bytes.toString('base64url')}`

    expect(() => decifrarSegredo(mexido, USUARIO)).toThrowError(/não foi possível decifrar/i)
  })

  it('trocar o nonce FALHA', () => {
    const guardado = cifrarSegredo(gerarSegredoTotp(), USUARIO)
    const [versao, nonce, corpo] = guardado.split('$') as [string, string, string]

    const bytes = Buffer.from(nonce, 'base64url')
    bytes[0] = bytes[0]! ^ 0x01

    expect(() => decifrarSegredo(`${versao}$${bytes.toString('base64url')}$${corpo}`, USUARIO)).toThrow()
  })

  it('o segredo de um usuário NÃO decifra na linha de outro', () => {
    /**
     * O ataque que o AAD fecha: quem consegue um `UPDATE` no banco copia o próprio
     * valor cifrado — de que já tem o autenticador no celular — para a linha do
     * administrador, e passa a gerar o segundo fator dele. Sem AAD isso funciona,
     * porque o texto cifrado não sabe de quem é.
     */
    const guardado = cifrarSegredo(gerarSegredoTotp(), USUARIO)

    expect(() => decifrarSegredo(guardado, OUTRO_USUARIO)).toThrowError(/não foi possível decifrar/i)
  })

  it('a mensagem de erro não carrega o valor cifrado', () => {
    // Texto cifrado em log é material para ataque offline no dia em que a chave
    // vazar. E a mensagem não distingue chave errada de AAD errado: "AAD errado"
    // confirmaria a quem ataca que o valor é válido e foi movido de linha.
    const guardado = cifrarSegredo(gerarSegredoTotp(), USUARIO)
    try {
      decifrarSegredo(guardado, OUTRO_USUARIO)
      expect.unreachable('devia ter lançado')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain(guardado.split('$')[2])
      expect(msg).toMatch(/reiniciar o MFA/i)
    }
  })

  it('formato quebrado e versão desconhecida estouram', () => {
    expect(() => decifrarSegredo('v1$só-duas-partes', USUARIO)).toThrowError(/formato inválido/i)
    expect(() => decifrarSegredo('v9$AAAA$AAAA', USUARIO)).toThrowError(/versão de cifra desconhecida/i)
    expect(() => decifrarSegredo('v1$AAAA$AAAA', USUARIO)).toThrowError(/truncado/i)
  })
})

describe('migração preguiçosa do legado', () => {
  it('segredo em texto claro continua funcionando e é MARCADO para recifrar', () => {
    // Sem isto, ligar a cifra trancaria fora do sistema todo mundo que já tinha
    // autenticador configurado.
    const legado = gerarSegredoTotp()

    expect(ehTextoClaro(legado)).toBe(true)
    expect(decifrarSegredo(legado, USUARIO)).toEqual({ segredo: legado, precisaRecifrar: true })
  })

  it('valor já cifrado NÃO é marcado para recifrar', () => {
    // A contraprova do caso acima: se `precisaRecifrar` fosse sempre `true`, o
    // login regravaria a linha a cada acesso e a marca não significaria nada.
    const guardado = cifrarSegredo(gerarSegredoTotp(), USUARIO)

    expect(ehTextoClaro(guardado)).toBe(false)
    expect(decifrarSegredo(guardado, USUARIO).precisaRecifrar).toBe(false)
  })

  it('o segredo TOTP base32 nunca é confundido com valor cifrado', () => {
    // A detecção depende de o segredo legado não ter `$`. Base32 é [A-Z2-7], então
    // não tem — mas se `gerarSegredoTotp` mudasse de alfabeto, esta afirmação cairia
    // junto, e é aqui que isso apareceria.
    for (let i = 0; i < 50; i++) {
      const s = gerarSegredoTotp()
      expect(s).toMatch(/^[A-Z2-7]+$/)
      expect(ehTextoClaro(s)).toBe(true)
    }
  })
})

describe('a chave', () => {
  it('sem MFA_CHAVE, cifrar e decifrar ESTOURAM', () => {
    // A tentação era cair para texto claro quando a chave falta ("assim nada
    // quebra"). Isso traria a dívida de volta em silêncio, num deploy onde a
    // variável se perdeu.
    process.env.MFA_CHAVE = undefined
    delete process.env.MFA_CHAVE

    expect(() => cifrarSegredo('AAAA', USUARIO)).toThrowError(/MFA_CHAVE não definida/)
    expect(() => decifrarSegredo('v1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAA', USUARIO)).toThrowError(
      /MFA_CHAVE não definida/,
    )
  })

  it('chave curta é recusada', () => {
    process.env.MFA_CHAVE = 'curta'
    expect(() => cifrarSegredo('AAAA', USUARIO)).toThrowError(/curta demais/)
  })

  it('chave diferente NÃO decifra — é o que faz a cifra valer algo', () => {
    /**
     * Se este caso falhasse, a chave não estaria participando da cifra e um dump
     * seria decifrável por qualquer um. É a asserção que prova que o segredo está
     * protegido *pela chave*, e não apenas codificado.
     */
    const guardado = cifrarSegredo(gerarSegredoTotp(), USUARIO)

    process.env.MFA_CHAVE = 'X'.repeat(64)
    expect(() => decifrarSegredo(guardado, USUARIO)).toThrowError(/não foi possível decifrar/i)

    // E volta a funcionar com a chave certa — senão o caso acima poderia estar
    // passando por o valor estar corrompido, não por a chave ser outra.
    process.env.MFA_CHAVE = CHAVE
    expect(decifrarSegredo(guardado, USUARIO).precisaRecifrar).toBe(false)
  })
})

describe('segredosIguais', () => {
  it('compara em tempo constante e sem surpresa de tamanho', () => {
    expect(segredosIguais('ABCDEF', 'ABCDEF')).toBe(true)
    expect(segredosIguais('ABCDEF', 'ABCDEG')).toBe(false)
    expect(segredosIguais('ABC', 'ABCDEF')).toBe(false)
    expect(segredosIguais('', '')).toBe(true)
  })
})
