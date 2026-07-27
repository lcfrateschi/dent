import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type CobrancaPix,
  ErroPix,
  type LiquidacaoPix,
  type PedidoDeCobranca,
  type ProvedorPix,
  type ResultadoNotificacao,
} from './tipos'

/**
 * PSP simulado. **É o padrão**, e isso é decisão de segurança.
 *
 * Se o padrão fosse "real quando não configurado", um ambiente com variáveis pela
 * metade emitiria cobrança de verdade contra a conta da clínica. Errar para o lado de
 * não cobrar é reversível; cobrar não é. Mesma escolha do provedor de WhatsApp, pelo
 * mesmo motivo.
 *
 * ── O que ele simula de verdade, e por que isso importa ─────────────────────
 * Não é um dublê que devolve `true`. Ele:
 *
 *   • gera `txid` e `end_to_end_id` no **formato real** (35 e 32 caracteres), porque
 *     campo com tamanho errado só falha no dia da integração;
 *   • **assina** a notificação com o mesmo HMAC-SHA256 que o provedor real confere, de
 *     modo que o caminho de verificação de assinatura é exercitado em desenvolvimento —
 *     e um bug ali é a diferença entre conciliar e aceitar POST de qualquer um;
 *   • reentrega, se pedirem: `liquidacaoDeTeste` produz o mesmo `endToEndId` duas
 *     vezes, que é o que a idempotência tem de sobreviver.
 */
export class ProvedorPixSimulado implements ProvedorPix {
  readonly nome = 'simulado'

  constructor(private readonly segredo = 'pix-simulado-dev') {}

  async criarCobranca(pedido: PedidoDeCobranca): Promise<CobrancaPix> {
    if (Number(pedido.valor) <= 0) {
      throw new ErroPix('PEDIDO_INVALIDO', `Valor inválido para cobrança Pix: ${pedido.valor}.`)
    }
    // 35 caracteres alfanuméricos: o teto do padrão. Gerar no tamanho máximo é o que
    // faz um `varchar(30)` esquecido em algum lugar falhar aqui, e não em produção.
    const txid = randomBytes(18).toString('hex').slice(0, 35)
    return {
      txid,
      copiaECola: `00020126SIMULADO${txid}5204000053039865802BR6009SIMULADO`,
      expiraEm: new Date(Date.now() + pedido.expiraEmSegundos * 1000),
    }
  }

  /**
   * Confere a assinatura e devolve as liquidações — o mesmo contrato do provedor real.
   *
   * Segredo ausente **recusa tudo**. Nunca "sem segredo, aceita": seria uma porta
   * escancarada com env pela metade, e o endpoint é público por necessidade.
   */
  lerNotificacao(
    corpoBruto: string,
    cabecalhos: Readonly<Record<string, string | null>>,
  ): ResultadoNotificacao {
    const assinatura = cabecalhos['x-pix-signature'] ?? null
    if (!assinatura) return { valida: false, motivo: 'Cabeçalho x-pix-signature ausente.' }

    const esperada = createHmac('sha256', this.segredo).update(corpoBruto).digest('hex')
    if (!/^[0-9a-f]{64}$/i.test(assinatura)) {
      return { valida: false, motivo: 'Assinatura não é um hex sha256 de 64 caracteres.' }
    }
    // Tempo constante: `===` para no primeiro byte diferente, e a diferença de tempo
    // vaza o prefixo correto para quem mede.
    const iguais = timingSafeEqual(
      Buffer.from(esperada, 'hex'),
      Buffer.from(assinatura.toLowerCase(), 'hex'),
    )
    if (!iguais) return { valida: false, motivo: 'Assinatura não corresponde ao corpo.' }

    let bruto: unknown
    try {
      bruto = JSON.parse(corpoBruto)
    } catch {
      return { valida: false, motivo: 'Corpo não é JSON válido.' }
    }
    const pix = (bruto as { pix?: unknown })?.pix
    if (!Array.isArray(pix)) return { valida: false, motivo: 'Payload sem a lista `pix`.' }

    const liquidacoes: LiquidacaoPix[] = []
    for (const item of pix) {
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

  /**
   * Monta uma notificação assinada — para teste e demonstração.
   *
   * Devolve o corpo e o cabeçalho, de modo que chamar duas vezes com o mesmo
   * `endToEndId` produz a **reentrega** que a idempotência tem de absorver.
   */
  notificacaoDeTeste(l: {
    readonly endToEndId: string
    readonly txid: string
    readonly valor: string
    readonly liquidadoEm?: Date
  }): { readonly corpo: string; readonly cabecalhos: Record<string, string> } {
    const corpo = JSON.stringify({
      pix: [
        {
          endToEndId: l.endToEndId,
          txid: l.txid,
          valor: l.valor,
          horario: (l.liquidadoEm ?? new Date()).toISOString(),
        },
      ],
    })
    return {
      corpo,
      cabecalhos: {
        'x-pix-signature': createHmac('sha256', this.segredo).update(corpo).digest('hex'),
      },
    }
  }

  /** `E` + ISPB (8) + AAAAMMDDHHMM (12) + sufixo (11) = 32 caracteres. */
  static endToEndIdDeTeste(sufixo = randomBytes(6).toString('hex').slice(0, 11)): string {
    const agora = new Date()
    const p = (n: number, casas = 2) => String(n).padStart(casas, '0')
    const carimbo =
      `${agora.getUTCFullYear()}${p(agora.getUTCMonth() + 1)}${p(agora.getUTCDate())}` +
      `${p(agora.getUTCHours())}${p(agora.getUTCMinutes())}`
    return `E${'12345678'}${carimbo}${sufixo.padEnd(11, '0').slice(0, 11)}`
  }
}
