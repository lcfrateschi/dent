/**
 * A fronteira com o PSP (provedor de serviço de pagamento).
 *
 * Pequena de propósito: quanto menos a aplicação souber sobre qual PSP está atendendo,
 * menos código muda quando a clínica trocar de banco — e vai trocar, porque MDR se
 * renegocia mudando de casa.
 */

export interface CobrancaPix {
  /** Identificador da cobrança no PSP. 26 a 35 caracteres no padrão do Banco Central. */
  readonly txid: string
  /** O "copia e cola" (BR Code) que o paciente usa. */
  readonly copiaECola: string
  readonly expiraEm: Date
}

export interface PedidoDeCobranca {
  readonly valor: string
  /** Aparece no app do banco do paciente. **Não leva dado clínico.** */
  readonly descricao: string
  readonly expiraEmSegundos: number
}

/**
 * Um evento de liquidação, já normalizado.
 *
 * `endToEndId` é a chave de idempotência: identifica a **liquidação** no arranjo Pix
 * (`E` + ISPB + timestamp + sufixo), e a reentrega do PSP carrega o mesmo valor.
 */
export interface LiquidacaoPix {
  readonly endToEndId: string
  readonly txid: string
  readonly valor: string
  readonly liquidadoEm: Date
}

export interface ProvedorPix {
  readonly nome: string
  criarCobranca(pedido: PedidoDeCobranca): Promise<CobrancaPix>
  /**
   * Confere a autenticidade da notificação e extrai as liquidações.
   *
   * Recebe o corpo **bruto**: assinatura é sobre bytes, e `JSON.parse` seguido de
   * `stringify` reordena chaves e quebra o HMAC.
   */
  lerNotificacao(
    corpoBruto: string,
    cabecalhos: Readonly<Record<string, string | null>>,
  ): ResultadoNotificacao
}

export type ResultadoNotificacao =
  | { readonly valida: true; readonly liquidacoes: readonly LiquidacaoPix[] }
  | { readonly valida: false; readonly motivo: string }

export class ErroPix extends Error {
  constructor(
    readonly codigo: 'NAO_CONFIGURADO' | 'RECUSADO_PELO_PSP' | 'PEDIDO_INVALIDO',
    mensagem: string,
    readonly causa?: unknown,
  ) {
    super(mensagem)
    this.name = 'ErroPix'
  }
}
