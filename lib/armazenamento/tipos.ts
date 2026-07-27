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

import { chaveTemTenant } from '@/lib/domain/arquivo'

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

/**
 * Toda chave GRAVADA declara a clínica. Chave LIDA pode ser anterior à Fase 17.
 *
 * ── Por que a assimetria, que parece descuido e não é ───────────────────────
 * A tentação era exigir o prefixo nas duas pontas: uma regra, um lugar. Eu tentei,
 * e escrevi um `documentos:migrar-chaves` para renomear os arquivos antigos. **O
 * banco recusou**, e estava certo: `drizzle/0011` congela `documento.storage_key`
 * com esta justificativa — *"evita o pior tipo de bug silencioso: dois registros
 * apontando para o mesmo objeto, ou um registro apontando para o objeto de outro
 * paciente"*.
 *
 * Uma renomeação preserva a identidade, então não é o que aquela trava defende. Mas
 * a trava não sabe distinguir renomeação de reapontamento — e é exatamente por isso
 * que ela é cega. Para migrar, o script teria de desligar a trigger, ou seja: eu
 * teria posto no repositório, para sempre, um script cuja única função é fazer a
 * coisa que uma trava de prontuário existe para impedir. Custo alto, e para
 * resolver o quê? **Nenhuma instalação em produção existe**; chave antiga só há em
 * banco de desenvolvimento.
 *
 * Então a regra é: o gerador sempre põe o prefixo, a escrita cobra, e a leitura
 * aceita o que já está gravado. O que se perde com isso está registrado onde
 * importa (`prefixoDaClinica` em `lib/domain/arquivo.ts`): a exportação por clínica
 * **não pode varrer um prefixo** — ela enumera os arquivos a partir das linhas de
 * `documento`, que sabem o `clinica_id` de qualquer chave, nova ou antiga. O que,
 * pensando bem, é mais correto de todo modo: varrer prefixo encontraria também o
 * que não está no banco.
 */
export function exigirTenantNaChave(chave: string): void {
  if (!chaveTemTenant(chave)) {
    throw new ErroArmazenamento(
      'CHAVE_SEM_TENANT',
      `A chave "${chave}" não declara a clínica. Toda chave gravada é ` +
        '`clinicas/<clinicaId>/…` — use chaveArmazenamento() de lib/domain/arquivo.ts.',
    )
  }
}

export class ErroArmazenamento extends Error {
  constructor(
    readonly codigo:
      | 'CHAVE_INVALIDA'
      | 'CHAVE_SEM_TENANT'
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
