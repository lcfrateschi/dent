import { describe, expect, it } from 'vitest'
import { achatarErros, pacienteSchema } from './schema'

const base = {
  nome: 'Maria Silva',
  dataNascimento: '1990-05-10',
}

function validar(extra: Record<string, unknown> = {}) {
  return pacienteSchema.safeParse({ ...base, ...extra })
}

describe('cadastro de paciente', () => {
  it('aceita o mínimo: nome completo e data de nascimento', () => {
    const r = validar()
    expect(r.success, r.success ? '' : JSON.stringify(achatarErros(r.error))).toBe(true)
  })

  it('exige nome e sobrenome', () => {
    expect(validar({ nome: 'Maria' }).success).toBe(false)
    expect(validar({ nome: 'Ma' }).success).toBe(false)
    expect(validar({ nome: 'Maria Silva' }).success).toBe(true)
  })

  it('converte campo vazio em NULL, não em string vazia', () => {
    // Se '' fosse gravado, o índice único de CPF trataria "sem CPF" como valor
    // repetido e o segundo paciente sem CPF falharia.
    const r = validar({ cpf: '', email: '', telefone: '   ', observacoes: '' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.cpf).toBeNull()
      expect(r.data.email).toBeNull()
      expect(r.data.telefone).toBeNull()
      expect(r.data.observacoes).toBeNull()
    }
  })
})

describe('CPF', () => {
  it('é opcional — criança costuma não ter', () => {
    expect(validar({ cpf: '' }).success).toBe(true)
  })

  it('quando informado, precisa ser válido', () => {
    expect(validar({ cpf: '52998224725' }).success).toBe(true)
    expect(validar({ cpf: '52998224726' }).success).toBe(false)
    expect(validar({ cpf: '11111111111' }).success).toBe(false)
  })

  it('normaliza para 11 dígitos, tirando a pontuação', () => {
    const r = validar({ cpf: '529.982.247-25' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.cpf).toBe('52998224725')
  })
})

describe('data de nascimento', () => {
  it('recusa formato inválido', () => {
    for (const ruim of ['', '10/05/1990', '1990-5-10', '1990-02-30']) {
      expect(validar({ dataNascimento: ruim }).success, `"${ruim}"`).toBe(false)
    }
  })

  it('recusa data no futuro', () => {
    expect(validar({ dataNascimento: '2099-01-01' }).success).toBe(false)
  })

  it('recusa ano implausível — pega dígito trocado', () => {
    expect(validar({ dataNascimento: '0990-05-10' }).success).toBe(false)
  })
})

describe('responsável legal', () => {
  const menor = new Date()
  menor.setFullYear(menor.getFullYear() - 8)
  const nascimentoMenor = menor.toISOString().slice(0, 10)

  it('menor de idade exige responsável legal', () => {
    const r = validar({ dataNascimento: nascimentoMenor })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(achatarErros(r.error).responsavelLegalId).toMatch(/responsável legal/i)
    }
  })

  it('menor com responsável passa', () => {
    const r = validar({
      dataNascimento: nascimentoMenor,
      responsavelLegalId: '33333333-3333-4333-8333-333333333333',
    })
    expect(r.success, r.success ? '' : JSON.stringify(achatarErros(r.error))).toBe(true)
  })

  it('maior de idade não precisa de responsável', () => {
    expect(validar({ dataNascimento: '1990-05-10' }).success).toBe(true)
  })

  it('recusa responsável que não seja UUID', () => {
    expect(validar({ responsavelLegalId: 'nao-e-uuid' }).success).toBe(false)
  })
})

describe('contato', () => {
  it('aceita fixo e celular, normalizando', () => {
    const r = validar({ telefone: '(11) 3265-4789', telefoneWhatsapp: '(11) 98765-4321' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.telefone).toBe('1132654789')
      expect(r.data.telefoneWhatsapp).toBe('11987654321')
    }
  })

  it('recusa telefone e e-mail malformados', () => {
    expect(validar({ telefone: '123' }).success).toBe(false)
    expect(validar({ email: 'nao-e-email' }).success).toBe(false)
  })
})

describe('endereço', () => {
  it('normaliza CEP e UF', () => {
    const r = validar({ cep: '01310-100', uf: 'sp' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.cep).toBe('01310100')
      expect(r.data.uf).toBe('SP')
    }
  })

  it('recusa CEP e UF inválidos', () => {
    expect(validar({ cep: '0131010' }).success).toBe(false)
    expect(validar({ uf: 'XX' }).success).toBe(false)
  })
})

describe('valores padrão', () => {
  it('assume sexo não informado e status ativo', () => {
    const r = validar()
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.sexo).toBe('nao_informado')
      expect(r.data.status).toBe('ativo')
    }
  })

  it('recusa enum fora da lista', () => {
    expect(validar({ sexo: 'qualquer' }).success).toBe(false)
    expect(validar({ status: 'excluido' }).success).toBe(false)
  })
})

describe('achatarErros', () => {
  it('devolve uma mensagem por campo', () => {
    const r = validar({ nome: 'X', cpf: '123', email: 'ruim' })
    expect(r.success).toBe(false)
    if (!r.success) {
      const erros = achatarErros(r.error)
      expect(erros.nome).toBeTruthy()
      expect(erros.cpf).toBeTruthy()
      expect(erros.email).toBeTruthy()
    }
  })
})
