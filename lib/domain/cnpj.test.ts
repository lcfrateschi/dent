import { describe, expect, it } from 'vitest'
import { cnpjEhValido, formatarCep, formatarCnpj, normalizarCnpj } from './cnpj'

describe('cnpjEhValido', () => {
  it('aceita CNPJ com dígitos verificadores corretos', () => {
    // Gerados pela própria regra dos dígitos; nenhum é de empresa real conhecida.
    for (const cnpj of ['11222333000181', '11444777000161', '04252011000110']) {
      expect(cnpjEhValido(cnpj), cnpj).toBe(true)
    }
  })

  it('aceita com pontuação, porque é como a pessoa digita', () => {
    expect(cnpjEhValido('11.222.333/0001-81')).toBe(true)
  })

  it('recusa dígito verificador errado', () => {
    expect(cnpjEhValido('11222333000182')).toBe(false)
    expect(cnpjEhValido('11222333000191')).toBe(false)
  })

  it('recusa comprimento diferente de 14', () => {
    expect(cnpjEhValido('1122233300018')).toBe(false)
    expect(cnpjEhValido('112223330001811')).toBe(false)
    expect(cnpjEhValido('')).toBe(false)
  })

  it('recusa todos os dígitos iguais', () => {
    // Passam na aritmética dos verificadores e nunca são CNPJ real — a mesma
    // armadilha do 111.111.111-11 no CPF.
    for (const d of ['00000000000000', '11111111111111', '99999999999999']) {
      expect(cnpjEhValido(d), d).toBe(false)
    }
  })

  it('recusa texto', () => {
    expect(cnpjEhValido('abcdefghijklmn')).toBe(false)
  })
})

describe('formatação', () => {
  it('formata CNPJ e devolve a entrada quando não dá', () => {
    expect(formatarCnpj('11222333000181')).toBe('11.222.333/0001-81')
    expect(formatarCnpj('123')).toBe('123')
  })

  it('normaliza para só dígitos, que é o formato do banco', () => {
    expect(normalizarCnpj('11.222.333/0001-81')).toBe('11222333000181')
  })

  it('formata CEP', () => {
    expect(formatarCep('01310100')).toBe('01310-100')
    expect(formatarCep('013')).toBe('013')
  })
})
