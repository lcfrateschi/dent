import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  type SitioMedido,
  compararPeriogramas,
  ehMultirradicular,
  exigirSitioValido,
  formatarMm,
  mediaNivelInsercaoDecimos,
  mediaProfundidadeDecimos,
  nivelInsercao,
  aceitaPeriograma,
  resumir,
  sangramentoDecimosPct,
  sitioEhValido,
  sitiosDe,
} from './periograma'

const sitio = (
  denteFdi: number,
  s: SitioMedido['sitio'],
  profundidadeMm: number,
  recessaoMm = 0,
  sangramento = false,
): SitioMedido => ({
  denteFdi,
  sitio: s,
  profundidadeMm,
  recessaoMm,
  sangramento,
  supuracao: false,
})

describe('sítios: a arcada decide o lado oral', () => {
  it('superior tem palatina, inferior tem lingual — nunca as duas', () => {
    expect(sitiosDe(16)).toEqual([
      'mesio_vestibular',
      'vestibular',
      'disto_vestibular',
      'mesio_palatina',
      'palatina',
      'disto_palatina',
    ])
    expect(sitiosDe(36)).toEqual([
      'mesio_vestibular',
      'vestibular',
      'disto_vestibular',
      'mesio_lingual',
      'lingual',
      'disto_lingual',
    ])
  })

  it('são sempre seis', () => {
    for (const fdi of [11, 18, 24, 31, 43, 48]) {
      expect(sitiosDe(fdi), String(fdi)).toHaveLength(6)
    }
  })

  it('sítio do outro lado da boca é recusado', () => {
    // Este par é o que impede o exame gravar um sítio que não existe no dente.
    expect(sitioEhValido(36, 'mesio_lingual')).toBe(true)
    expect(sitioEhValido(36, 'mesio_palatina')).toBe(false)
    expect(sitioEhValido(16, 'mesio_palatina')).toBe(true)
    expect(sitioEhValido(16, 'mesio_lingual')).toBe(false)

    expect(() => exigirSitioValido(36, 'palatina')).toThrowError(ErroDominio)
    // A mensagem tem de dizer por quê — "inválido" manda procurar no lugar errado.
    expect(() => exigirSitioValido(36, 'palatina')).toThrowError(/inferior/)
  })

  it('vestibular vale nas duas arcadas', () => {
    expect(sitioEhValido(16, 'vestibular')).toBe(true)
    expect(sitioEhValido(36, 'vestibular')).toBe(true)
  })
})

describe('furca só existe em dente multirradicular', () => {
  /**
   * A lista inteira, escrita à mão. É a contraprova da regra aritmética: se
   * `ehMultirradicular` passar a usar outro critério, esta lista discorda.
   * A mesma lista é conferida contra a função SQL em
   * `docker/verificar-invariantes.sql` — duas implementações sem cruzamento
   * divergem, e o dia em que divergirem o campo aparece no dente errado.
   */
  const COM_FURCA = [16, 17, 18, 26, 27, 28, 36, 37, 38, 46, 47, 48]
  const SEM_FURCA = [
    11, 12, 13, 14, 15, 21, 22, 23, 24, 25, 31, 32, 33, 34, 35, 41, 42, 43, 44, 45,
  ]

  it('os doze molares têm', () => {
    for (const fdi of COM_FURCA) expect(ehMultirradicular(fdi), String(fdi)).toBe(true)
  })

  it('os vinte demais não têm', () => {
    for (const fdi of SEM_FURCA) expect(ehMultirradicular(fdi), String(fdi)).toBe(false)
  })

  it('a lista cobre os 32 permanentes — sem esquecer nenhum', () => {
    expect(COM_FURCA.length + SEM_FURCA.length).toBe(32)
  })

  it('⚠️ o primeiro pré-molar superior está FORA, e é escolha consciente', () => {
    // 14 e 24 têm duas raízes na maioria das pessoas. Ficaram fora porque entre
    // perder informação e inventar informação, este projeto perde — ver o
    // comentário da função. Este caso existe para a mudança ser deliberada:
    // quem inverter a regra vai ter de apagar esta asserção e explicar.
    expect(ehMultirradicular(14)).toBe(false)
    expect(ehMultirradicular(24)).toBe(false)
  })

  it('decíduo nunca entra — o periograma não cobre dentição decídua', () => {
    for (const fdi of [54, 55, 64, 74, 85]) {
      expect(ehMultirradicular(fdi), String(fdi)).toBe(false)
      expect(aceitaPeriograma(fdi), String(fdi)).toBe(false)
    }
    expect(aceitaPeriograma(16)).toBe(true)
  })
})

describe('nível de inserção é PS + recessão', () => {
  it('soma direta quando há recessão', () => {
    expect(nivelInsercao(5, 2)).toBe(7)
  })

  it('recessão NEGATIVA (aumento gengival) reduz o NIC', () => {
    // É o caso que separa bolsa profunda de perda de inserção: a margem cobre a
    // coroa, a sonda entra 6 mm e a inserção perdida é 4 mm. Sem o sinal
    // negativo, este paciente sairia do exame pior do que está.
    expect(nivelInsercao(6, -2)).toBe(4)
  })

  it('sem recessão, NIC é a própria profundidade', () => {
    expect(nivelInsercao(3, 0)).toBe(3)
  })
})

describe('resumo: aritmética inteira, sem média em ponto flutuante', () => {
  const exame = [
    sitio(11, 'vestibular', 3, 0, true),
    sitio(11, 'palatina', 2, 0, false),
    sitio(16, 'vestibular', 7, 2, true),
    sitio(16, 'palatina', 4, 1, true),
  ]

  it('conta e soma', () => {
    const r = resumir(exame)
    expect(r.sitios).toBe(4)
    expect(r.somaProfundidade).toBe(3 + 2 + 7 + 4)
    expect(r.somaNivelInsercao).toBe(3 + 2 + 9 + 5)
    expect(r.sangrantes).toBe(3)
    expect(r.sitiosComBolsa).toBe(2) // 7 e 4 são >= 4
    expect(r.sitiosComBolsaProfunda).toBe(1) // só o 7 é >= 6
  })

  it('média em décimos de milímetro, exata', () => {
    const r = resumir(exame)
    // 16 mm / 4 sítios = 4,0 mm
    expect(mediaProfundidadeDecimos(r)).toBe(40)
    // 19 mm / 4 sítios = 4,75 → arredonda para 4,8
    expect(mediaNivelInsercaoDecimos(r)).toBe(48)
    // 3 de 4 = 75,0 %
    expect(sangramentoDecimosPct(r)).toBe(750)
  })

  it('exame sem sítio medido não tem média ZERO — não tem média', () => {
    // Mesma decisão fechada das taxas de falta: base zero não é resultado zero.
    const r = resumir([])
    expect(mediaProfundidadeDecimos(r)).toBeNull()
    expect(mediaNivelInsercaoDecimos(r)).toBeNull()
    expect(sangramentoDecimosPct(r)).toBeNull()
    expect(formatarMm(null)).toBe('—')
  })

  it('formata décimos', () => {
    expect(formatarMm(40)).toBe('4,0 mm')
    expect(formatarMm(48)).toBe('4,8 mm')
    expect(formatarMm(-12)).toBe('-1,2 mm')
  })
})

describe('comparação: dente extraído NÃO é melhora', () => {
  /**
   * O cenário, com os números à mão.
   *
   *   ANTES   11: PS 3 e 3 (rec 0)      → NIC 3 e 3
   *           26: PS 9 e 9 (rec 3)      → NIC 12 e 12   ← o molar condenado
   *           4 sítios · soma PS 24 · média 6,0 mm
   *
   *   DEPOIS  11: PS 3 e 3 (rec 0)      → NIC 3 e 3
   *           26 EXTRAÍDO — os sítios dele não existem mais
   *           2 sítios · soma PS 6 · média 3,0 mm
   *
   * A leitura ingênua: 6,0 → 3,0 mm, "metade da profundidade". A verdade: nada
   * mudou nos sítios que continuam existindo, e o paciente perdeu um molar.
   */
  const antes = [
    sitio(11, 'vestibular', 3),
    sitio(11, 'palatina', 3),
    sitio(26, 'vestibular', 9, 3, true),
    sitio(26, 'palatina', 9, 3, true),
  ]
  const depois = [sitio(11, 'vestibular', 3), sitio(11, 'palatina', 3)]

  it('a comparação ingênua mostraria melhora de 6,0 para 3,0 mm', () => {
    const c = compararPeriogramas(antes, depois)
    expect(mediaProfundidadeDecimos(c.completo.antes)).toBe(60)
    expect(mediaProfundidadeDecimos(c.completo.depois)).toBe(30)
  })

  it('a emparelhada mostra que NADA mudou', () => {
    const c = compararPeriogramas(antes, depois)
    expect(c.emparelhado.antes.sitios).toBe(2)
    expect(c.emparelhado.depois.sitios).toBe(2)
    expect(mediaProfundidadeDecimos(c.emparelhado.antes)).toBe(30)
    expect(mediaProfundidadeDecimos(c.emparelhado.depois)).toBe(30)
  })

  it('e nomeia a perda dentária, que é o desfecho grave', () => {
    const c = compararPeriogramas(antes, depois)
    expect(c.dentesPerdidos).toEqual([26])
    expect(c.dentesNovos).toEqual([])
    expect(c.parcial).toBe(true)
  })

  it('CONTRAPROVA: sem extração, ingênua e emparelhada dão o MESMO número', () => {
    // Sem isto, o teste acima não provaria que a divergência vem da extração —
    // provaria só que as duas contas são diferentes, o que seria compatível com
    // o emparelhamento estar simplesmente errado.
    const c = compararPeriogramas(antes, antes)
    expect(c.parcial).toBe(false)
    expect(c.dentesPerdidos).toEqual([])
    expect(mediaProfundidadeDecimos(c.completo.antes)).toBe(
      mediaProfundidadeDecimos(c.emparelhado.antes),
    )
    expect(mediaProfundidadeDecimos(c.completo.depois)).toBe(
      mediaProfundidadeDecimos(c.emparelhado.depois),
    )
  })

  it('melhora de verdade aparece na emparelhada', () => {
    // O outro lado: quando a bolsa do MESMO sítio diminui, a emparelhada vê.
    const tratado = [
      sitio(11, 'vestibular', 3),
      sitio(11, 'palatina', 3),
      sitio(26, 'vestibular', 4, 3),
      sitio(26, 'palatina', 4, 3),
    ]
    const c = compararPeriogramas(antes, tratado)
    expect(c.parcial).toBe(false)
    // PS: 24 mm → 14 mm em 4 sítios = 6,0 → 3,5 mm
    expect(mediaProfundidadeDecimos(c.emparelhado.antes)).toBe(60)
    expect(mediaProfundidadeDecimos(c.emparelhado.depois)).toBe(35)
    // NIC: 30 mm → 20 mm = 7,5 → 5,0 mm. O NÍVEL é mais alto que o da PS porque a
    // recessão de 3 mm já estava lá; a VARIAÇÃO é a mesma (−2,5 mm) porque a
    // recessão não mudou. Melhora real move os dois juntos.
    expect(mediaNivelInsercaoDecimos(c.emparelhado.antes)).toBe(75)
    expect(mediaNivelInsercaoDecimos(c.emparelhado.depois)).toBe(50)
  })

  it('bolsa que encolhe porque a GENGIVA RETRAIU não é melhora — e o NIC vê', () => {
    /**
     * A segunda mentira que o NIC existe para pegar, e a razão de ele não poder ser
     * digitado.
     *
     *   ANTES   PS 6, recessão 0  → NIC 6
     *   DEPOIS  PS 3, recessão 3  → NIC 6
     *
     * A profundidade caiu pela metade. Nenhuma inserção foi recuperada: a margem
     * gengival desceu 3 mm, então a sonda entra menos porque começa mais embaixo.
     * Um painel que acompanhe só PS comemora; um que acompanhe NIC não se move.
     */
    const comBolsa = [sitio(11, 'vestibular', 6, 0)]
    const comRecessao = [sitio(11, 'vestibular', 3, 3)]
    const c = compararPeriogramas(comBolsa, comRecessao)

    expect(mediaProfundidadeDecimos(c.emparelhado.antes)).toBe(60)
    expect(mediaProfundidadeDecimos(c.emparelhado.depois)).toBe(30)
    expect(mediaNivelInsercaoDecimos(c.emparelhado.antes)).toBe(60)
    expect(mediaNivelInsercaoDecimos(c.emparelhado.depois)).toBe(60)
    // E não há perda dentária para explicar: a boca é a mesma.
    expect(c.parcial).toBe(false)
  })

  it('dente novo (3º molar que erupcionou) entra como novo, não como piora', () => {
    const comTerceiro = [...depois, sitio(28, 'vestibular', 5), sitio(28, 'palatina', 5)]
    const c = compararPeriogramas(depois, comTerceiro)
    expect(c.dentesNovos).toEqual([28])
    expect(c.dentesPerdidos).toEqual([])
    expect(mediaProfundidadeDecimos(c.emparelhado.depois)).toBe(30)
  })
})
