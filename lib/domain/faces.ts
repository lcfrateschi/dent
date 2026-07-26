import { type Face, exigirDente } from './dentes'
import { erro } from './erros'

export function faceEhValida(fdi: number, face: Face): boolean {
  return exigirDente(fdi).facesValidas.includes(face)
}

/**
 * Valida as faces indicadas para um dente. Lança `ErroDominio` na primeira
 * incoerência — face inexistente para o dente, ou face repetida.
 *
 * A regra que mais gera bug: incisivo não tem oclusal (tem incisal), e
 * dente superior não tem lingual (tem palatina).
 */
export function exigirFacesValidas(fdi: number, faces: readonly Face[]): void {
  const dente = exigirDente(fdi)

  const duplicadas = faces.filter((f, i) => faces.indexOf(f) !== i)
  if (duplicadas.length > 0) {
    erro('FACE_DUPLICADA', `Face repetida no dente ${fdi}: ${[...new Set(duplicadas)].join(', ')}.`, {
      fdi,
      duplicadas: [...new Set(duplicadas)],
    })
  }

  const invalidas = faces.filter((f) => !dente.facesValidas.includes(f))
  if (invalidas.length > 0) {
    erro(
      'FACE_INVALIDA',
      `Face ${invalidas.join(', ')} não existe no dente ${fdi} (${dente.nome}). ` +
        `Faces válidas: ${dente.facesValidas.join(', ')}.`,
      { fdi, invalidas, validas: dente.facesValidas },
    )
  }
}

/** Rótulo curto para exibir no odontograma e congelar no orçamento. */
export function descreverFaces(fdi: number, faces: readonly Face[]): string {
  if (faces.length === 0) return `Dente ${fdi}`
  const ordem = exigirDente(fdi).facesValidas
  const ordenadas = [...faces].sort((a, b) => ordem.indexOf(a) - ordem.indexOf(b))
  return `Dente ${fdi}, ${ordenadas.length === 1 ? 'face' : 'faces'} ${ordenadas.join(', ')}`
}
