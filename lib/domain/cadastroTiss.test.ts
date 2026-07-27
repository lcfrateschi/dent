import { describe, expect, it } from 'vitest'
import {
  MSG_CBOS_INVALIDO,
  MSG_CNES_INVALIDO,
  cbosEhValido,
  cnesEhValido,
  normalizarCbos,
  normalizarCnes,
} from './cadastroTiss'

/**
 * Estes testes existem para a trava **recusar**, não para ela aceitar.
 *
 * Uma validação de formato testada só com valor bom passa igual se ela for
 * `return true`. Cada caso aqui tem o par: o certo entra, e o **quase certo** — que é
 * o que se digita de verdade — é recusado.
 */

describe('CNES', () => {
  it('aceita sete dígitos', () => {
    expect(cnesEhValido('1234567')).toBe(true)
    // Colado do site do CNES, com pontuação.
    expect(cnesEhValido('123.45-67')).toBe(true)
  })

  it('recusa o que se digita errado na prática', () => {
    expect(cnesEhValido('123456')).toBe(false) // um dígito a menos
    expect(cnesEhValido('12345678')).toBe(false) // um a mais
    expect(cnesEhValido('')).toBe(false)
    expect(cnesEhValido('123456A')).toBe(false) // letra no lugar do dígito
  })

  it('não inventa validade: 0000000 passa no formato', () => {
    // Registrado de propósito. Sete zeros é formato válido e estabelecimento
    // inexistente — a função é de FORMATO, e quem confia nela para mais que isso
    // vai descobrir na glosa. Se um dia houver dígito verificador de CNES
    // documentado, é aqui que ele entra.
    expect(cnesEhValido('0000000')).toBe(true)
  })

  it('normaliza para só os dígitos', () => {
    expect(normalizarCnes(' 12.345-67 ')).toBe('1234567')
  })
})

describe('CBO-S', () => {
  it('aceita a família de cirurgião-dentista', () => {
    expect(cbosEhValido('223208')).toBe(true)
    expect(cbosEhValido('223293')).toBe(true)
  })

  it('recusa outra família — é o caso que a operadora glosa', () => {
    // 3224 é auxiliar/técnico em saúde bucal: profissão real, CBO real, e errado
    // nesta tabela, que é de quem tem CRO.
    expect(cbosEhValido('322405')).toBe(false)
    // Médico, para o caso de alguém copiar de outro sistema.
    expect(cbosEhValido('225125')).toBe(false)
  })

  it('recusa tamanho errado com o prefixo certo', () => {
    // Este é o caso que um `startsWith('2232')` sozinho deixaria passar.
    expect(cbosEhValido('2232')).toBe(false)
    expect(cbosEhValido('2232080')).toBe(false)
  })

  it('normaliza para só os dígitos', () => {
    expect(normalizarCbos('2232-08')).toBe('223208')
  })
})

describe('as mensagens dizem o que fazer', () => {
  it('a do CNES diz o tamanho e que pode ficar em branco', () => {
    // Mensagem que só diz "inválido" faz a pessoa tentar de novo igual.
    expect(MSG_CNES_INVALIDO).toContain('7 dígitos')
    expect(MSG_CNES_INVALIDO).toContain('branco')
  })

  it('a do CBO-S explica POR QUE a família é obrigatória', () => {
    // Sem o motivo, a recusa parece capricho do sistema.
    expect(MSG_CBOS_INVALIDO).toContain('2232')
    expect(MSG_CBOS_INVALIDO).toContain('cirurgião-dentista')
  })
})
