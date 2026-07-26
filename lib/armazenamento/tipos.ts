/**
 * A fronteira com o armazenamento de arquivos.
 *
 * Duas implementações: disco (padrão em desenvolvimento, e suficiente para uma
 * clínica que roda em um servidor só) e S3/R2 (bucket privado). A interface é
 * pequena de propósito — quanto menos a aplicação souber sobre onde o arquivo
 * mora, menos código muda quando isso mudar.
 *
 * **Não existe `urlPublica()`.** Isso é decisão, não esquecimento: radiografia é
 * dado de saúde, e todo acesso passa pela nossa rota para ser autorizado e
 * auditado. Ver `lib/documentos/` e a rota de download.
 */

export interface ArquivoGuardado {
  readonly chave: string
  readonly tamanhoBytes: number
  /** SHA-256 do conteúdo, em hexadecimal. Confere integridade na leitura. */
  readonly sha256: string
}

export interface ProvedorArmazenamento {
  readonly nome: 'disco' | 's3'

  /**
   * Grava o conteúdo na chave. Falha se a chave já existir — sobrescrever
   * silenciosamente um anexo de prontuário é perda de dado clínico, e as chaves
   * já são únicas por documento.
   */
  salvar(chave: string, conteudo: Uint8Array, mime: string): Promise<ArquivoGuardado>

  /** Lê o conteúdo inteiro. */
  ler(chave: string): Promise<Uint8Array>

  existe(chave: string): Promise<boolean>

  /**
   * Remove de verdade. Usado só para desfazer um upload que falhou no meio —
   * exclusão de documento é lógica (`documento.removido_em`), porque o prontuário
   * tem guarda de 20 anos.
   */
  remover(chave: string): Promise<void>
}

export class ErroArmazenamento extends Error {
  constructor(
    readonly codigo:
      | 'CHAVE_INVALIDA'
      | 'JA_EXISTE'
      | 'NAO_ENCONTRADO'
      | 'FALHA_DE_ESCRITA'
      | 'FALHA_DE_LEITURA'
      | 'NAO_CONFIGURADO',
    mensagem: string,
    readonly causa?: unknown,
  ) {
    super(mensagem)
    this.name = 'ErroArmazenamento'
  }
}
