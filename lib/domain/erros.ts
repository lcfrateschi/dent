/**
 * Erro de regra de negócio. Distinto de erro de programação: este é esperado,
 * carrega mensagem apresentável ao usuário e um código estável para a UI reagir.
 */
export class ErroDominio extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
    readonly detalhes?: Record<string, unknown>,
  ) {
    super(mensagem)
    this.name = 'ErroDominio'
  }
}

export function erro(
  codigo: string,
  mensagem: string,
  detalhes?: Record<string, unknown>,
): never {
  throw new ErroDominio(codigo, mensagem, detalhes)
}
