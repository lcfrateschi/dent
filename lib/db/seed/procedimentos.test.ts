import { paraCentavos } from '@/lib/domain/dinheiro'
import { exigirItemCoerente } from '@/lib/domain/itemPlano'
import { describe, expect, it } from 'vitest'
import { catalogoProcedimentos } from './procedimentos'

/**
 * O catálogo de seed é dado, não código — mas dado incoerente quebra o odontograma
 * e a precificação. Estes testes amarram o seed às regras de lib/domain.
 */
describe('catálogo de procedimentos do seed', () => {
  it('não repete código interno', () => {
    const codigos = catalogoProcedimentos.map((p) => p.codigo)
    expect(new Set(codigos).size, 'há código duplicado').toBe(codigos.length)
  })

  it('não repete nome', () => {
    const nomes = catalogoProcedimentos.map((p) => p.nome)
    expect(new Set(nomes).size, 'há nome duplicado').toBe(nomes.length)
  })

  it('nunca exige face sem exigir dente — o CHECK do banco e o domínio barram', () => {
    for (const p of catalogoProcedimentos) {
      if (p.requerFace) {
        expect(p.requerDente, `"${p.nome}" exige face mas não exige dente`).toBe(true)
      }
    }
  })

  it('passa pela validação de coerência do domínio', () => {
    for (const p of catalogoProcedimentos) {
      const ref = {
        id: p.codigo,
        nome: p.nome,
        requerDente: p.requerDente ?? false,
        requerFace: p.requerFace ?? false,
      }
      // Item preenchido conforme o que o procedimento exige: 16 é molar, tem oclusal.
      const item = {
        procedimento: ref,
        denteFdi: ref.requerDente ? 16 : null,
        faces: ref.requerFace ? (['oclusal'] as const) : null,
      }
      expect(() => exigirItemCoerente(item), `"${p.nome}" não passa na coerência`).not.toThrow()
    }
  })

  it('tem valor monetário em formato válido e positivo', () => {
    for (const p of catalogoProcedimentos) {
      expect(() => paraCentavos(p.valorParticular), `"${p.nome}" tem valor mal formatado`).not.toThrow()
      expect(paraCentavos(p.valorParticular), `"${p.nome}" deveria custar mais que zero`).toBeGreaterThan(0)
    }
  })

  it('tem duração de agenda plausível', () => {
    for (const p of catalogoProcedimentos) {
      const d = p.duracaoMinutos ?? 30
      expect(d, `"${p.nome}" tem duração de ${d} min`).toBeGreaterThanOrEqual(10)
      expect(d, `"${p.nome}" tem duração de ${d} min`).toBeLessThanOrEqual(240)
      expect(d % 5, `"${p.nome}": duração deveria ser múltiplo de 5 para encaixar na grade`).toBe(0)
    }
  })

  it('não traz codigo_tuss inventado — TUSS errado gera glosa', () => {
    for (const p of catalogoProcedimentos) {
      expect(p, `"${p.nome}" não deveria ter codigo_tuss no seed`).not.toHaveProperty('codigoTuss')
    }
  })

  it('cobre as especialidades que a clínica vai usar', () => {
    const especialidades = new Set(catalogoProcedimentos.map((p) => p.especialidade))
    for (const esperada of ['Clínica geral', 'Dentística', 'Endodontia', 'Cirurgia', 'Odontopediatria', 'Prótese']) {
      expect(especialidades, `falta especialidade ${esperada}`).toContain(esperada)
    }
  })
})
