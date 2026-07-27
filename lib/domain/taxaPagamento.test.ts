import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import { baseDeComissaoDoPagamento, quebrarLiquido, taxaVigenteEm } from './taxaPagamento'

const CREDITO = {
  meio: 'credito',
  percentual: '2.49',
  valorFixo: '0.00',
  vigenciaInicio: '2026-01-01',
  vigenciaFim: null,
}
const PIX = {
  meio: 'pix',
  percentual: '0.00',
  valorFixo: '0.99',
  vigenciaInicio: '2026-01-01',
  vigenciaFim: null,
}

describe('taxa vigente na data', () => {
  const antiga = { ...CREDITO, percentual: '3.99', vigenciaInicio: '2025-01-01', vigenciaFim: '2025-12-31' }

  it('escolhe pela DATA DO PAGAMENTO, não pela de hoje', () => {
    // É a regra do preço de convênio, pelo mesmo motivo: recalcular março com o
    // contrato de setembro reescreveria o histórico do que a clínica recebeu.
    expect(taxaVigenteEm([antiga, CREDITO], 'credito', '2025-06-15')?.percentual).toBe('3.99')
    expect(taxaVigenteEm([antiga, CREDITO], 'credito', '2026-06-15')?.percentual).toBe('2.49')
  })

  it('não confunde meios', () => {
    expect(taxaVigenteEm([CREDITO, PIX], 'pix', '2026-06-15')?.valorFixo).toBe('0.99')
    expect(taxaVigenteEm([CREDITO], 'debito', '2026-06-15')).toBeNull()
  })

  it('sem taxa cadastrada devolve null — que é "zero conhecido", não erro', () => {
    // Dinheiro em espécie não tem MDR, e uma clínica que ainda não cadastrou a taxa do
    // crédito recebe o bruto no relatório. O que não pode é inventar uma taxa média.
    expect(taxaVigenteEm([], 'credito', '2026-06-15')).toBeNull()
  })

  it('inclui os dois extremos da vigência', () => {
    expect(taxaVigenteEm([antiga], 'credito', '2025-01-01')).not.toBeNull()
    expect(taxaVigenteEm([antiga], 'credito', '2025-12-31')).not.toBeNull()
    expect(taxaVigenteEm([antiga], 'credito', '2026-01-01')).toBeNull()
  })
})

describe('quebrar bruto em taxa e líquido', () => {
  it('percentual, com a conta feita à mão', () => {
    // 2,49% de R$ 100,00 = R$ 2,49 → líquido R$ 97,51.
    expect(quebrarLiquido('100.00', CREDITO)).toEqual({
      bruto: '100.00',
      taxa: '2.49',
      liquido: '97.51',
    })
  })

  it('não usa ponto flutuante — este é o caso que denuncia', () => {
    // 2,49% de R$ 350,00 = R$ 8,715, que arredonda para R$ 8,72 (líquido 341,28).
    // Em float, `350 * 0.0249` dá 8.714999999999998 e o truncamento daria 8,71 —
    // um centavo por transação, todo mês, no relatório que a clínica compara com o
    // extrato.
    expect(quebrarLiquido('350.00', CREDITO)).toEqual({
      bruto: '350.00',
      taxa: '8.72',
      liquido: '341.28',
    })
  })

  it('tarifa fixa', () => {
    expect(quebrarLiquido('80.00', PIX)).toEqual({ bruto: '80.00', taxa: '0.99', liquido: '79.01' })
  })

  it('percentual e fixo juntos', () => {
    // Boleto: 1,50% + R$ 2,00 sobre R$ 200,00 = 3,00 + 2,00 = 5,00.
    const boleto = { ...PIX, meio: 'boleto', percentual: '1.50', valorFixo: '2.00' }
    expect(quebrarLiquido('200.00', boleto)).toEqual({
      bruto: '200.00',
      taxa: '5.00',
      liquido: '195.00',
    })
  })

  it('sem taxa, líquido é igual ao bruto', () => {
    expect(quebrarLiquido('100.00', null)).toEqual({
      bruto: '100.00',
      taxa: '0.00',
      liquido: '100.00',
    })
  })

  it('ESTOURA em vez de devolver líquido negativo', () => {
    // Tarifa de R$ 0,99 sobre um pagamento de R$ 0,50 não existe no mundo — o
    // adquirente não retém mais do que liquidou. Se acontecer, é cadastro errado, e um
    // líquido negativo somaria normalmente no caixa sem ninguém ver.
    expect(() => quebrarLiquido('0.50', PIX)).toThrowError(ErroDominio)
  })

  it('recusa bruto zero ou negativo', () => {
    expect(() => quebrarLiquido('0.00', PIX)).toThrowError(ErroDominio)
  })
})

describe('base da comissão: bruto × líquido', () => {
  const quebra = quebrarLiquido('100.00', CREDITO)

  it('o padrão é BRUTO, e isso é deliberado', () => {
    // Trocar a base muda a folha de pagamento de quem já está em operação. O padrão
    // preserva o comportamento anterior; a mudança é decisão da clínica, gravada em
    // `clinica.comissao_sobre_liquido`.
    expect(baseDeComissaoDoPagamento(quebra, false)).toBe('100.00')
  })

  it('mas a outra resposta é suportada sem tocar em código', () => {
    expect(baseDeComissaoDoPagamento(quebra, true)).toBe('97.51')
  })
})
