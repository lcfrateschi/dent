import { describe, expect, it } from 'vitest'
import {
  cepEhValido,
  cpfEhValido,
  formatarCep,
  formatarCpf,
  formatarTelefone,
  normalizarCpf,
  telefoneEhValido,
  ufEhValida,
} from './cpf'
import { ErroDominio } from './erros'

describe('CPF', () => {
  it('aceita CPFs com dígitos verificadores corretos', () => {
    // Gerados para ter DV válido; não pertencem a ninguém.
    for (const cpf of ['52998224725', '11144477735', '12345678909']) {
      expect(cpfEhValido(cpf), `${cpf} deveria ser válido`).toBe(true)
    }
  })

  it('aceita com pontuação', () => {
    expect(cpfEhValido('529.982.247-25')).toBe(true)
    expect(cpfEhValido('  529.982.247-25  ')).toBe(true)
  })

  it('rejeita dígito verificador errado', () => {
    expect(cpfEhValido('52998224726')).toBe(false) // último dígito alterado
    expect(cpfEhValido('52998224715')).toBe(false) // penúltimo alterado
  })

  it('rejeita sequência de dígito repetido — é o que se digita para furar campo', () => {
    for (let d = 0; d <= 9; d++) {
      const repetido = String(d).repeat(11)
      expect(cpfEhValido(repetido), `${repetido} não deveria passar`).toBe(false)
    }
  })

  it('rejeita tamanho errado', () => {
    for (const ruim of ['', '1', '1234567890', '123456789012', 'abcdefghijk']) {
      expect(cpfEhValido(ruim), `"${ruim}" não deveria passar`).toBe(false)
    }
  })

  it('normaliza para 11 dígitos e lança em CPF inválido', () => {
    expect(normalizarCpf('529.982.247-25')).toBe('52998224725')
    expect(() => normalizarCpf('11111111111')).toThrowError(ErroDominio)
    try {
      normalizarCpf('123')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('CPF_INVALIDO')
    }
  })

  it('formata só para apresentação', () => {
    expect(formatarCpf('52998224725')).toBe('529.982.247-25')
    // Entrada fora do formato volta intacta, sem quebrar a tela.
    expect(formatarCpf('123')).toBe('123')
  })
})

describe('telefone', () => {
  it('aceita fixo com 10 dígitos e celular com 11', () => {
    expect(telefoneEhValido('1132654789')).toBe(true)
    expect(telefoneEhValido('11987654321')).toBe(true)
    expect(telefoneEhValido('(11) 98765-4321')).toBe(true)
  })

  it('exige o 9 no celular', () => {
    // 11 dígitos com o terceiro diferente de 9 não é celular válido.
    expect(telefoneEhValido('11887654321')).toBe(false)
  })

  it('rejeita DDD inexistente e tamanho errado', () => {
    expect(telefoneEhValido('0198765432')).toBe(false)
    expect(telefoneEhValido('987654321')).toBe(false)
    expect(telefoneEhValido('119876543210')).toBe(false)
  })

  it('formata conforme o tamanho', () => {
    expect(formatarTelefone('11987654321')).toBe('(11) 98765-4321')
    expect(formatarTelefone('1132654789')).toBe('(11) 3265-4789')
  })
})

describe('CEP e UF', () => {
  it('valida e formata CEP', () => {
    expect(cepEhValido('01310100')).toBe(true)
    expect(cepEhValido('01310-100')).toBe(true)
    expect(cepEhValido('0131010')).toBe(false)
    expect(formatarCep('01310100')).toBe('01310-100')
  })

  it('valida UF, sem diferenciar caixa', () => {
    expect(ufEhValida('SP')).toBe(true)
    expect(ufEhValida('sp')).toBe(true)
    expect(ufEhValida('XX')).toBe(false)
    expect(ufEhValida('')).toBe(false)
  })
})
