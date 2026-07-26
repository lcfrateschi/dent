import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import { descreverFaces, exigirFacesValidas, faceEhValida } from './faces'

describe('validação de faces', () => {
  it('aceita combinação anatomicamente correta', () => {
    // 16 é 1º molar superior direito: tem oclusal e palatina.
    expect(() => exigirFacesValidas(16, ['oclusal', 'mesial', 'palatina'])).not.toThrow()
    // 11 é incisivo central superior: tem incisal, não oclusal.
    expect(() => exigirFacesValidas(11, ['incisal', 'distal'])).not.toThrow()
    // Lista vazia é válida — quem exige face é o procedimento, não o dente.
    expect(() => exigirFacesValidas(16, [])).not.toThrow()
  })

  it('rejeita oclusal em incisivo (o erro clássico)', () => {
    expect(() => exigirFacesValidas(11, ['oclusal'])).toThrowError(/não existe no dente 11/)
    try {
      exigirFacesValidas(11, ['oclusal'])
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('FACE_INVALIDA')
      expect((e as ErroDominio).detalhes?.invalidas).toEqual(['oclusal'])
    }
  })

  it('rejeita incisal em molar', () => {
    expect(() => exigirFacesValidas(36, ['incisal'])).toThrowError(/não existe no dente 36/)
  })

  it('rejeita lingual em dente superior e palatina em inferior', () => {
    expect(() => exigirFacesValidas(16, ['lingual'])).toThrowError(ErroDominio)
    expect(() => exigirFacesValidas(46, ['palatina'])).toThrowError(ErroDominio)
    // E aceita o inverso.
    expect(() => exigirFacesValidas(16, ['palatina'])).not.toThrow()
    expect(() => exigirFacesValidas(46, ['lingual'])).not.toThrow()
  })

  it('rejeita face duplicada', () => {
    try {
      exigirFacesValidas(16, ['mesial', 'mesial'])
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('FACE_DUPLICADA')
    }
  })

  it('rejeita dente inexistente antes de olhar as faces', () => {
    try {
      exigirFacesValidas(19, ['mesial'])
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('DENTE_INEXISTENTE')
    }
  })

  it('faceEhValida responde sem lançar para dente válido', () => {
    expect(faceEhValida(16, 'oclusal')).toBe(true)
    expect(faceEhValida(16, 'incisal')).toBe(false)
  })

  it('a mensagem de erro lista as faces válidas — a UI mostra isso ao dentista', () => {
    try {
      exigirFacesValidas(11, ['oclusal'])
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as Error).message).toContain('incisal')
      expect((e as Error).message).toContain('palatina')
    }
  })
})

describe('descrição de faces', () => {
  it('ordena as faces pela ordem anatômica, não pela de entrada', () => {
    // A ordem canônica é mesial, distal, vestibular, palatina/lingual, oclusal/incisal, cervical.
    expect(descreverFaces(16, ['oclusal', 'mesial'])).toBe('Dente 16, faces mesial, oclusal')
    expect(descreverFaces(16, ['mesial', 'oclusal'])).toBe('Dente 16, faces mesial, oclusal')
  })

  it('usa singular com uma face só', () => {
    expect(descreverFaces(16, ['oclusal'])).toBe('Dente 16, face oclusal')
  })

  it('descreve dente sem face', () => {
    expect(descreverFaces(16, [])).toBe('Dente 16')
  })
})
