import { describe, expect, it } from 'vitest'
import { acharDente, catalogoDentes, ehFdiValido, exigirDente, facesDe } from './dentes'
import { ErroDominio } from './erros'

describe('catálogo FDI', () => {
  const catalogo = catalogoDentes()

  it('tem exatamente 52 dentes', () => {
    expect(catalogo).toHaveLength(52)
  })

  it('tem 32 permanentes e 20 decíduos', () => {
    expect(catalogo.filter((d) => d.denticao === 'permanente')).toHaveLength(32)
    expect(catalogo.filter((d) => d.denticao === 'deciduo')).toHaveLength(20)
  })

  it('cobre exatamente os códigos FDI esperados', () => {
    const permanentes = [11, 18, 21, 28, 31, 38, 41, 48]
    const deciduos = [51, 55, 61, 65, 71, 75, 81, 85]
    for (const fdi of [...permanentes, ...deciduos]) {
      expect(ehFdiValido(fdi), `FDI ${fdi} deveria existir`).toBe(true)
    }
    // Buracos: não existe 19, nem 49, nem 56 (decíduo só vai até a posição 5).
    for (const fdi of [10, 19, 49, 50, 56, 66, 76, 86, 99]) {
      expect(ehFdiValido(fdi), `FDI ${fdi} não deveria existir`).toBe(false)
    }
  })

  it('não repete código FDI', () => {
    expect(new Set(catalogo.map((d) => d.fdi)).size).toBe(52)
  })

  it('deriva arcada e lado do quadrante', () => {
    expect(exigirDente(11)).toMatchObject({ arcada: 'superior', lado: 'direito', quadrante: 1 })
    expect(exigirDente(21)).toMatchObject({ arcada: 'superior', lado: 'esquerdo', quadrante: 2 })
    expect(exigirDente(31)).toMatchObject({ arcada: 'inferior', lado: 'esquerdo', quadrante: 3 })
    expect(exigirDente(41)).toMatchObject({ arcada: 'inferior', lado: 'direito', quadrante: 4 })
    expect(exigirDente(51)).toMatchObject({ arcada: 'superior', lado: 'direito', denticao: 'deciduo' })
    expect(exigirDente(85)).toMatchObject({ arcada: 'inferior', lado: 'direito', denticao: 'deciduo' })
  })

  it('não tem pré-molar decíduo — molar decíduo é sucedido por pré-molar', () => {
    expect(catalogo.filter((d) => d.denticao === 'deciduo' && d.tipo.includes('premolar'))).toHaveLength(0)
    // 54 é 1º molar decíduo e dá lugar ao 14, que é 1º pré-molar permanente.
    expect(exigirDente(54).tipo).toBe('primeiro_molar')
    expect(exigirDente(54).sucessorFdi).toBe(14)
    expect(exigirDente(14).tipo).toBe('primeiro_premolar')
  })

  it('mapeia todo decíduo para um permanente existente, e só decíduos têm sucessor', () => {
    for (const d of catalogo) {
      if (d.denticao === 'deciduo') {
        expect(d.sucessorFdi).not.toBeNull()
        expect(ehFdiValido(d.sucessorFdi!), `sucessor ${d.sucessorFdi} deve existir`).toBe(true)
        expect(acharDente(d.sucessorFdi!)!.denticao).toBe('permanente')
      } else {
        expect(d.sucessorFdi).toBeNull()
      }
    }
  })

  it('lança ErroDominio com código estável para FDI inexistente', () => {
    expect(() => exigirDente(19)).toThrowError(ErroDominio)
    try {
      exigirDente(19)
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('DENTE_INEXISTENTE')
    }
  })
})

describe('faces por anatomia', () => {
  it('dá 6 faces a todo dente', () => {
    for (const d of catalogoDentes()) {
      expect(d.facesValidas, `dente ${d.fdi}`).toHaveLength(6)
    }
  })

  it('anterior tem incisal e nunca oclusal', () => {
    // 11 incisivo central, 13 canino
    for (const fdi of [11, 13, 22, 33, 43, 51, 63]) {
      const faces = exigirDente(fdi).facesValidas
      expect(faces, `dente ${fdi}`).toContain('incisal')
      expect(faces, `dente ${fdi}`).not.toContain('oclusal')
    }
  })

  it('posterior tem oclusal e nunca incisal', () => {
    // 14 pré-molar, 16 molar, 55 molar decíduo
    for (const fdi of [14, 16, 18, 27, 36, 47, 55, 84]) {
      const faces = exigirDente(fdi).facesValidas
      expect(faces, `dente ${fdi}`).toContain('oclusal')
      expect(faces, `dente ${fdi}`).not.toContain('incisal')
    }
  })

  it('superior tem palatina, inferior tem lingual, nunca as duas', () => {
    for (const d of catalogoDentes()) {
      if (d.arcada === 'superior') {
        expect(d.facesValidas, `dente ${d.fdi}`).toContain('palatina')
        expect(d.facesValidas, `dente ${d.fdi}`).not.toContain('lingual')
      } else {
        expect(d.facesValidas, `dente ${d.fdi}`).toContain('lingual')
        expect(d.facesValidas, `dente ${d.fdi}`).not.toContain('palatina')
      }
    }
  })

  it('todo dente tem mesial, distal, vestibular e cervical', () => {
    for (const d of catalogoDentes()) {
      for (const face of ['mesial', 'distal', 'vestibular', 'cervical'] as const) {
        expect(d.facesValidas, `dente ${d.fdi}`).toContain(face)
      }
    }
  })

  it('facesDe é consistente com o catálogo', () => {
    for (const d of catalogoDentes()) {
      expect(facesDe(d.arcada, d.tipo)).toEqual(d.facesValidas)
    }
  })
})
