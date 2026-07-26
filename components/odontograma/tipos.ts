import type { Face } from '@/lib/domain/dentes'

/**
 * Estado de uma face. Segue a convenção clínica brasileira do prontuário em
 * papel: vermelho = a fazer, azul = realizado.
 *
 * Estes tipos são a ponte para o banco: `planejado` corresponde a um
 * `item_plano` com status proposto/aprovado; `executado`, a um item com
 * `execucao` registrada. O componente não sabe disso — quem traduz é a Fase 5.
 */
export type EstadoFace = 'higido' | 'planejado' | 'executado'

/**
 * Estado do dente inteiro, que se sobrepõe ao das faces.
 * Espelha `estado_dente` no banco, mais `presente` — que no banco é a AUSÊNCIA
 * de linha em `dente_paciente`, não um valor.
 */
export type EstadoDente = 'presente' | 'ausente' | 'coroa' | 'implante' | 'raiz_residual'

/** Marcações por dente e face: `{ 16: { oclusal: 'planejado' } }` */
export type MarcacoesFace = Readonly<Record<number, Partial<Record<Face, EstadoFace>>>>

export type MarcacoesDente = Readonly<Record<number, EstadoDente>>

/** Faces selecionadas por dente — a matéria-prima de um `item_plano`. */
export type SelecaoFaces = Readonly<Record<number, readonly Face[]>>

export const ROTULO_ESTADO_FACE: Readonly<Record<EstadoFace, string>> = {
  higido: 'hígido',
  planejado: 'planejado',
  executado: 'executado',
}

export const ROTULO_ESTADO_DENTE: Readonly<Record<EstadoDente, string>> = {
  presente: 'presente',
  ausente: 'ausente',
  coroa: 'com coroa',
  implante: 'com implante',
  raiz_residual: 'raiz residual',
}

/**
 * Dente ausente ou com implante não recebe marcação de face — não há coroa
 * natural para restaurar. Coroa protética e raiz residual ainda recebem:
 * cervical e faces adjacentes seguem sendo tratáveis.
 */
export function aceitaMarcacaoDeFace(estado: EstadoDente | undefined): boolean {
  return (
    estado === undefined ||
    estado === 'presente' ||
    estado === 'coroa' ||
    estado === 'raiz_residual'
  )
}
