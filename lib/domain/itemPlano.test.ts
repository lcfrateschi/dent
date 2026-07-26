import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  type ProcedimentoRef,
  type StatusItemPlano,
  calcularValor,
  exigirItemCoerente,
  exigirTransicao,
  podeExcluir,
  podeTransicionar,
} from './itemPlano'

const RESTAURACAO: ProcedimentoRef = {
  id: 'p-rest',
  nome: 'Restauração em resina composta',
  requerDente: true,
  requerFace: true,
}
const EXTRACAO: ProcedimentoRef = {
  id: 'p-ext',
  nome: 'Exodontia simples',
  requerDente: true,
  requerFace: false,
}
const PROFILAXIA: ProcedimentoRef = {
  id: 'p-prof',
  nome: 'Profilaxia',
  requerDente: false,
  requerFace: false,
}

describe('máquina de estados do item de plano', () => {
  it('percorre o caminho do dinheiro', () => {
    expect(podeTransicionar('proposto', 'aprovado')).toBe(true)
    expect(podeTransicionar('aprovado', 'executado')).toBe(true)
    expect(podeTransicionar('executado', 'faturado')).toBe(true)
    expect(podeTransicionar('faturado', 'recebido')).toBe(true)
  })

  it('não deixa pular etapa', () => {
    expect(podeTransicionar('proposto', 'executado')).toBe(false)
    expect(podeTransicionar('proposto', 'faturado')).toBe(false)
    expect(podeTransicionar('aprovado', 'recebido')).toBe(false)
    expect(podeTransicionar('aprovado', 'recusado')).toBe(false) // recusa é antes de aprovar
  })

  it('trata glosa como recuperável — recurso deferido volta a faturado', () => {
    expect(podeTransicionar('faturado', 'glosado')).toBe(true)
    expect(podeTransicionar('glosado', 'faturado')).toBe(true)
    expect(podeTransicionar('glosado', 'cancelado')).toBe(true)
    // Mas glosado não vira recebido direto: tem que voltar por faturado.
    expect(podeTransicionar('glosado', 'recebido')).toBe(false)
  })

  it('trata recebido, recusado e cancelado como terminais', () => {
    const todos: StatusItemPlano[] = [
      'proposto',
      'aprovado',
      'recusado',
      'executado',
      'faturado',
      'recebido',
      'glosado',
      'cancelado',
    ]
    for (const terminal of ['recebido', 'recusado', 'cancelado'] as const) {
      for (const destino of todos) {
        expect(podeTransicionar(terminal, destino), `${terminal} → ${destino}`).toBe(false)
      }
    }
  })

  it('permite cancelar até a execução, mas não depois de faturado', () => {
    expect(podeTransicionar('proposto', 'cancelado')).toBe(true)
    expect(podeTransicionar('aprovado', 'cancelado')).toBe(true)
    expect(podeTransicionar('executado', 'cancelado')).toBe(true)
    expect(podeTransicionar('faturado', 'cancelado')).toBe(false)
  })

  it('só permite excluir item ainda proposto — executado entrou no prontuário', () => {
    expect(podeExcluir('proposto')).toBe(true)
    for (const s of ['aprovado', 'executado', 'faturado', 'recebido'] as const) {
      expect(podeExcluir(s), `${s} não deveria ser excluível`).toBe(false)
    }
  })

  it('lança com código e lista de destinos possíveis', () => {
    try {
      exigirTransicao('proposto', 'faturado')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('ITEM_TRANSICAO_INVALIDA')
      expect((e as ErroDominio).detalhes?.possiveis).toEqual(['aprovado', 'recusado', 'cancelado'])
    }
  })
})

describe('coerência entre catálogo e item', () => {
  it('aceita item completo e correto', () => {
    expect(() =>
      exigirItemCoerente({ procedimento: RESTAURACAO, denteFdi: 16, faces: ['oclusal', 'mesial'] }),
    ).not.toThrow()
    expect(() => exigirItemCoerente({ procedimento: EXTRACAO, denteFdi: 38 })).not.toThrow()
    expect(() => exigirItemCoerente({ procedimento: PROFILAXIA })).not.toThrow()
  })

  it('exige dente em procedimento por dente', () => {
    // Faltando o dente, o erro é do dente — mesmo que as faces tenham vindo.
    for (const item of [
      { procedimento: RESTAURACAO, faces: ['oclusal'] as const },
      { procedimento: EXTRACAO, denteFdi: null },
      { procedimento: RESTAURACAO, denteFdi: undefined, faces: ['oclusal'] as const },
    ]) {
      try {
        exigirItemCoerente(item)
        expect.unreachable('deveria ter lançado')
      } catch (e) {
        expect((e as ErroDominio).codigo).toBe('ITEM_SEM_DENTE')
      }
    }
  })

  it('rejeita catálogo incoerente: exige face mas não exige dente', () => {
    // Sem esta guarda, as faces passariam sem validação anatômica.
    // O banco também barra, via CHECK procedimento_face_implica_dente.
    try {
      exigirItemCoerente({
        procedimento: { id: 'p-x', nome: 'Procedimento torto', requerDente: false, requerFace: true },
        faces: ['oclusal'],
      })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('PROCEDIMENTO_INCOERENTE')
    }
  })

  it('recusa dente em procedimento geral', () => {
    try {
      exigirItemCoerente({ procedimento: PROFILAXIA, denteFdi: 16 })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('ITEM_DENTE_INDEVIDO')
    }
  })

  it('exige face quando o procedimento é por face', () => {
    try {
      exigirItemCoerente({ procedimento: RESTAURACAO, denteFdi: 16, faces: [] })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('ITEM_SEM_FACE')
    }
  })

  it('recusa face em procedimento que não é por face', () => {
    try {
      exigirItemCoerente({ procedimento: EXTRACAO, denteFdi: 38, faces: ['oclusal'] })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('ITEM_FACE_INDEVIDA')
    }
  })

  it('propaga a validação anatômica da face', () => {
    // 11 é incisivo: não tem oclusal.
    try {
      exigirItemCoerente({ procedimento: RESTAURACAO, denteFdi: 11, faces: ['oclusal'] })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('FACE_INVALIDA')
    }
  })

  it('rejeita FDI inexistente', () => {
    try {
      exigirItemCoerente({ procedimento: EXTRACAO, denteFdi: 19 })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('DENTE_INEXISTENTE')
    }
  })
})

describe('precificação por cobertura', () => {
  it('particular: valor de tabela, sem coparticipação', () => {
    expect(calcularValor({ cobertura: 'particular', valorTabela: '350.00' })).toEqual({
      valor: '350.00',
      valorCoparticipacao: '0.00',
    })
  })

  it('convênio com cobertura integral: coparticipação zero', () => {
    expect(
      calcularValor({ cobertura: 'convenio', valorConvenio: '120.00', coberturaPct: '100' }),
    ).toEqual({ valor: '120.00', valorCoparticipacao: '0.00' })
  })

  it('convênio com coparticipação: paciente paga a fatia não coberta', () => {
    expect(
      calcularValor({ cobertura: 'convenio', valorConvenio: '200.00', coberturaPct: '70' }),
    ).toEqual({ valor: '200.00', valorCoparticipacao: '60.00' })
  })

  it('cobertura zero: paciente paga tudo, mas o item segue sendo de convênio', () => {
    expect(
      calcularValor({ cobertura: 'convenio', valorConvenio: '80.00', coberturaPct: '0' }),
    ).toEqual({ valor: '80.00', valorCoparticipacao: '80.00' })
  })

  it('arredonda a coparticipação ao centavo sem perder dinheiro', () => {
    // 33.33% de 10.00 = 3.333 → coberto 3.33, copart 6.67. Soma = 10.00.
    const r = calcularValor({ cobertura: 'convenio', valorConvenio: '10.00', coberturaPct: '33.33' })
    expect(r.valorCoparticipacao).toBe('6.67')
  })

  it('rejeita percentual fora da faixa', () => {
    for (const pct of ['-1', '101', 'abc']) {
      expect(
        () => calcularValor({ cobertura: 'convenio', valorConvenio: '100.00', coberturaPct: pct }),
        `deveria rejeitar "${pct}"`,
      ).toThrowError(ErroDominio)
    }
  })
})
