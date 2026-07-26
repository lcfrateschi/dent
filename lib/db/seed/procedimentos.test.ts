import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  /**
   * A intenção deste teste não mudou desde a Fase 1: **nenhum código TUSS
   * inventado**. O que mudou é que agora existem códigos oficiais no seed, então
   * a verificação deixou de ser "não tem nenhum" e passou a ser "todo código que
   * está aqui está na tabela oficial da ANS".
   *
   * O arquivo é `dados/tuss22-odontologia.csv`, baixado da API da ANS — ver
   * `dados/README.md` para a procedência.
   */
  it('todo codigo_tuss do seed está na tabela OFICIAL da ANS', () => {
    const oficiais = new Set(
      readFileSync(join(process.cwd(), 'dados/tuss22-odontologia.csv'), 'utf8')
        .split(/\r?\n/)
        .slice(1)
        .map((l) => l.split(';')[0]?.replace('\uFEFF', '').trim())
        .filter((c): c is string => !!c && /^\d{8}$/.test(c)),
    )
    expect(oficiais.size, 'a tabela oficial foi carregada').toBe(370)

    let comCodigo = 0
    for (const p of catalogoProcedimentos) {
      const codigo = (p as { codigoTuss?: string }).codigoTuss
      if (codigo === undefined) continue
      comCodigo++
      expect(oficiais.has(codigo), `"${p.nome}" usa ${codigo}, que NÃO está na tabela oficial`).toBe(
        true,
      )
      // Faixa odontológica: 81 a 87. Fora dela seria código de medicina.
      expect(/^8[1-7]\d{6}$/.test(codigo), `${codigo} fora da faixa odontológica`).toBe(true)
    }
    expect(comCodigo, 'quantos procedimentos já têm código oficial').toBe(36)
  })

  it('o que NÃO tem código é por decisão, não por esquecimento', () => {
    // Os 13 restantes ou não existem na Tabela 22, ou têm vários candidatos e a
    // escolha muda o valor recebido. `dados/README.md` lista cada caso com os
    // candidatos oficiais. Escolher no lugar da clínica geraria glosa em nome dela.
    const semCodigo = catalogoProcedimentos.filter(
      (p) => (p as { codigoTuss?: string }).codigoTuss === undefined,
    )
    expect(semCodigo).toHaveLength(13)

    const doc = readFileSync(join(process.cwd(), 'dados/README.md'), 'utf8')
    for (const p of semCodigo) {
      expect(doc, `${p.codigo} sem código e sem explicação em dados/README.md`).toContain(p.codigo)
    }
  })

  it('cobre as especialidades que a clínica vai usar', () => {
    const especialidades = new Set(catalogoProcedimentos.map((p) => p.especialidade))
    for (const esperada of ['Clínica geral', 'Dentística', 'Endodontia', 'Cirurgia', 'Odontopediatria', 'Prótese']) {
      expect(especialidades, `falta especialidade ${esperada}`).toContain(esperada)
    }
  })
})
