import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  type Interpretacao,
  dddEhValido,
  ehCelular,
  formatarE164,
  interpretarResposta,
  paraE164,
  precisaDeHumano,
} from './whatsapp'

describe('E.164', () => {
  it('normaliza celular escrito de todas as formas usuais', () => {
    const esperado = '5511987654321'
    for (const entrada of [
      '11987654321',
      '(11) 98765-4321',
      '11 98765 4321',
      '+55 11 98765-4321',
      '5511987654321',
      '+5511987654321',
      '011 98765-4321',
      '0 11 987654321',
    ]) {
      expect(paraE164(entrada), entrada).toBe(esperado)
    }
  })

  it('acrescenta o NONO DÍGITO em celular de 8 dígitos', () => {
    // Cadastro antigo, de antes de 2016.
    expect(paraE164('11 8765-4321')).toBe('5511987654321')
    expect(paraE164('(21) 7654-3210')).toBe('5521976543210')
  })

  it('NÃO acrescenta nono dígito em telefone fixo', () => {
    // Fixo começa com 2–5 e continua com 8 dígitos.
    expect(paraE164('11 3265-4789')).toBe('551132654789')
    expect(paraE164('(11) 2345-6789')).toBe('551123456789')
  })

  it('remove o prefixo de operadora para interurbano', () => {
    expect(paraE164('0 15 11 98765 4321')).toBe('5511987654321')
    expect(paraE164('021 11 987654321')).toBe('5511987654321')
  })

  it('rejeita DDD inexistente', () => {
    // 20, 23, 25, 26, 29 não existem.
    for (const ddd of ['20', '23', '25', '26', '29', '36', '39', '10', '30', '40']) {
      expect(() => paraE164(`${ddd}987654321`), `DDD ${ddd}`).toThrowError(ErroDominio)
    }
  })

  it('"01…" é lido como zero de interurbano, não como DDD 01', () => {
    // 0 + DDD 19 + 8765-4321 (celular antigo, ganha o nono).
    expect(paraE164('01987654321')).toBe('5519987654321')
  })

  it('aceita os DDDs que existem', () => {
    for (const ddd of [11, 21, 27, 31, 41, 51, 61, 71, 81, 91, 99]) {
      expect(dddEhValido(ddd), `DDD ${ddd}`).toBe(true)
    }
    for (const ddd of [10, 20, 23, 30, 40, 50, 52, 60, 70, 72, 80, 90, 100]) {
      expect(dddEhValido(ddd), `DDD ${ddd}`).toBe(false)
    }
  })

  it('rejeita tamanho inválido e vazio', () => {
    for (const ruim of ['', '   ', '987654321', '119876543210', '1', 'abc']) {
      expect(() => paraE164(ruim), `"${ruim}"`).toThrowError(ErroDominio)
    }
  })

  it('rejeita 9 dígitos que não começam com 9', () => {
    expect(() => paraE164('11 887654321')).toThrowError(ErroDominio)
  })

  it('distingue celular de fixo — só celular recebe WhatsApp', () => {
    expect(ehCelular('11987654321')).toBe(true)
    expect(ehCelular('11 8765-4321')).toBe(true) // vira celular com o nono
    expect(ehCelular('1132654789')).toBe(false)
    expect(ehCelular('lixo')).toBe(false)
  })

  it('formata para exibição', () => {
    expect(formatarE164('5511987654321')).toBe('+55 (11) 98765-4321')
    expect(formatarE164('551132654789')).toBe('+55 (11) 3265-4789')
    expect(formatarE164('nada')).toBe('nada')
  })
})

describe('interpretar resposta — afirmativas claras', () => {
  it('aceita as formas curtas de sim', () => {
    for (const t of ['Sim', 'sim', 'SIM', 's', '1', 'ok', 'OK', 'Okay', 'Confirmo',
                     'confirmado', 'Confirmar', 'positivo', 'certo', 'blz', 'beleza',
                     'sim!', 'Ok.', 'combinado']) {
      expect(interpretarResposta(t), `"${t}"`).toBe('confirmou')
    }
  })

  it('aceita frase curta com afirmativa', () => {
    expect(interpretarResposta('sim, confirmo')).toBe('confirmou')
    expect(interpretarResposta('ok obrigado')).toBe('confirmou')
    expect(interpretarResposta('Confirmado, estarei lá')).toBe('confirmou')
  })
})

describe('interpretar resposta — negativas', () => {
  it('aceita as formas de não', () => {
    for (const t of ['Não', 'nao', 'NAO', 'n', '2', 'negativo']) {
      expect(interpretarResposta(t), `"${t}"`).toBe('cancelou')
    }
  })

  it('entende pedido de cancelar ou remarcar, mesmo em frase longa', () => {
    // Aqui frase longa é aceita: o custo de errar é a recepção conferir.
    for (const t of [
      'cancelar',
      'preciso desmarcar',
      'infelizmente vou precisar remarcar para a semana que vem',
      'Não vou poder ir amanhã, desculpe',
      'quero adiar',
    ]) {
      expect(interpretarResposta(t), `"${t}"`).toBe('cancelou')
    }
  })
})

describe('interpretar resposta — o cuidado que evita cadeira vazia', () => {
  it('NÃO confunde "sim" dentro de outra palavra', () => {
    // O bug clássico de casar substring: "assim", "simples", "simular".
    for (const t of ['assim', 'simples', 'assim que der eu falo', 'vou simular']) {
      expect(interpretarResposta(t), `"${t}"`).toBe('nao_entendido')
    }
  })

  it('trata frase longa com afirmativa como ambígua', () => {
    // "assim que eu puder confirmo" NÃO é confirmação.
    for (const t of [
      'assim que eu puder eu confirmo com voces',
      'vou ver se consigo e depois confirmo',
      'acho que sim mas preciso ver com meu marido antes',
    ]) {
      expect(interpretarResposta(t), `"${t}"`).toBe('nao_entendido')
    }
  })

  it('INCERTEZA não é cancelamento', () => {
    // Bug real, encontrado rodando o fluxo: "ainda não sei se consigo" contém
    // "não" e cancelava o atendimento. O paciente não cancelou — ele não sabe.
    // Liberar a cadeira aí é pior que não fazer nada.
    for (const t of [
      'ainda nao sei se consigo, meu filho esta doente',
      'nao sei',
      'nao sei se vou conseguir',
      'nao tenho certeza ainda',
      'talvez eu nao consiga ir',
      'acho que nao vou poder',
      'depende do meu trabalho',
      'vou ver e te falo',
      'preciso ver com meu marido',
      'se eu conseguir eu aviso',
      'nao garanto',
    ]) {
      expect(interpretarResposta(t), `"${t}"`).toBe('nao_entendido')
    }
  })

  it('mas negativa explícita continua sendo cancelamento', () => {
    // A regra de incerteza não pode engolir o cancelamento claro.
    for (const t of [
      'nao',
      'nao vou poder ir',
      'preciso desmarcar',
      'infelizmente vou precisar remarcar para a semana que vem',
      'quero cancelar',
    ]) {
      expect(interpretarResposta(t), `"${t}"`).toBe('cancelou')
    }
  })

  it('sinais nos dois sentidos caem para humano', () => {
    for (const t of ['sim ou nao?', 'nao sei se consigo confirmar', 'confirmo mas talvez cancele']) {
      expect(interpretarResposta(t), `"${t}"`).toBe('nao_entendido')
    }
  })

  it('afirmativa precedida de negador não confirma', () => {
    for (const t of ['nao vou', 'nem vou', 'sem confirmar ainda']) {
      const r = interpretarResposta(t)
      expect(r === 'nao_entendido' || r === 'cancelou', `"${t}" deu ${r}`).toBe(true)
      expect(r, `"${t}"`).not.toBe('confirmou')
    }
  })

  it('pergunta nunca é resposta', () => {
    for (const t of ['que horas mesmo?', 'sim?', 'é amanhã?', 'ok?']) {
      expect(interpretarResposta(t), `"${t}"`).toBe('nao_entendido')
    }
  })

  it('texto solto e vazio caem para humano', () => {
    for (const t of ['', '   ', 'bom dia', 'obrigado', 'quanto custa', '😀', 'aaaa']) {
      expect(interpretarResposta(t), `"${t}"`).toBe('nao_entendido')
    }
  })

  it('nunca devolve "confirmou" para nada que contenha negação', () => {
    // Varredura: qualquer frase com "não" jamais confirma.
    const frases = [
      'nao', 'nao posso', 'nao vou conseguir', 'hoje nao', 'nao confirmo',
      'nao da nao', 'infelizmente nao',
    ]
    for (const t of frases) {
      expect(interpretarResposta(t), `"${t}"`).not.toBe('confirmou')
    }
  })
})

describe('encaminhamento', () => {
  it('só o não entendido exige humano', () => {
    const casos: [Interpretacao, boolean][] = [
      ['confirmou', false],
      ['cancelou', false],
      ['nao_entendido', true],
    ]
    for (const [i, esperado] of casos) {
      expect(precisaDeHumano(i), i).toBe(esperado)
    }
  })
})
