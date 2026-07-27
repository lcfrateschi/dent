import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ProvedorPixSimulado } from './simulado'
import { provedorPixAtual } from './index'
import { ErroPix } from './tipos'

/**
 * A verificação de assinatura do webhook Pix.
 *
 * ── Por que isto não é opcional ─────────────────────────────────────────────
 * O endpoint tem de ser público — o PSP chama de fora. Sem conferir assinatura,
 * qualquer pessoa que descubra a URL faz um POST dizendo "caiu R$ 800 do txid X" e
 * **quita a parcela de um paciente que não pagou**. É a mesma exposição do webhook do
 * WhatsApp, com dinheiro em vez de agenda.
 */

const p = new ProvedorPixSimulado('segredo-de-teste')

/**
 * `NodeJS.ProcessEnv` deste projeto exige `NODE_ENV`, então `{} as NodeJS.ProcessEnv`
 * não compila. Um helper em vez de `as unknown as` espalhado: o cast duplo silencia o
 * compilador e é justamente o que esconderia um campo obrigatório novo amanhã.
 */
function ambiente(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...extra } as NodeJS.ProcessEnv
}

describe('escolha do provedor', () => {
  it('SIMULADO é o padrão — e isso é decisão de segurança', () => {
    // Se o padrão fosse "real quando não configurado", um ambiente com variáveis pela
    // metade emitiria cobrança de verdade contra a conta da clínica. Errar para o lado
    // de não cobrar é reversível; cobrar não é.
    expect(provedorPixAtual(ambiente()).nome).toBe('simulado')
    expect(provedorPixAtual(ambiente({ PIX_PROVEDOR: 'qualquer' })).nome).toBe('simulado')
  })

  it('`psp` sem credenciais ESTOURA em vez de cair para o simulado', () => {
    // Cair para o simulado aqui seria pior que falhar: um ambiente que se acha
    // configurado e silenciosamente não cobra ninguém.
    expect(() => provedorPixAtual(ambiente({ PIX_PROVEDOR: 'psp' }))).toThrowError(
      /PIX_PSP_BASE/,
    )
  })
})

describe('cobrança', () => {
  it('gera txid no tamanho do padrão', async () => {
    const c = await p.criarCobranca({ valor: '100.00', descricao: 'x', expiraEmSegundos: 3600 })
    // 26 a 35 caracteres no padrão do Banco Central. Gerar no teto é o que faz um
    // `varchar(30)` esquecido em algum lugar falhar aqui e não em produção.
    expect(c.txid.length).toBeGreaterThanOrEqual(26)
    expect(c.txid.length).toBeLessThanOrEqual(35)
    expect(c.copiaECola).toContain(c.txid)
  })

  it('recusa valor não positivo', async () => {
    await expect(
      p.criarCobranca({ valor: '0.00', descricao: 'x', expiraEmSegundos: 3600 }),
    ).rejects.toThrowError(ErroPix)
  })

  it('dois pedidos geram txid diferente', async () => {
    const a = await p.criarCobranca({ valor: '10.00', descricao: 'x', expiraEmSegundos: 60 })
    const b = await p.criarCobranca({ valor: '10.00', descricao: 'x', expiraEmSegundos: 60 })
    expect(a.txid).not.toBe(b.txid)
  })
})

describe('assinatura da notificação', () => {
  const notificacao = p.notificacaoDeTeste({
    endToEndId: 'E12345678202607271200abcdefghij',
    txid: 'txid-de-teste',
    valor: '250.00',
  })

  it('aceita o que ela mesma assinou', () => {
    const r = p.lerNotificacao(notificacao.corpo, notificacao.cabecalhos)
    expect(r.valida).toBe(true)
    if (r.valida) {
      expect(r.liquidacoes).toHaveLength(1)
      expect(r.liquidacoes[0]!.valor).toBe('250.00')
      expect(r.liquidacoes[0]!.endToEndId).toBe('E12345678202607271200abcdefghij')
    }
  })

  it('RECUSA corpo alterado — o HMAC é sobre os bytes', () => {
    // O ataque óbvio: pegar uma notificação legítima e trocar o valor.
    const adulterado = notificacao.corpo.replace('250.00', '2500.00')
    expect(adulterado).not.toBe(notificacao.corpo)
    const r = p.lerNotificacao(adulterado, notificacao.cabecalhos)
    expect(r.valida).toBe(false)
  })

  it('recusa sem cabeçalho, com hex curto e com assinatura de outro segredo', () => {
    expect(p.lerNotificacao(notificacao.corpo, {}).valida).toBe(false)
    expect(p.lerNotificacao(notificacao.corpo, { 'x-pix-signature': 'abc' }).valida).toBe(false)

    const deOutro = createHmac('sha256', 'outro-segredo').update(notificacao.corpo).digest('hex')
    expect(p.lerNotificacao(notificacao.corpo, { 'x-pix-signature': deOutro }).valida).toBe(false)
  })

  it('recusa payload sem os campos obrigatórios', () => {
    // Assinado corretamente e ainda assim recusado: assinatura válida não é o mesmo que
    // conteúdo utilizável, e aceitar campo ausente produziria `undefined` no lugar de um
    // valor em dinheiro.
    const corpo = JSON.stringify({ pix: [{ endToEndId: 'E1', txid: 't' }] })
    const assinatura = createHmac('sha256', 'segredo-de-teste').update(corpo).digest('hex')
    const r = p.lerNotificacao(corpo, { 'x-pix-signature': assinatura })
    expect(r.valida).toBe(false)
    if (!r.valida) expect(r.motivo).toMatch(/campo obrigatório/)
  })

  it('a REENTREGA é byte a byte igual — é o que a idempotência tem de absorver', () => {
    // O PSP reentrega a mesma liquidação quando não recebe 200. Se o `endToEndId`
    // mudasse a cada entrega, nenhuma trava por identificador funcionaria — e este teste
    // é o que garante que a premissa da conciliação é verdadeira.
    const a = p.notificacaoDeTeste({
      endToEndId: 'E12345678202607271200fixo000',
      txid: 't',
      valor: '10.00',
      liquidadoEm: new Date('2026-07-27T12:00:00Z'),
    })
    const b = p.notificacaoDeTeste({
      endToEndId: 'E12345678202607271200fixo000',
      txid: 't',
      valor: '10.00',
      liquidadoEm: new Date('2026-07-27T12:00:00Z'),
    })
    expect(a.corpo).toBe(b.corpo)
    expect(a.cabecalhos['x-pix-signature']).toBe(b.cabecalhos['x-pix-signature'])
  })
})

describe('endToEndId de teste', () => {
  it('tem o formato do arranjo Pix: E + ISPB(8) + AAAAMMDDHHMM(12) + sufixo(11)', () => {
    const e2e = ProvedorPixSimulado.endToEndIdDeTeste()
    expect(e2e).toHaveLength(32)
    expect(e2e.startsWith('E')).toBe(true)
    expect(/^E\d{8}\d{12}.{11}$/.test(e2e)).toBe(true)
  })
})
