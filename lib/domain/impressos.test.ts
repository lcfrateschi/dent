import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  type DadosAtestado,
  type DadosReceita,
  dataCurta,
  dataLonga,
  montarAtestado,
  montarReceita,
  numeroEmPalavras,
} from './impressos'

const BASE: DadosAtestado = {
  pacienteNome: 'Joana Pereira da Silva',
  pacienteCpf: '52998224725',
  profissionalNome: 'Dra. Helena Marques',
  cro: '54321',
  ufCro: 'sp',
  clinicaNome: 'Clínica Sorriso',
  cidade: 'Campinas',
  atendidoEm: new Date('2026-07-20T14:00:00-03:00'),
}

function texto(i: { paragrafos: readonly string[]; rodape: readonly string[] }): string {
  return [...i.paragrafos, ...i.rodape].join('\n')
}

describe('atestado', () => {
  it('declara o atendimento com nome, CPF e data', () => {
    const a = montarAtestado(BASE)
    expect(a.titulo).toBe('ATESTADO ODONTOLÓGICO')
    expect(texto(a)).toContain('Joana Pereira da Silva')
    expect(texto(a)).toContain('529.982.247-25')
    expect(texto(a)).toContain('20 de julho de 2026')
  })

  it('funciona sem CPF (criança costuma não ter)', () => {
    const a = montarAtestado({ ...BASE, pacienteCpf: null })
    expect(texto(a)).toContain('Joana Pereira da Silva')
    expect(texto(a)).not.toContain('CPF')
  })

  it('sem dias de afastamento é atestado de comparecimento', () => {
    const a = montarAtestado(BASE)
    expect(texto(a)).not.toMatch(/afastamento/i)
  })

  it('com afastamento, escreve o número em dígito E em palavra', () => {
    // Dígito sozinho se altera com uma canetada.
    const a = montarAtestado({ ...BASE, diasAfastamento: 3 })
    expect(texto(a)).toContain('3 (três) dias')
  })

  it('um dia no singular', () => {
    expect(texto(montarAtestado({ ...BASE, diasAfastamento: 1 }))).toContain('1 (um) dia,')
  })

  it('recusa afastamento fora da faixa', () => {
    for (const dias of [0, -1, 91, 365, 1.5]) {
      expect(() => montarAtestado({ ...BASE, diasAfastamento: dias }), String(dias)).toThrowError(
        ErroDominio,
      )
    }
  })

  it('identifica o profissional com CRO e UF em maiúscula', () => {
    const a = montarAtestado(BASE)
    expect(a.rodape.join('\n')).toContain('Dra. Helena Marques')
    expect(a.rodape.join('\n')).toContain('CRO SP 54321')
  })

  it('tem linha de assinatura e local', () => {
    const a = montarAtestado(BASE)
    expect(a.rodape.some((l) => l.includes('___'))).toBe(true)
    expect(a.rodape[0]).toContain('Campinas')
  })

  it('recusa atestado sem paciente ou sem profissional', () => {
    expect(() => montarAtestado({ ...BASE, pacienteNome: '  ' })).toThrowError(ErroDominio)
    expect(() => montarAtestado({ ...BASE, profissionalNome: '' })).toThrowError(ErroDominio)
    expect(() => montarAtestado({ ...BASE, cro: '' })).toThrowError(ErroDominio)
    expect(() => montarAtestado({ ...BASE, atendidoEm: new Date('nada') })).toThrowError(ErroDominio)
  })
})

describe('atestado — CID e sigilo', () => {
  it('NÃO imprime CID por padrão, e diz por quê', () => {
    // O atestado costuma ir para o RH. CID sem autorização é quebra de sigilo.
    const a = montarAtestado({ ...BASE, cid: 'K02.1' })
    expect(texto(a)).not.toContain('K02.1')
    expect(a.avisos.join(' ')).toContain('autorização')
  })

  it('imprime CID quando o paciente autorizou', () => {
    const a = montarAtestado({ ...BASE, cid: 'K02.1', cidAutorizadoPeloPaciente: true })
    expect(texto(a)).toContain('K02.1')
    expect(a.avisos.join(' ')).toContain('autorizou')
  })

  it('autorização falsa ou ausente tem o mesmo efeito', () => {
    for (const autorizado of [false, undefined]) {
      const a = montarAtestado({ ...BASE, cid: 'K02', cidAutorizadoPeloPaciente: autorizado })
      expect(texto(a), String(autorizado)).not.toContain('K02')
    }
  })

  it('recusa CID que não é odontológico', () => {
    // O CD atesta o que trata: K00–K14.
    for (const cid of ['J11', 'F32.1', 'A00', 'K15', 'Z01', 'abc', 'K2']) {
      expect(() => montarAtestado({ ...BASE, cid }), cid).toThrowError(ErroDominio)
    }
  })

  it('aceita a faixa odontológica inteira', () => {
    for (const cid of ['K00', 'K02.1', 'K04', 'K08.1', 'K13', 'K14']) {
      expect(() =>
        montarAtestado({ ...BASE, cid, cidAutorizadoPeloPaciente: true }),
        cid,
      ).not.toThrow()
    }
  })

  it('normaliza minúsculas do CID', () => {
    const a = montarAtestado({ ...BASE, cid: 'k02.1', cidAutorizadoPeloPaciente: true })
    expect(texto(a)).toContain('K02.1')
  })
})

const RECEITA: DadosReceita = {
  pacienteNome: 'Joana Pereira da Silva',
  profissionalNome: 'Dra. Helena Marques',
  cro: '54321',
  ufCro: 'SP',
  clinicaNome: 'Clínica Sorriso',
  cidade: 'Campinas',
  emitidaEm: new Date('2026-07-20T14:00:00-03:00'),
  medicamentos: [
    {
      nome: 'Amoxicilina 500 mg',
      apresentacao: 'cápsulas',
      quantidade: '21 cápsulas',
      posologia: 'Tomar 1 cápsula de 8 em 8 horas, por 7 dias.',
    },
  ],
}

describe('receita', () => {
  it('lista o medicamento com quantidade e posologia', () => {
    const r = montarReceita(RECEITA)
    expect(r.titulo).toBe('RECEITUÁRIO ODONTOLÓGICO')
    expect(texto(r)).toContain('Amoxicilina 500 mg')
    expect(texto(r)).toContain('21 cápsulas')
    expect(texto(r)).toContain('de 8 em 8 horas')
  })

  it('numera os itens', () => {
    const r = montarReceita({
      ...RECEITA,
      medicamentos: [
        ...RECEITA.medicamentos,
        {
          nome: 'Ibuprofeno 600 mg',
          quantidade: '12 comprimidos',
          posologia: 'Tomar 1 comprimido de 8 em 8 horas se dor, por até 3 dias.',
        },
      ],
    })
    expect(texto(r)).toContain('1. Amoxicilina')
    expect(texto(r)).toContain('2. Ibuprofeno')
  })

  it('RECUSA receita sem posologia — a farmácia não dispensa e o paciente inventa', () => {
    expect(() =>
      montarReceita({
        ...RECEITA,
        medicamentos: [{ nome: 'Amoxicilina 500 mg', quantidade: '21', posologia: '' }],
      }),
    ).toThrowError(ErroDominio)

    expect(() =>
      montarReceita({
        ...RECEITA,
        medicamentos: [{ nome: 'Amoxicilina', quantidade: '21', posologia: '1x' }],
      }),
    ).toThrowError(ErroDominio)
  })

  it('recusa sem quantidade e sem nome', () => {
    expect(() =>
      montarReceita({
        ...RECEITA,
        medicamentos: [{ nome: 'Amoxicilina', quantidade: '  ', posologia: 'de 8 em 8 horas' }],
      }),
    ).toThrowError(ErroDominio)

    expect(() =>
      montarReceita({
        ...RECEITA,
        medicamentos: [{ nome: '', quantidade: '21', posologia: 'de 8 em 8 horas' }],
      }),
    ).toThrowError(ErroDominio)
  })

  it('recusa receita vazia e receita absurdamente longa', () => {
    expect(() => montarReceita({ ...RECEITA, medicamentos: [] })).toThrowError(ErroDominio)
    expect(() =>
      montarReceita({
        ...RECEITA,
        medicamentos: Array.from({ length: 11 }, (_, i) => ({
          nome: `Medicamento ${i}`,
          quantidade: '1',
          posologia: 'Tomar 1 por dia.',
        })),
      }),
    ).toThrowError(ErroDominio)
  })

  it('AVISA sobre medicamento de controle especial', () => {
    // Receita de controlado exige receituário próprio — a farmácia recusaria
    // este impresso e o paciente voltaria à clínica.
    for (const nome of ['Diazepam 5 mg', 'diazepam', 'Tramadol 50mg', 'Paracetamol + Codeína']) {
      const r = montarReceita({
        ...RECEITA,
        medicamentos: [{ nome, quantidade: '10', posologia: 'Tomar 1 à noite, por 5 dias.' }],
      })
      expect(r.avisos.join(' '), nome).toContain('controle especial')
      // Avisa, mas não bloqueia: quem sabe o que prescreve é o CD.
      expect(texto(r), nome).toContain(nome)
    }
  })

  it('não avisa sobre medicamento comum', () => {
    const r = montarReceita(RECEITA)
    expect(r.avisos).toHaveLength(0)
  })

  it('inclui orientações quando houver', () => {
    const r = montarReceita({ ...RECEITA, orientacoes: 'Não bochechar nas primeiras 24 horas.' })
    expect(texto(r)).toContain('Não bochechar')
  })
})

describe('datas em português', () => {
  it('escreve por extenso', () => {
    expect(dataLonga(new Date('2026-07-20T12:00:00Z'))).toBe('20 de julho de 2026')
    expect(dataLonga(new Date('2026-03-01T12:00:00Z'))).toBe('1 de março de 2026')
  })

  it('usa o fuso da clínica, não o do servidor', () => {
    // 23:00 em São Paulo é 02:00 do dia seguinte em UTC.
    expect(dataCurta(new Date('2026-07-20T23:00:00-03:00'))).toBe('20/07/2026')
  })

  it('recusa data inválida', () => {
    expect(() => dataLonga(new Date('nada'))).toThrowError(ErroDominio)
  })
})

describe('número em palavras', () => {
  it('cobre a faixa que um atestado usa', () => {
    const esperado: [number, string][] = [
      [1, 'um'],
      [2, 'dois'],
      [3, 'três'],
      [7, 'sete'],
      [10, 'dez'],
      [15, 'quinze'],
      [20, 'vinte'],
      [30, 'trinta'],
      [45, 'quarenta e cinco'],
      [90, 'noventa'],
    ]
    for (const [n, palavra] of esperado) {
      expect(numeroEmPalavras(n), String(n)).toBe(palavra)
    }
  })

  it('recusa entrada inválida', () => {
    expect(() => numeroEmPalavras(-1)).toThrowError(ErroDominio)
    expect(() => numeroEmPalavras(1.5)).toThrowError(ErroDominio)
  })
})
