/**
 * Formatação de dinheiro para exibição.
 *
 * O dado circula como string `numeric(10,2)` ("1234.56") — ver
 * `lib/domain/dinheiro.ts`. Esta é a única camada que o transforma em texto
 * brasileiro. Nunca formatar para depois reconverter: é assim que se perde
 * centavo.
 */

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
})

/** "1234.56" → "R$ 1.234,56". Entrada inválida volta intacta, sem quebrar a tela. */
export function reais(valor: string): string {
  const n = Number(valor)
  return Number.isFinite(n) ? BRL.format(n) : valor
}

/** "1234.56" → "1.234,56", sem o símbolo — para colunas de tabela. */
export function numero(valor: string): string {
  const n = Number(valor)
  return Number.isFinite(n)
    ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : valor
}

/** "2026-09-01" → "01/09/2026". */
export function dataBr(iso: string): string {
  const [ano, mes, dia] = iso.split('-')
  return dia && mes && ano ? `${dia}/${mes}/${ano}` : iso
}

export function dataHoraBr(d: Date): string {
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}
