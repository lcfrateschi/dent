import { describe, expect, it } from 'vitest'
import { paraMilesimos } from '@/lib/domain/quantidade'
import { catalogoMateriais, fichasTecnicas } from './materiais'
import { catalogoProcedimentos } from './procedimentos'

describe('catálogo de materiais', () => {
  it('não repete código', () => {
    const codigos = catalogoMateriais.map((m) => m.codigo)
    expect(new Set(codigos).size).toBe(codigos.length)
  })

  it('toda quantidade mínima é válida em numeric(12,3)', () => {
    for (const m of catalogoMateriais) {
      expect(() => paraMilesimos(m.quantidadeMinima), m.codigo).not.toThrow()
      expect(paraMilesimos(m.quantidadeMinima), m.codigo).toBeGreaterThanOrEqual(0)
    }
  })

  it('embalagem múltipla é inteiro >= 1', () => {
    for (const m of catalogoMateriais) {
      if (m.unidadesPorEmbalagem === undefined) continue
      expect(Number.isInteger(m.unidadesPorEmbalagem), m.codigo).toBe(true)
      expect(m.unidadesPorEmbalagem, m.codigo).toBeGreaterThanOrEqual(1)
    }
  })

  it('quem declara embalagem múltipla explica em texto o que é a embalagem', () => {
    // `unidadesPorEmbalagem: 50` sem "caixa com 50 tubetes" é convite ao erro de
    // lançamento: quem recebe a caixa não sabe se digita 1 ou 50.
    for (const m of catalogoMateriais) {
      if ((m.unidadesPorEmbalagem ?? 1) > 1) {
        expect(m.embalagem, `${m.codigo} tem fator de embalagem sem descrever a embalagem`).toBeTruthy()
      }
    }
  })

  it('material de rastreabilidade obrigatória cobre implante, enxerto e anestésico', () => {
    const comRastreio = new Set(
      catalogoMateriais.filter((m) => m.exigeLoteDoFabricante).map((m) => m.codigo),
    )
    // Implante e enxerto são o caso clássico de recolhimento de lote; anestésico
    // é o que a Anvisa recolhe com mais frequência de fato.
    for (const codigo of ['IMP-001', 'IMP-002', 'ANE-001', 'ANE-002']) {
      expect(comRastreio, `${codigo} deveria exigir lote do fabricante`).toContain(codigo)
    }
  })

  it('material descartável de barreira NÃO exige lote — seria burocracia inútil', () => {
    // Exigir lote de luva e babador só faria a recepção inventar número para o
    // formulário aceitar, e aí o campo mente em todos os materiais.
    for (const codigo of ['BIO-001', 'BIO-004', 'BIO-005']) {
      const m = catalogoMateriais.find((x) => x.codigo === codigo)
      expect(m?.exigeLoteDoFabricante ?? false, codigo).toBe(false)
    }
  })

  it('material controlado é declarado e tem rastreio', () => {
    const controlados = catalogoMateriais.filter((m) => m.controlado)
    expect(controlados.length).toBeGreaterThan(0)
    for (const m of controlados) {
      expect(m.exigeLoteDoFabricante, `${m.codigo} é controlado e precisa de lote`).toBe(true)
      // Mínimo zero: não se mantém estoque de sedativo "por garantia".
      expect(paraMilesimos(m.quantidadeMinima), m.codigo).toBe(0)
    }
  })
})

describe('ficha técnica', () => {
  const codigosProcedimento = new Set(catalogoProcedimentos.map((p) => p.codigo))
  const codigosMaterial = new Set(catalogoMateriais.map((m) => m.codigo))

  it('todo procedimento da ficha existe no catálogo de procedimentos', () => {
    // Esta asserção pegou um erro real: as fichas foram escritas com REST-001,
    // e o catálogo chama restauração de DENT-001. O seed teria inserido zero
    // vínculos para elas — silenciosamente, e a baixa nunca seria proposta.
    for (const f of fichasTecnicas) {
      expect(codigosProcedimento, `ficha de ${f.procedimento} sem procedimento no catálogo`).toContain(
        f.procedimento,
      )
    }
  })

  it('todo material da ficha existe no catálogo de materiais', () => {
    for (const f of fichasTecnicas) {
      for (const i of f.insumos) {
        expect(codigosMaterial, `${f.procedimento} usa material inexistente ${i.material}`).toContain(
          i.material,
        )
      }
    }
  })

  it('não repete material dentro da mesma ficha', () => {
    // O banco tem UNIQUE(procedimento, material) — repetir aqui faria o seed
    // falhar no meio, e o UPSERT silenciaria a duplicata mantendo só a última.
    for (const f of fichasTecnicas) {
      const materiais = f.insumos.map((i) => i.material)
      expect(new Set(materiais).size, `${f.procedimento} repete material`).toBe(materiais.length)
    }
  })

  it('não repete procedimento entre fichas', () => {
    const procedimentos = fichasTecnicas.map((f) => f.procedimento)
    expect(new Set(procedimentos).size).toBe(procedimentos.length)
  })

  it('toda quantidade é positiva e cabe em numeric(12,3)', () => {
    for (const f of fichasTecnicas) {
      for (const i of f.insumos) {
        expect(paraMilesimos(i.quantidade), `${f.procedimento}/${i.material}`).toBeGreaterThan(0)
      }
    }
  })

  it('procedimento com anestesia local leva agulha', () => {
    // Anestésico sem agulha é ficha pela metade: o tubete baixa, a agulha não,
    // e o alerta de mínimo da agulha nunca dispara — que é o pior dos mundos,
    // porque o estoque parece controlado.
    for (const f of fichasTecnicas) {
      const usaAnestesicoInjetavel = f.insumos.some(
        (i) => i.material === 'ANE-001' || i.material === 'ANE-002',
      )
      if (usaAnestesicoInjetavel) {
        expect(
          f.insumos.some((i) => i.material === 'ANE-004'),
          `${f.procedimento} usa anestésico injetável sem agulha`,
        ).toBe(true)
      }
    }
  })

  it('todo procedimento de consultório leva luva', () => {
    for (const f of fichasTecnicas) {
      expect(
        f.insumos.some((i) => i.material === 'BIO-001'),
        `${f.procedimento} sem luva na ficha`,
      ).toBe(true)
    }
  })

  it('cobre os procedimentos de maior volume da clínica', () => {
    const cobertos = new Set(fichasTecnicas.map((f) => f.procedimento))
    for (const codigo of ['CONS-001', 'PREV-001', 'DENT-001', 'DENT-002', 'ENDO-001', 'CIR-001']) {
      expect(cobertos, `sem ficha técnica para ${codigo}`).toContain(codigo)
    }
  })
})
