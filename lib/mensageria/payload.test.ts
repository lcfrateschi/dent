import { describe, expect, it } from 'vitest'
import { extrairEventos } from './payload'

function envelope(valor: Record<string, unknown>): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: '123', changes: [{ field: 'messages', value: valor }] }],
  }
}

function mensagemTexto(texto: string, id = 'wamid.AAA'): unknown {
  return envelope({
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '551133334444', phone_number_id: '999' },
    contacts: [{ profile: { name: 'Maria' }, wa_id: '5511987654321' }],
    messages: [
      { from: '5511987654321', id, timestamp: '1786000000', type: 'text', text: { body: texto } },
    ],
  })
}

describe('mensagens recebidas', () => {
  it('extrai texto, remetente, id e interpretação', () => {
    const { mensagens, statuses, ignorados } = extrairEventos(mensagemTexto('Sim'))
    expect(statuses).toHaveLength(0)
    expect(ignorados).toBe(0)
    expect(mensagens).toHaveLength(1)
    expect(mensagens[0]).toMatchObject({
      idExterno: 'wamid.AAA',
      remetente: '5511987654321',
      texto: 'Sim',
      tipo: 'texto',
      interpretacao: 'confirmou',
    })
  })

  it('lê o carimbo em segundos, não em milissegundos', () => {
    const { mensagens } = extrairEventos(mensagemTexto('ok'))
    expect(mensagens[0]!.recebidoEm.toISOString()).toBe(new Date(1786000000 * 1000).toISOString())
  })

  it('carimbo ausente ou lixo não quebra — cai para agora', () => {
    for (const ts of [undefined, '', 'abc', '0', -5, {}]) {
      const bruto = envelope({
        messages: [{ from: '5511987654321', id: 'w1', timestamp: ts, type: 'text', text: { body: 'sim' } }],
      })
      const { mensagens } = extrairEventos(bruto)
      expect(mensagens, JSON.stringify(ts)).toHaveLength(1)
      expect(Number.isNaN(mensagens[0]!.recebidoEm.getTime())).toBe(false)
    }
  })

  it('entende resposta de botão de template', () => {
    const bruto = envelope({
      messages: [
        {
          from: '5511987654321',
          id: 'w2',
          timestamp: '1786000000',
          type: 'button',
          button: { text: 'Confirmar', payload: 'CONFIRMAR' },
        },
      ],
    })
    const { mensagens } = extrairEventos(bruto)
    expect(mensagens[0]).toMatchObject({ texto: 'Confirmar', tipo: 'botao', interpretacao: 'confirmou' })
  })

  it('entende botão interativo', () => {
    const bruto = envelope({
      messages: [
        {
          from: '5511987654321',
          id: 'w3',
          timestamp: '1786000000',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'nao', title: 'Não' } },
        },
      ],
    })
    const { mensagens } = extrairEventos(bruto)
    expect(mensagens[0]).toMatchObject({ texto: 'Não', interpretacao: 'cancelou' })
  })

  it('ÁUDIO não é descartado — vira marcador para a recepção ouvir', () => {
    // O paciente manda áudio dizendo "não posso amanhã". Jogar fora seria
    // perder a informação justamente quando ela é urgente.
    const bruto = envelope({
      messages: [
        { from: '5511987654321', id: 'w4', timestamp: '1786000000', type: 'audio', audio: { id: 'a1' } },
      ],
    })
    const { mensagens, ignorados } = extrairEventos(bruto)
    expect(ignorados).toBe(0)
    expect(mensagens[0]!.texto).toBe('[mensagem de áudio recebida]')
    expect(mensagens[0]!.tipo).toBe('outro')
    expect(mensagens[0]!.interpretacao).toBe('nao_entendido')
  })

  it('cobre os outros tipos de mídia', () => {
    for (const tipo of ['image', 'document', 'video', 'sticker', 'location', 'reaction']) {
      const bruto = envelope({
        messages: [{ from: '5511987654321', id: `w-${tipo}`, timestamp: '1786000000', type: tipo }],
      })
      const { mensagens } = extrairEventos(bruto)
      expect(mensagens, tipo).toHaveLength(1)
      expect(mensagens[0]!.texto.length, tipo).toBeGreaterThan(0)
      expect(mensagens[0]!.interpretacao, tipo).toBe('nao_entendido')
    }
  })

  it('tipo desconhecido no futuro não quebra', () => {
    const bruto = envelope({
      messages: [{ from: '5511987654321', id: 'w9', timestamp: '1786000000', type: 'holograma' }],
    })
    const { mensagens } = extrairEventos(bruto)
    expect(mensagens[0]!.texto).toContain('holograma')
    expect(mensagens[0]!.interpretacao).toBe('nao_entendido')
  })

  it('texto vazio vira marcador — o banco recusa corpo vazio', () => {
    const { mensagens } = extrairEventos(mensagemTexto(''))
    expect(mensagens[0]!.texto.length).toBeGreaterThan(0)
  })

  it('mensagem sem id ou sem remetente é ignorada, não aceita pela metade', () => {
    const bruto = envelope({
      messages: [
        { id: 'sem-from', timestamp: '1', type: 'text', text: { body: 'sim' } },
        { from: '5511987654321', timestamp: '1', type: 'text', text: { body: 'sim' } },
        'nem é objeto',
      ],
    })
    const { mensagens, ignorados } = extrairEventos(bruto)
    expect(mensagens).toHaveLength(0)
    expect(ignorados).toBe(3)
  })
})

describe('atualizações de status', () => {
  it('traduz delivered, read e failed', () => {
    const bruto = envelope({
      statuses: [
        { id: 'w1', status: 'delivered', timestamp: '1786000000', recipient_id: '5511987654321' },
        { id: 'w2', status: 'read', timestamp: '1786000060', recipient_id: '5511987654321' },
        {
          id: 'w3',
          status: 'failed',
          timestamp: '1786000120',
          errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Sem WhatsApp' } }],
        },
      ],
    })
    const { statuses } = extrairEventos(bruto)
    expect(statuses.map((s) => s.situacao)).toEqual(['entregue', 'lida', 'falhou'])
    expect(statuses[2]!.erro).toBe('Sem WhatsApp')
  })

  it('ignora "sent" — quem marca enviada é o nosso despacho', () => {
    const bruto = envelope({ statuses: [{ id: 'w1', status: 'sent', timestamp: '1' }] })
    const { statuses, ignorados } = extrairEventos(bruto)
    expect(statuses).toHaveLength(0)
    expect(ignorados).toBe(1)
  })

  it('falha sem detalhe ainda produz mensagem de erro', () => {
    const bruto = envelope({ statuses: [{ id: 'w1', status: 'failed', timestamp: '1', errors: [{}] }] })
    const { statuses } = extrairEventos(bruto)
    expect(statuses[0]!.erro).toBeTruthy()
  })
})

describe('tolerância a payload estranho', () => {
  it('nunca lança, seja lá o que chegue', () => {
    // Responder 500 faz a Meta reentregar em loop. Nada aqui pode explodir.
    const lixos: unknown[] = [
      null,
      undefined,
      42,
      'texto',
      [],
      {},
      { entry: 'não é lista' },
      { entry: [null, 1, 'x'] },
      { entry: [{ changes: {} }] },
      { entry: [{ changes: [{ value: null }] }] },
      { entry: [{ changes: [{}] }] },
      { entry: [{ changes: [{ value: { messages: 'x', statuses: 3 } }] }] },
    ]
    for (const lixo of lixos) {
      expect(() => extrairEventos(lixo), JSON.stringify(lixo)).not.toThrow()
      const r = extrairEventos(lixo)
      expect(r.mensagens).toHaveLength(0)
      expect(r.statuses).toHaveLength(0)
    }
  })

  it('processa lote com mensagem e status juntos, em várias entradas', () => {
    const bruto = {
      entry: [
        { changes: [{ value: { messages: [{ from: '5511999998888', id: 'a', timestamp: '1786000000', type: 'text', text: { body: 'sim' } }] } }] },
        { changes: [{ value: { statuses: [{ id: 'b', status: 'read', timestamp: '1786000000' }] } }] },
      ],
    }
    const r = extrairEventos(bruto)
    expect(r.mensagens).toHaveLength(1)
    expect(r.statuses).toHaveLength(1)
    expect(r.ignorados).toBe(0)
  })
})
