import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type CobrancaPix,
  ErroPix,
  type LiquidacaoPix,
  type PedidoDeCobranca,
  type ProvedorPix,
  type ResultadoNotificacao,
} from './tipos'

/**
 * Provedor Pix contra um PSP real, pela API padrão do Banco Central (Pix API v2).
 *
 * ⚠️ **ESTE ARQUIVO FOI ESCRITO PELA DOCUMENTAÇÃO E NUNCA EXECUTOU CONTRA A API
 * REAL.** É a mesma situação de `lib/mensageria/provedor/meta.ts`, com as mesmas
 * palavras de propósito: nenhuma credencial de PSP existe neste projeto, nenhuma
 * cobrança foi emitida, nenhuma notificação verdadeira foi recebida. O que se pode
 * afirmar é que o formato dos campos segue a especificação e que o caminho de
 * verificação de assinatura é o mesmo exercitado pelo provedor simulado.
 *
 * É o único arquivo desta fase que precisa de conferência linha a linha quando as
 * credenciais existirem. O que **está** verificado é tudo o que vem depois dele: o
 * evento gravado, a idempotência, a conciliação e o efeito no caixa.
 *
 * ── O que muda de PSP para PSP, e é onde a conferência vai doer ─────────────
 * A API de cobrança é padronizada pelo BC (`PUT /v2/cob/{txid}`), mas **a autenticação
 * e o webhook não são**: cada PSP escolhe mTLS, OAuth2 com certificado, ou token; e o
 * cabeçalho de assinatura da notificação varia de nome e de algoritmo. Os dois pontos
 * estão isolados aqui e marcados.
 */

export interface ConfigPsp {
  /** Base da API do PSP, ex. `https://pix.exemplo.com.br/api`. */
  readonly base: string
  readonly token: string
  /** Segredo do HMAC da notificação. Sem ele, nada é aceito. */
  readonly segredoWebhook: string
  /** Chave Pix da clínica que recebe. */
  readonly chave: string
  /** Nome do cabeçalho de assinatura. Varia por PSP — ver o aviso acima. */
  readonly cabecalhoAssinatura?: string
}

export class ProvedorPixPsp implements ProvedorPix {
  readonly nome = 'psp'

  constructor(private readonly cfg: ConfigPsp) {}

  /**
   * `PUT /v2/cob/{txid}` com `txid` que NÓS geramos.
   *
   * O padrão do BC permite ao cliente escolher o `txid` (é o que torna a emissão
   * idempotente do lado do PSP: repetir o `PUT` com o mesmo `txid` não cria duas
   * cobranças). Deixar o PSP gerar exigiria guardar o retorno antes de saber se a
   * chamada chegou — e uma cobrança emitida que não conhecemos é dinheiro que cai sem
   * dono.
   */
  async criarCobranca(pedido: PedidoDeCobranca): Promise<CobrancaPix> {
    if (Number(pedido.valor) <= 0) {
      throw new ErroPix('PEDIDO_INVALIDO', `Valor inválido para cobrança Pix: ${pedido.valor}.`)
    }
    const txid = pedido.descricao ? gerarTxid() : gerarTxid()

    const resposta = await fetch(`${this.cfg.base}/v2/cob/${txid}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        calendario: { expiracao: pedido.expiraEmSegundos },
        valor: { original: pedido.valor },
        chave: this.cfg.chave,
        // `solicitacaoPagador` aparece no app do banco do paciente, e a decisão fechada
        // do projeto vale aqui também: **nada de dado clínico**. A tela do celular do
        // paciente é lida por outras pessoas.
        solicitacaoPagador: pedido.descricao,
      }),
    })

    if (!resposta.ok) {
      throw new ErroPix(
        'RECUSADO_PELO_PSP',
        `PSP recusou a cobrança ${txid}: ${resposta.status} ${await resposta.text()}`,
      )
    }
    const corpo = (await resposta.json()) as {
      pixCopiaECola?: string
      calendario?: { expiracao?: number }
    }
    if (!corpo.pixCopiaECola) {
      throw new ErroPix('RECUSADO_PELO_PSP', `PSP não devolveu o copia-e-cola para ${txid}.`)
    }
    return {
      txid,
      copiaECola: corpo.pixCopiaECola,
      expiraEm: new Date(Date.now() + (corpo.calendario?.expiracao ?? pedido.expiraEmSegundos) * 1000),
    }
  }

  lerNotificacao(
    corpoBruto: string,
    cabecalhos: Readonly<Record<string, string | null>>,
  ): ResultadoNotificacao {
    if (!this.cfg.segredoWebhook) {
      return { valida: false, motivo: 'Segredo do webhook não configurado — notificação recusada.' }
    }
    const nome = (this.cfg.cabecalhoAssinatura ?? 'x-signature').toLowerCase()
    const assinatura = cabecalhos[nome] ?? null
    if (!assinatura) return { valida: false, motivo: `Cabeçalho ${nome} ausente.` }
    if (!/^[0-9a-f]{64}$/i.test(assinatura)) {
      return { valida: false, motivo: 'Assinatura não é um hex sha256 de 64 caracteres.' }
    }

    const esperada = createHmac('sha256', this.cfg.segredoWebhook).update(corpoBruto).digest('hex')
    if (
      !timingSafeEqual(Buffer.from(esperada, 'hex'), Buffer.from(assinatura.toLowerCase(), 'hex'))
    ) {
      return { valida: false, motivo: 'Assinatura não corresponde ao corpo.' }
    }

    let bruto: unknown
    try {
      bruto = JSON.parse(corpoBruto)
    } catch {
      return { valida: false, motivo: 'Corpo não é JSON válido.' }
    }
    const lista = (bruto as { pix?: unknown })?.pix
    if (!Array.isArray(lista)) return { valida: false, motivo: 'Payload sem a lista `pix`.' }

    const liquidacoes: LiquidacaoPix[] = []
    for (const item of lista) {
      const e = item as Record<string, unknown>
      if (
        typeof e.endToEndId !== 'string' ||
        typeof e.txid !== 'string' ||
        typeof e.valor !== 'string' ||
        typeof e.horario !== 'string'
      ) {
        return { valida: false, motivo: 'Liquidação com campo obrigatório ausente ou de tipo errado.' }
      }
      liquidacoes.push({
        endToEndId: e.endToEndId,
        txid: e.txid,
        valor: e.valor,
        liquidadoEm: new Date(e.horario),
      })
    }
    return { valida: true, liquidacoes }
  }
}

/** 32 caracteres alfanuméricos — dentro da faixa de 26 a 35 do padrão. */
function gerarTxid(): string {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let s = ''
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  for (const b of bytes) s += alfabeto[b % alfabeto.length]
  return s
}
