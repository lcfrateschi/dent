import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  type Evolucao,
  assinaturaConfere,
  calcularAssinatura,
  ehRascunho,
  exigirPodeEditar,
  exigirRetificacaoValida,
  ordenarCadeia,
  podeEditar,
} from './prontuario'

const PROF = 'prof-1'
const OUTRO_PROF = 'prof-2'
const PACIENTE = 'pac-1'

function evolucao(over: Partial<Evolucao> = {}): Evolucao {
  return {
    id: 'ev-1',
    pacienteId: PACIENTE,
    profissionalId: PROF,
    texto: 'Restauração no 16, faces oclusal e mesial.',
    assinadoEm: null,
    retificaId: null,
    criadoEm: new Date('2026-08-10T14:00:00Z'),
    ...over,
  }
}

const ASSINADA = evolucao({ assinadoEm: new Date('2026-08-10T14:30:00Z') })

describe('rascunho e edição', () => {
  it('sem assinatura é rascunho e o autor edita', () => {
    const e = evolucao()
    expect(ehRascunho(e)).toBe(true)
    expect(podeEditar(e, PROF)).toBe(true)
    expect(() => exigirPodeEditar(e, PROF)).not.toThrow()
  })

  it('assinada é imutável, mesmo para o autor', () => {
    expect(ehRascunho(ASSINADA)).toBe(false)
    expect(podeEditar(ASSINADA, PROF)).toBe(false)
    try {
      exigirPodeEditar(ASSINADA, PROF)
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('EVOLUCAO_ASSINADA')
      expect((e as Error).message).toContain('retificação')
    }
  })

  it('rascunho de outro profissional não é editável', () => {
    const e = evolucao()
    expect(podeEditar(e, OUTRO_PROF)).toBe(false)
    try {
      exigirPodeEditar(e, OUTRO_PROF)
      expect.unreachable('deveria ter lançado')
    } catch (err) {
      expect((err as ErroDominio).codigo).toBe('EVOLUCAO_OUTRO_AUTOR')
    }
  })
})

describe('assinatura', () => {
  const dados = {
    evolucaoId: 'ev-1',
    pacienteId: PACIENTE,
    profissionalId: PROF,
    texto: 'Restauração no 16.',
    assinadoEm: new Date('2026-08-10T14:30:00Z'),
  }

  it('é determinística e tem 64 hex', () => {
    const a = calcularAssinatura(dados)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(calcularAssinatura(dados)).toBe(a)
  })

  it('ignora espaço em volta do texto, mas não o conteúdo', () => {
    expect(calcularAssinatura({ ...dados, texto: '  Restauração no 16.  ' })).toBe(
      calcularAssinatura(dados),
    )
    expect(calcularAssinatura({ ...dados, texto: 'Restauração no 17.' })).not.toBe(
      calcularAssinatura(dados),
    )
  })

  it('muda se qualquer campo assinado mudar', () => {
    const base = calcularAssinatura(dados)
    expect(calcularAssinatura({ ...dados, profissionalId: OUTRO_PROF })).not.toBe(base)
    expect(calcularAssinatura({ ...dados, pacienteId: 'pac-2' })).not.toBe(base)
    expect(calcularAssinatura({ ...dados, evolucaoId: 'ev-9' })).not.toBe(base)
    expect(calcularAssinatura({ ...dados, assinadoEm: new Date('2026-08-10T14:31:00Z') })).not.toBe(base)
  })

  it('detecta texto adulterado direto no banco', () => {
    const assinadoEm = new Date('2026-08-10T14:30:00Z')
    const e = evolucao({ assinadoEm })
    const hash = calcularAssinatura({
      evolucaoId: e.id,
      pacienteId: e.pacienteId,
      profissionalId: e.profissionalId,
      texto: e.texto,
      assinadoEm,
    })

    expect(assinaturaConfere({ ...e, assinaturaHash: hash })).toBe(true)
    // Alguém editou `texto` por fora, sem recalcular o hash.
    expect(assinaturaConfere({ ...e, texto: 'Outra coisa', assinaturaHash: hash })).toBe(false)
  })

  it('não confere quando falta assinatura ou hash', () => {
    expect(assinaturaConfere({ ...evolucao(), assinaturaHash: null })).toBe(false)
    expect(assinaturaConfere({ ...ASSINADA, assinaturaHash: null })).toBe(false)
    expect(assinaturaConfere({ ...evolucao(), assinaturaHash: 'a'.repeat(64) })).toBe(false)
  })
})

describe('retificação', () => {
  const base = {
    texto: 'Correção: a restauração foi no 17, não no 16.',
    motivo: 'Dente registrado incorretamente.',
    profissionalId: PROF,
    retificacoesDoAlvo: [] as { id: string }[],
  }

  it('aceita retificação de evolução assinada com motivo', () => {
    expect(() => exigirRetificacaoValida({ ...base, alvo: ASSINADA })).not.toThrow()
  })

  it('recusa retificar rascunho — basta editar', () => {
    try {
      exigirRetificacaoValida({ ...base, alvo: evolucao() })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('RETIFICA_RASCUNHO')
    }
  })

  it('exige motivo e texto não vazios', () => {
    for (const over of [{ motivo: '   ' }, { motivo: '' }]) {
      try {
        exigirRetificacaoValida({ ...base, ...over, alvo: ASSINADA })
        expect.unreachable('deveria ter lançado')
      } catch (e) {
        expect((e as ErroDominio).codigo).toBe('RETIFICA_SEM_MOTIVO')
      }
    }
    try {
      exigirRetificacaoValida({ ...base, texto: '  ', alvo: ASSINADA })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('EVOLUCAO_VAZIA')
    }
  })

  it('permite retificar apenas uma vez — cadeia, não árvore', () => {
    try {
      exigirRetificacaoValida({ ...base, alvo: ASSINADA, retificacoesDoAlvo: [{ id: 'ev-2' }] })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('RETIFICA_JA_RETIFICADA')
      expect((e as ErroDominio).detalhes?.retificacaoExistente).toBe('ev-2')
    }
  })

  it('permite retificar uma retificação — corrigir a correção', () => {
    const retificacao = evolucao({
      id: 'ev-2',
      retificaId: 'ev-1',
      assinadoEm: new Date('2026-08-11T10:00:00Z'),
    })
    expect(() => exigirRetificacaoValida({ ...base, alvo: retificacao })).not.toThrow()
  })
})

describe('ordenação da cadeia do prontuário', () => {
  it('mostra original antes da retificação', () => {
    const original = evolucao({ id: 'ev-1', criadoEm: new Date('2026-08-10T14:00:00Z') })
    const correcao = evolucao({
      id: 'ev-2',
      retificaId: 'ev-1',
      criadoEm: new Date('2026-08-11T10:00:00Z'),
    })
    // Entrada fora de ordem de propósito.
    expect(ordenarCadeia([correcao, original]).map((e) => e.id)).toEqual(['ev-1', 'ev-2'])
  })

  it('segue cadeia de três níveis', () => {
    const a = evolucao({ id: 'a', criadoEm: new Date('2026-08-10T10:00:00Z') })
    const b = evolucao({ id: 'b', retificaId: 'a', criadoEm: new Date('2026-08-11T10:00:00Z') })
    const c = evolucao({ id: 'c', retificaId: 'b', criadoEm: new Date('2026-08-12T10:00:00Z') })
    expect(ordenarCadeia([c, a, b]).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('intercala várias cadeias por data da raiz', () => {
    const a1 = evolucao({ id: 'a1', criadoEm: new Date('2026-08-10T10:00:00Z') })
    const a2 = evolucao({ id: 'a2', retificaId: 'a1', criadoEm: new Date('2026-08-15T10:00:00Z') })
    const b1 = evolucao({ id: 'b1', criadoEm: new Date('2026-08-12T10:00:00Z') })
    expect(ordenarCadeia([b1, a2, a1]).map((e) => e.id)).toEqual(['a1', 'a2', 'b1'])
  })

  it('não entra em laço se os dados vierem corrompidos com ciclo', () => {
    // Cenário impossível pelas constraints, mas a função não pode travar a tela do dentista.
    const a = evolucao({ id: 'a', retificaId: 'b' })
    const b = evolucao({ id: 'b', retificaId: 'a' })
    expect(() => ordenarCadeia([a, b])).not.toThrow()
  })

  it('devolve lista vazia para entrada vazia', () => {
    expect(ordenarCadeia([])).toEqual([])
  })
})
