import { catalogoDentes, exigirDente } from '@/lib/domain/dentes'
import { describe, expect, it } from 'vitest'
import { layoutOdontograma, mapearFaces, metadeDesenho } from './geometria'

describe('mapeamento de faces para posições', () => {
  it('cobre exatamente as faces válidas do dente, sem sobra nem falta', () => {
    // Esta é a invariante central: se o desenho mostrar uma face que o dente não
    // tem, ou esconder uma que ele tem, o dentista marca a coisa errada.
    for (const d of catalogoDentes()) {
      const posicoes = mapearFaces(d)
      const desenhadas = [
        posicoes.topo,
        posicoes.base,
        posicoes.esquerda,
        posicoes.direita,
        posicoes.centro,
        'cervical' as const,
      ]
      expect(new Set(desenhadas).size, `dente ${d.fdi} desenha face repetida`).toBe(6)
      expect(new Set(desenhadas), `dente ${d.fdi}`).toEqual(new Set(d.facesValidas))
    }
  })

  it('põe vestibular sempre na borda externa do diagrama', () => {
    for (const d of catalogoDentes()) {
      const { topo, base } = mapearFaces(d)
      if (d.arcada === 'superior') {
        // Arcada de cima: vestibular para cima, palatina voltada à linha média.
        expect(topo, `dente ${d.fdi}`).toBe('vestibular')
        expect(base, `dente ${d.fdi}`).toBe('palatina')
      } else {
        expect(base, `dente ${d.fdi}`).toBe('vestibular')
        expect(topo, `dente ${d.fdi}`).toBe('lingual')
      }
    }
  })

  it('mesial aponta para a linha média — e por isso troca de lado por quadrante', () => {
    // Dentes do lado DIREITO do paciente (quadrantes 1, 4, 5, 8) são desenhados
    // na metade esquerda da tela: para eles, mesial fica à direita da célula.
    for (const fdi of [11, 16, 41, 48, 51, 55, 81, 85]) {
      const posicoes = mapearFaces(exigirDente(fdi))
      expect(posicoes.direita, `dente ${fdi}: mesial deveria estar à direita`).toBe('mesial')
      expect(posicoes.esquerda, `dente ${fdi}: distal deveria estar à esquerda`).toBe('distal')
    }
    // Lado ESQUERDO do paciente (2, 3, 6, 7), desenhado na metade direita da tela.
    for (const fdi of [21, 26, 31, 38, 61, 65, 71, 75] as const) {
      const posicoes = mapearFaces(exigirDente(fdi))
      expect(posicoes.esquerda, `dente ${fdi}: mesial deveria estar à esquerda`).toBe('mesial')
      expect(posicoes.direita, `dente ${fdi}: distal deveria estar à direita`).toBe('distal')
    }
  })

  it('espelha mesial/distal entre dentes homólogos — 11 e 21 são espelho', () => {
    const d11 = mapearFaces(exigirDente(11))
    const d21 = mapearFaces(exigirDente(21))
    expect(d11.direita).toBe(d21.esquerda) // mesial em ambos
    expect(d11.esquerda).toBe(d21.direita) // distal em ambos
  })

  it('põe incisal no centro dos anteriores e oclusal no dos posteriores', () => {
    for (const fdi of [11, 12, 13, 22, 33, 43, 51, 53, 71]) {
      expect(mapearFaces(exigirDente(fdi)).centro, `dente ${fdi}`).toBe('incisal')
    }
    for (const fdi of [14, 16, 18, 27, 36, 47, 54, 55, 84]) {
      expect(mapearFaces(exigirDente(fdi)).centro, `dente ${fdi}`).toBe('oclusal')
    }
  })

  it('desenha o lado direito do paciente na metade esquerda da tela', () => {
    // O paciente está de frente: a direita dele é a nossa esquerda.
    expect(metadeDesenho(exigirDente(16))).toBe('esquerda')
    expect(metadeDesenho(exigirDente(26))).toBe('direita')
  })
})

describe('layout', () => {
  it('desenha 32 dentes na dentição permanente', () => {
    const l = layoutOdontograma({ denticao: 'permanente' })
    expect(l.dentes).toHaveLength(32)
    expect(l.fileiras).toHaveLength(2)
  })

  it('desenha 20 dentes na dentição decídua', () => {
    const l = layoutOdontograma({ denticao: 'deciduo' })
    expect(l.dentes).toHaveLength(20)
    expect(l.fileiras).toHaveLength(2)
  })

  it('desenha os 52 na dentição mista, em 4 fileiras', () => {
    const l = layoutOdontograma({ denticao: 'mista' })
    expect(l.dentes).toHaveLength(52)
    expect(l.fileiras).toHaveLength(4)
    // Decíduas por dentro: permanente superior, decídua superior,
    // decídua inferior, permanente inferior.
    expect(l.fileiras.map((f) => f.chave)).toEqual([
      'superior-permanente',
      'superior-deciduo',
      'inferior-deciduo',
      'inferior-permanente',
    ])
  })

  it('não repete dente no layout', () => {
    for (const denticao of ['permanente', 'deciduo', 'mista'] as const) {
      const l = layoutOdontograma({ denticao })
      const fdis = l.dentes.map((d) => d.fdi)
      expect(new Set(fdis).size, `dentição ${denticao}`).toBe(fdis.length)
    }
  })

  it('ordena a fileira do fundo até o incisivo e volta ao fundo', () => {
    const l = layoutOdontograma({ denticao: 'permanente' })
    const superior = l.fileiras.find((f) => f.arcada === 'superior')!
    expect(superior.fdis).toEqual([18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28])

    const inferior = l.fileiras.find((f) => f.arcada === 'inferior')!
    expect(inferior.fdis).toEqual([48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38])
  })

  it('ordena a fileira decídua com 5 dentes por lado', () => {
    const l = layoutOdontograma({ denticao: 'deciduo' })
    const superior = l.fileiras.find((f) => f.arcada === 'superior')!
    expect(superior.fdis).toEqual([55, 54, 53, 52, 51, 61, 62, 63, 64, 65])
  })

  it('cresce da esquerda para a direita dentro da fileira', () => {
    const l = layoutOdontograma({ denticao: 'permanente' })
    const superior = l.fileiras.find((f) => f.arcada === 'superior')!
    const xs = superior.fdis.map((fdi) => l.dentes.find((d) => d.fdi === fdi)!.x)
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!, `posição ${i}`).toBeGreaterThan(xs[i - 1]!)
    }
  })

  it('espelha as metades em torno da linha média', () => {
    const l = layoutOdontograma({ denticao: 'permanente' })
    const d11 = l.dentes.find((d) => d.fdi === 11)!
    const d21 = l.dentes.find((d) => d.fdi === 21)!
    // Os dois incisivos centrais encostam na linha média, um de cada lado.
    expect(d11.x + d11.lado).toBeLessThanOrEqual(l.linhaMediaX)
    expect(d21.x).toBeGreaterThanOrEqual(l.linhaMediaX)
    // E ficam simétricos.
    const folgaEsq = l.linhaMediaX - (d11.x + d11.lado)
    const folgaDir = d21.x - l.linhaMediaX
    expect(Math.abs(folgaEsq - folgaDir)).toBeLessThan(1)
  })

  it('encosta a fileira decídua na linha média', () => {
    const l = layoutOdontograma({ denticao: 'mista' })
    const d51 = l.dentes.find((d) => d.fdi === 51)!
    const d11 = l.dentes.find((d) => d.fdi === 11)!
    // 51 é o incisivo central decíduo: alinha na mesma coluna do 11.
    expect(d51.x).toBeCloseTo(d11.x, 1)
  })

  it('separa as arcadas: toda superior acima da linha, toda inferior abaixo', () => {
    const l = layoutOdontograma({ denticao: 'mista' })
    for (const d of l.dentes) {
      if (d.dente.arcada === 'superior') {
        expect(d.y, `dente ${d.fdi}`).toBeLessThan(l.linhaArcadasY)
      } else {
        expect(d.y, `dente ${d.fdi}`).toBeGreaterThan(l.linhaArcadasY)
      }
    }
  })

  it('gera 6 regiões por dente, com path não vazio', () => {
    const l = layoutOdontograma({ denticao: 'mista' })
    for (const d of l.dentes) {
      expect(d.regioes, `dente ${d.fdi}`).toHaveLength(6)
      for (const r of d.regioes) {
        expect(r.path, `dente ${d.fdi} face ${r.face}`).toMatch(/^M[\d.]/)
        expect(r.path).not.toContain('NaN')
      }
    }
  })

  it('mantém todo dente dentro da caixa do SVG', () => {
    for (const denticao of ['permanente', 'deciduo', 'mista'] as const) {
      const l = layoutOdontograma({ denticao })
      for (const d of l.dentes) {
        expect(d.x, `dente ${d.fdi} em ${denticao}`).toBeGreaterThanOrEqual(0)
        expect(d.x + d.lado, `dente ${d.fdi} em ${denticao}`).toBeLessThanOrEqual(l.largura)
        expect(d.y, `dente ${d.fdi} em ${denticao}`).toBeGreaterThanOrEqual(0)
        expect(d.rotulo.y, `rótulo do dente ${d.fdi} em ${denticao}`).toBeLessThanOrEqual(l.altura)
      }
    }
  })

  it('escala com o tamanho confortável, para uso em tablet', () => {
    const compacto = layoutOdontograma({ denticao: 'permanente', tamanho: 'compacto' })
    const confortavel = layoutOdontograma({ denticao: 'permanente', tamanho: 'confortavel' })
    expect(confortavel.largura).toBeGreaterThan(compacto.largura)
    expect(confortavel.altura).toBeGreaterThan(compacto.altura)
    expect(confortavel.dentes).toHaveLength(compacto.dentes.length)
  })
})
