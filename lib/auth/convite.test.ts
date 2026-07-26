import { describe, expect, it } from 'vitest'
import {
  VALIDADE_CONVITE_DIAS,
  conferirConvite,
  conviteExpirou,
  formatarConvite,
  gerarConvite,
  gerarTokenDeSessao,
  hashDoToken,
  hashDoTokenDeSessao,
  normalizar,
} from './convite'
import { avaliarSenhaPaciente } from './senha'

const AGORA = new Date('2026-07-26T13:00:00Z')

describe('geração do convite', () => {
  it('tem 32 caracteres do alfabeto legível', () => {
    const c = gerarConvite(AGORA)
    expect(c.token).toHaveLength(32)
    // Sem 0, 1, O e I: são os pares que a pessoa confunde ao copiar do papel.
    // `L` fica, e não é descuido — como não existe `1` no alfabeto, não há com
    // o que confundi-lo, e tirá-lo deixaria 31 símbolos, o que reintroduziria
    // viés no `% 32`.
    expect(/^[A-HJ-NP-Z2-9]+$/.test(c.token)).toBe(true)
    expect(c.token).not.toMatch(/[01OI]/)
  })

  it('nunca repete', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => gerarConvite(AGORA).token))
    expect(tokens.size).toBe(200)
  })

  it('o hash é sha256 hex e NÃO contém o token', () => {
    const c = gerarConvite(AGORA)
    expect(/^[0-9a-f]{64}$/.test(c.hash)).toBe(true)
    expect(c.hash).not.toContain(c.token)
  })

  it('expira em uma semana por padrão', () => {
    const c = gerarConvite(AGORA)
    expect(c.expiraEm.toISOString()).toBe('2026-08-02T13:00:00.000Z')
    expect(VALIDADE_CONVITE_DIAS).toBe(7)
  })

  it('aceita validade configurada', () => {
    expect(gerarConvite(AGORA, 1).expiraEm.toISOString()).toBe('2026-07-27T13:00:00.000Z')
  })
})

describe('conferência do convite', () => {
  it('aceita o token correto', () => {
    const c = gerarConvite(AGORA)
    expect(conferirConvite(c.token, c.hash)).toBe(true)
  })

  it('tolera como a pessoa digita: minúscula, hífen, espaço', () => {
    const c = gerarConvite(AGORA)
    expect(conferirConvite(c.token.toLowerCase(), c.hash)).toBe(true)
    expect(conferirConvite(formatarConvite(c.token), c.hash)).toBe(true)
    expect(conferirConvite(` ${c.token} `, c.hash)).toBe(true)
    expect(conferirConvite(c.token.match(/.{1,4}/g)!.join(' '), c.hash)).toBe(true)
  })

  it('recusa token errado, mesmo com um caractere de diferença', () => {
    const c = gerarConvite(AGORA)
    const trocado = `${c.token.slice(0, 31)}${c.token[31] === 'A' ? 'B' : 'A'}`
    expect(conferirConvite(trocado, c.hash)).toBe(false)
  })

  it('recusa tamanho errado — prefixo correto não passa', () => {
    const c = gerarConvite(AGORA)
    expect(conferirConvite(c.token.slice(0, 31), c.hash)).toBe(false)
    expect(conferirConvite(`${c.token}A`, c.hash)).toBe(false)
    expect(conferirConvite('', c.hash)).toBe(false)
  })

  it('recusa quando não há hash guardado', () => {
    const c = gerarConvite(AGORA)
    expect(conferirConvite(c.token, null)).toBe(false)
    expect(conferirConvite(c.token, '')).toBe(false)
    expect(conferirConvite(c.token, 'nao-e-hash')).toBe(false)
    expect(conferirConvite(c.token, '0'.repeat(63))).toBe(false)
  })

  it('hash em maiúscula ainda confere', () => {
    const c = gerarConvite(AGORA)
    expect(conferirConvite(c.token, c.hash.toUpperCase())).toBe(true)
  })

  it('o hash é estável para o mesmo token normalizado', () => {
    expect(hashDoToken('abc-def')).toBe(hashDoToken('ABCDEF'))
  })
})

describe('normalização', () => {
  it('remove tudo que não é do alfabeto e sobe para maiúscula', () => {
    expect(normalizar('a3f7-k92m')).toBe('A3F7K92M')
    expect(normalizar('  a 3 f  ')).toBe('A3F')
    expect(normalizar('a.b_c!d')).toBe('ABCD')
  })
})

describe('formatação para leitura', () => {
  it('quebra em blocos de 4', () => {
    expect(formatarConvite('A3F7K92MXY4B')).toBe('A3F7-K92M-XY4B')
  })

  it('é reversível pela normalização', () => {
    const c = gerarConvite(AGORA)
    expect(normalizar(formatarConvite(c.token))).toBe(c.token)
  })
})

describe('expiração', () => {
  it('vale até o prazo', () => {
    expect(conviteExpirou(new Date('2026-07-27T00:00:00Z'), AGORA)).toBe(false)
    expect(conviteExpirou(new Date('2026-07-25T00:00:00Z'), AGORA)).toBe(true)
  })

  it('sem prazo é expirado — nunca o contrário', () => {
    // Convite sem data seria convite eterno. Na dúvida, recusa.
    expect(conviteExpirou(null, AGORA)).toBe(true)
  })
})

describe('token de sessão', () => {
  it('tem entropia alta e não repete', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => gerarTokenDeSessao().token))
    expect(tokens.size).toBe(200)
    expect(gerarTokenDeSessao().token.length).toBeGreaterThanOrEqual(43)
  })

  it('o hash confere e não contém o token', () => {
    const s = gerarTokenDeSessao()
    expect(hashDoTokenDeSessao(s.token)).toBe(s.hash)
    expect(s.hash).not.toContain(s.token)
  })

  it('NÃO normaliza — maiúscula e minúscula são tokens diferentes', () => {
    // Normalizar reduziria o espaço de busca do cookie. É o oposto do convite,
    // que é digitado por uma pessoa.
    const s = gerarTokenDeSessao()
    if (s.token.toUpperCase() !== s.token) {
      expect(hashDoTokenDeSessao(s.token.toUpperCase())).not.toBe(s.hash)
    }
    expect(hashDoTokenDeSessao('abc')).not.toBe(hashDoTokenDeSessao('ABC'))
  })

  it('é seguro para cookie: só base64url', () => {
    for (let i = 0; i < 50; i++) {
      expect(/^[A-Za-z0-9_-]+$/.test(gerarTokenDeSessao().token)).toBe(true)
    }
  })
})

describe('senha do paciente', () => {
  const dados = {
    nome: 'Joana Pereira da Silva',
    email: 'joana@exemplo.com',
    nascimento: '1988-03-12',
    cpf: '52998224725',
  }

  it('aceita senha razoável', () => {
    expect(avaliarSenhaPaciente('dente azul 42', dados).aceita).toBe(true)
  })

  it('exige 10 caracteres — menos que o staff, e por quê está no comentário', () => {
    expect(avaliarSenhaPaciente('curta1', dados).problemas.join(' ')).toContain('10 caracteres')
    expect(avaliarSenhaPaciente('dez letras', dados).aceita).toBe(true)
  })

  it('RECUSA a data de nascimento em todas as formas que uma pessoa digita', () => {
    // É o primeiro palpite contra um paciente.
    for (const senha of [
      'joaninha12031988',
      'senhaforte120388',
      'abc19880312xyz',
      'minha12/03/1988',
      'nasci em 1988 ok',
    ]) {
      const r = avaliarSenhaPaciente(senha, dados)
      expect(r.problemas.join(' '), senha).toContain('data de nascimento')
    }
  })

  it('recusa o CPF', () => {
    expect(avaliarSenhaPaciente('meucpf52998224725', dados).problemas.join(' ')).toContain('CPF')
  })

  it('recusa senha só de números', () => {
    expect(avaliarSenhaPaciente('9182736450', dados).problemas.join(' ')).toContain(
      'letras também',
    )
  })

  it('recusa o próprio nome', () => {
    expect(avaliarSenhaPaciente('joanapereira99', dados).problemas.join(' ')).toContain('nome')
  })

  it('funciona sem dados de contexto', () => {
    expect(avaliarSenhaPaciente('uma frase boa').aceita).toBe(true)
  })

  it('acumula problemas em vez de parar no primeiro', () => {
    // Quem está criando a senha precisa ver tudo que falta de uma vez.
    const r = avaliarSenhaPaciente('1988', dados)
    expect(r.problemas.length).toBeGreaterThan(1)
  })
})
