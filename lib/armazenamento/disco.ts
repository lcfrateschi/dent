import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { chaveEhSegura } from '@/lib/domain/arquivo'
import { ErroArmazenamento, exigirTenantNaChave, type ArquivoGuardado, type ProvedorArmazenamento } from './tipos'

/**
 * Armazenamento em disco.
 *
 * Não é um stub: é uma implementação completa, e para uma clínica que roda em um
 * servidor só ela é **a escolha certa** — um bucket remoto acrescenta custo,
 * latência e uma credencial a mais para vazar, sem resolver nada que o disco com
 * backup não resolva. O S3/R2 existe para quem quer durabilidade gerenciada e
 * várias instâncias.
 *
 * A defesa que este arquivo precisa ter é uma só, e é séria: **a chave nunca
 * pode escapar da raiz**. Uma chave com `..` viraria leitura de qualquer arquivo
 * do servidor. Por isso há duas barreiras independentes — `chaveEhSegura` na
 * forma da chave, e a conferência do caminho resolvido contra a raiz.
 */
export class ArmazenamentoEmDisco implements ProvedorArmazenamento {
  readonly nome = 'disco' as const
  private readonly raiz: string

  constructor(raiz: string) {
    if (raiz.trim().length === 0) {
      throw new ErroArmazenamento('NAO_CONFIGURADO', 'Raiz do armazenamento não informada.')
    }
    this.raiz = resolve(raiz)
  }

  /**
   * Traduz chave em caminho absoluto, recusando qualquer coisa que saia da raiz.
   *
   * A segunda checagem não é redundante: `chaveEhSegura` olha a forma do texto, e
   * esta olha o resultado depois de `resolve` — que é onde link simbólico e
   * normalização de plataforma poderiam surpreender.
   */
  private caminho(chave: string): string {
    if (!chaveEhSegura(chave)) {
      throw new ErroArmazenamento('CHAVE_INVALIDA', `Chave de armazenamento inválida: "${chave}".`)
    }
    const alvo = resolve(join(this.raiz, chave))
    if (alvo !== this.raiz && !alvo.startsWith(this.raiz + sep)) {
      throw new ErroArmazenamento(
        'CHAVE_INVALIDA',
        `Chave "${chave}" escaparia da raiz do armazenamento.`,
      )
    }
    return alvo
  }

  async salvar(chave: string, conteudo: Uint8Array, _mime: string): Promise<ArquivoGuardado> {
    exigirTenantNaChave(chave)
    const alvo = this.caminho(chave)

    if (await this.existe(chave)) {
      throw new ErroArmazenamento('JA_EXISTE', `Já existe arquivo na chave "${chave}".`)
    }

    try {
      await mkdir(dirname(alvo), { recursive: true })
      // `flag: 'wx'` falha se o arquivo aparecer entre o `existe` e o write —
      // a checagem acima dá mensagem boa, esta fecha a corrida.
      await writeFile(alvo, conteudo, { flag: 'wx' })
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') {
        throw new ErroArmazenamento('JA_EXISTE', `Já existe arquivo na chave "${chave}".`, e)
      }
      throw new ErroArmazenamento('FALHA_DE_ESCRITA', `Não consegui gravar "${chave}".`, e)
    }

    return {
      chave,
      tamanhoBytes: conteudo.byteLength,
      sha256: createHash('sha256').update(conteudo).digest('hex'),
    }
  }

  async ler(chave: string): Promise<Uint8Array> {
    const alvo = this.caminho(chave)
    try {
      return new Uint8Array(await readFile(alvo))
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        throw new ErroArmazenamento('NAO_ENCONTRADO', `Arquivo não encontrado: "${chave}".`, e)
      }
      throw new ErroArmazenamento('FALHA_DE_LEITURA', `Não consegui ler "${chave}".`, e)
    }
  }

  async existe(chave: string): Promise<boolean> {
    try {
      await access(this.caminho(chave), constants.F_OK)
      return true
    } catch {
      return false
    }
  }

  async remover(chave: string): Promise<void> {
    // `force: true` para ser idempotente: remover o que já não existe não é erro.
    await rm(this.caminho(chave), { force: true })
  }
}
