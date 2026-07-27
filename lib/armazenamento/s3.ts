import { createHash } from 'node:crypto'
import { chaveEhSegura } from '@/lib/domain/arquivo'
import { type CredenciaisAws, assinarPedido, sha256Hex } from './sigv4'
import { ErroArmazenamento, exigirTenantNaChave, type ArquivoGuardado, type ProvedorArmazenamento } from './tipos'

/**
 * Armazenamento em S3 ou Cloudflare R2 (bucket PRIVADO).
 *
 * ⚠️ **Nunca executou contra um bucket real.** Não há credencial de storage no
 * projeto, então este arquivo foi escrito a partir da especificação da API S3 e
 * é o que precisa de conferência quando o bucket existir. O que *está* provado
 * sem credencial é a assinatura: `lib/armazenamento/sigv4.test.ts` confere contra
 * os vetores oficiais da AWS, e é ali que mora o erro difícil de diagnosticar.
 *
 * Mesma disciplina do provedor da Meta na Fase 9: o resto do sistema fala com a
 * interface, o padrão é o provedor local, e trocar é variável de ambiente.
 *
 * **Estilo de endereço.** R2 e S3 moderno usam host virtual
 * (`<bucket>.<conta>.r2.cloudflarestorage.com`), então o bucket está no host e o
 * caminho é só a chave. Se algum dia for preciso o estilo antigo (bucket no
 * caminho), é aqui que muda — e a assinatura muda com ele, porque o caminho
 * canônico faz parte dela.
 */

export interface ConfigS3 {
  /** Host do bucket, sem esquema. Ex.: `facilident.abc123.r2.cloudflarestorage.com`. */
  readonly host: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** `auto` no R2; a região real na AWS. Entra na assinatura. */
  readonly region: string
  readonly tempoLimiteMs?: number
}

export class ArmazenamentoS3 implements ProvedorArmazenamento {
  readonly nome = 's3' as const
  private readonly cred: CredenciaisAws

  constructor(private readonly config: ConfigS3) {
    if (!config.host || !config.accessKeyId || !config.secretAccessKey) {
      throw new ErroArmazenamento(
        'NAO_CONFIGURADO',
        'Configuração de S3 incompleta: host, accessKeyId e secretAccessKey são obrigatórios.',
      )
    }
    this.cred = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      service: 's3',
    }
  }

  async salvar(chave: string, conteudo: Uint8Array, mime: string): Promise<ArquivoGuardado> {
    exigirTenantNaChave(chave)
    this.conferirChave(chave)

    // Não sobrescreve: anexo de prontuário perdido não volta. `If-None-Match: *`
    // é a forma condicional que S3 e R2 aceitam.
    if (await this.existe(chave)) {
      throw new ErroArmazenamento('JA_EXISTE', `Já existe objeto na chave "${chave}".`)
    }

    const hash = createHash('sha256').update(conteudo).digest('hex')

    const r = await this.chamar({
      metodo: 'PUT',
      chave,
      corpo: conteudo,
      hashDoCorpo: hash,
      cabecalhos: {
        'content-type': mime,
        'content-length': String(conteudo.byteLength),
        'if-none-match': '*',
      },
    })

    if (!r.ok) {
      if (r.status === 412) {
        throw new ErroArmazenamento('JA_EXISTE', `Já existe objeto na chave "${chave}".`)
      }
      throw new ErroArmazenamento(
        'FALHA_DE_ESCRITA',
        `S3 recusou o PUT de "${chave}": ${r.status} ${r.detalhe}`,
      )
    }

    return { chave, tamanhoBytes: conteudo.byteLength, sha256: hash }
  }

  async ler(chave: string): Promise<Uint8Array> {
    this.conferirChave(chave)
    const r = await this.chamar({ metodo: 'GET', chave, hashDoCorpo: VAZIO })

    if (r.status === 404) {
      throw new ErroArmazenamento('NAO_ENCONTRADO', `Objeto não encontrado: "${chave}".`)
    }
    if (!r.ok || !r.corpo) {
      throw new ErroArmazenamento(
        'FALHA_DE_LEITURA',
        `S3 recusou o GET de "${chave}": ${r.status} ${r.detalhe}`,
      )
    }
    return r.corpo
  }

  async existe(chave: string): Promise<boolean> {
    this.conferirChave(chave)
    const r = await this.chamar({ metodo: 'HEAD', chave, hashDoCorpo: VAZIO })
    if (r.status === 404) return false
    if (!r.ok) {
      throw new ErroArmazenamento(
        'FALHA_DE_LEITURA',
        `S3 recusou o HEAD de "${chave}": ${r.status} ${r.detalhe}`,
      )
    }
    return true
  }

  async remover(chave: string): Promise<void> {
    this.conferirChave(chave)
    const r = await this.chamar({ metodo: 'DELETE', chave, hashDoCorpo: VAZIO })
    // 204 é o sucesso; 404 também serve, remover o ausente é idempotente.
    if (!r.ok && r.status !== 404) {
      throw new ErroArmazenamento(
        'FALHA_DE_ESCRITA',
        `S3 recusou o DELETE de "${chave}": ${r.status} ${r.detalhe}`,
      )
    }
  }

  private conferirChave(chave: string): void {
    if (!chaveEhSegura(chave)) {
      throw new ErroArmazenamento('CHAVE_INVALIDA', `Chave de armazenamento inválida: "${chave}".`)
    }
  }

  private async chamar(p: {
    metodo: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
    chave: string
    hashDoCorpo: string
    corpo?: Uint8Array
    cabecalhos?: Record<string, string>
  }): Promise<{ ok: boolean; status: number; corpo?: Uint8Array; detalhe: string }> {
    const assinado = assinarPedido({
      metodo: p.metodo,
      host: this.config.host,
      caminho: `/${p.chave}`,
      // O S3 exige este cabeçalho e ele precisa ser o MESMO valor do hash
      // assinado. Divergir dá SignatureDoesNotMatch sem dizer o motivo.
      cabecalhos: { ...(p.cabecalhos ?? {}), 'x-amz-content-sha256': p.hashDoCorpo },
      hashDoCorpo: p.hashDoCorpo,
      credenciais: this.cred,
      agora: new Date(),
    })

    const controle = new AbortController()
    const prazo = setTimeout(() => controle.abort(), this.config.tempoLimiteMs ?? 30_000)

    try {
      const r = await fetch(assinado.url, {
        method: assinado.metodo,
        headers: assinado.cabecalhos,
        body: p.corpo ? Buffer.from(p.corpo) : undefined,
        signal: controle.signal,
      })

      if (p.metodo === 'GET' && r.ok) {
        return {
          ok: true,
          status: r.status,
          corpo: new Uint8Array(await r.arrayBuffer()),
          detalhe: '',
        }
      }

      // O S3 devolve o erro em XML. Não vale montar um parser: as primeiras
      // linhas do <Message> já dizem o que é.
      const detalhe = r.ok || p.metodo === 'HEAD' ? '' : (await r.text()).slice(0, 300)
      return { ok: r.ok, status: r.status, detalhe }
    } catch (e) {
      const abortou = e instanceof Error && e.name === 'AbortError'
      throw new ErroArmazenamento(
        p.metodo === 'GET' || p.metodo === 'HEAD' ? 'FALHA_DE_LEITURA' : 'FALHA_DE_ESCRITA',
        abortou
          ? `Tempo esgotado falando com o S3 em "${p.chave}".`
          : `Falha de rede falando com o S3: ${e instanceof Error ? e.message : String(e)}`,
        e,
      )
    } finally {
      clearTimeout(prazo)
    }
  }
}

/** SHA-256 do corpo vazio — o valor que o S3 espera em GET, HEAD e DELETE. */
const VAZIO = sha256Hex('')
