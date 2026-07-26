import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4, escrito à mão.
 *
 * **Por que sem SDK.** O `@aws-sdk/client-s3` traz dezenas de pacotes para o que
 * este arquivo faz em 120 linhas — e o projeto já segue essa disciplina no
 * caminho de segurança (scrypt e TOTP também são de casa). Mais importante: o
 * SigV4 é **especificado com vetores de teste oficiais**, então dá para provar
 * que está certo sem ter conta na AWS. É o mesmo argumento que valeu para o TOTP.
 *
 * Compatível com Cloudflare R2, que fala o mesmo protocolo (região `auto`).
 *
 * As três armadilhas que os vetores da AWS existem para pegar:
 *
 * 1. **Ordem e normalização.** Cabeçalhos assinados em ordem alfabética, nome em
 *    minúsculas, valor com espaços internos colapsados. Um espaço a mais muda a
 *    assinatura inteira.
 * 2. **Codificação do caminho.** A chave vai percent-encoded, mas `/` continua
 *    `/` — e, ao contrário do resto da AWS, o S3 **não** codifica duas vezes.
 * 3. **Query em ordem de byte.** `X-Amz-...` ordenados por nome, valores
 *    codificados, `=` e `&` literais.
 */

const ALGORITMO = 'AWS4-HMAC-SHA256'

export interface CredenciaisAws {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly region: string
  readonly service: string
}

function sha256Hex(dado: string | Uint8Array): string {
  return createHash('sha256').update(dado).digest('hex')
}

function hmac(chave: Uint8Array | string, dado: string): Buffer {
  return createHmac('sha256', chave).update(dado, 'utf8').digest()
}

/**
 * Percent-encode conforme a AWS: nada além de `A-Za-z0-9-._~` passa, e o espaço
 * é `%20`, **não** `+`. `encodeURIComponent` deixa `!'()*` passarem, que é
 * exatamente onde uma assinatura quebra sem explicação aparente.
 */
export function codificarAws(valor: string, manterBarra = false): string {
  let saida = ''
  for (const byte of Buffer.from(valor, 'utf8')) {
    const c = String.fromCharCode(byte)
    if (/[A-Za-z0-9\-._~]/.test(c)) saida += c
    else if (c === '/' && manterBarra) saida += c
    else saida += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return saida
}

/** `20260726T131700Z` — sem separadores, sempre UTC. */
export function carimboAmz(agora: Date): string {
  return `${agora.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

/** `20260726`. */
export function dataAmz(agora: Date): string {
  return carimboAmz(agora).slice(0, 8)
}

export interface PedidoAssinado {
  readonly metodo: string
  readonly url: string
  readonly cabecalhos: Record<string, string>
}

/**
 * Assina um pedido com cabeçalho `Authorization`.
 *
 * `hashDoCorpo` é o SHA-256 do corpo em hex, ou `UNSIGNED-PAYLOAD`.
 *
 * Esta função é **só o SigV4 da especificação** — nada de S3 aqui. O S3 exige
 * também o cabeçalho `x-amz-content-sha256` com o mesmo valor, e quem coloca é o
 * provedor em `s3.ts`. Manter a separação é o que permite conferir esta função
 * contra os vetores oficiais da AWS, que não incluem esse cabeçalho.
 */
export function assinarPedido(p: {
  readonly metodo: string
  readonly host: string
  readonly caminho: string
  readonly query?: Readonly<Record<string, string>>
  readonly cabecalhos?: Readonly<Record<string, string>>
  readonly hashDoCorpo: string
  readonly credenciais: CredenciaisAws
  readonly agora: Date
}): PedidoAssinado {
  const { credenciais: c } = p
  const carimbo = carimboAmz(p.agora)
  const data = dataAmz(p.agora)

  const cabecalhos: Record<string, string> = {
    host: p.host,
    'x-amz-date': carimbo,
    ...minusculas(p.cabecalhos ?? {}),
  }

  const nomes = Object.keys(cabecalhos)
    .map((k) => k.toLowerCase())
    .sort()
  const cabecalhosCanonicos = nomes
    .map((n) => `${n}:${String(cabecalhos[n] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const assinados = nomes.join(';')

  const caminhoCanonico = codificarAws(p.caminho, true)
  const queryCanonica = queryCanonicaDe(p.query ?? {})

  const pedidoCanonico = [
    p.metodo,
    caminhoCanonico,
    queryCanonica,
    cabecalhosCanonicos,
    assinados,
    p.hashDoCorpo,
  ].join('\n')

  const escopo = `${data}/${c.region}/${c.service}/aws4_request`
  const paraAssinar = [ALGORITMO, carimbo, escopo, sha256Hex(pedidoCanonico)].join('\n')
  const assinatura = calcularAssinatura(paraAssinar, data, c)

  const url = `https://${p.host}${caminhoCanonico}${queryCanonica ? `?${queryCanonica}` : ''}`

  return {
    metodo: p.metodo,
    url,
    cabecalhos: {
      ...cabecalhos,
      authorization: `${ALGORITMO} Credential=${c.accessKeyId}/${escopo}, SignedHeaders=${assinados}, Signature=${assinatura}`,
    },
  }
}

/**
 * URL pré-assinada, com a assinatura na query.
 *
 * O sistema **não usa isto para servir documento ao navegador** — o download
 * passa pela nossa rota, para ser autorizado e auditado a cada acesso, e porque
 * URL assinada é encaminhável: quem recebe o link vê a radiografia sem sessão.
 * Fica aqui porque é o caminho certo para upload direto de arquivo grande no
 * futuro, e porque é o que os vetores de teste da AWS cobrem.
 */
export function urlPreAssinada(p: {
  readonly metodo: string
  readonly host: string
  readonly caminho: string
  readonly expiraEmSegundos: number
  readonly credenciais: CredenciaisAws
  readonly agora: Date
  readonly query?: Readonly<Record<string, string>>
}): string {
  const { credenciais: c } = p
  const carimbo = carimboAmz(p.agora)
  const data = dataAmz(p.agora)
  const escopo = `${data}/${c.region}/${c.service}/aws4_request`

  const query: Record<string, string> = {
    ...(p.query ?? {}),
    'X-Amz-Algorithm': ALGORITMO,
    'X-Amz-Credential': `${c.accessKeyId}/${escopo}`,
    'X-Amz-Date': carimbo,
    'X-Amz-Expires': String(p.expiraEmSegundos),
    'X-Amz-SignedHeaders': 'host',
  }

  const queryCanonica = queryCanonicaDe(query)
  const caminhoCanonico = codificarAws(p.caminho, true)

  const pedidoCanonico = [
    p.metodo,
    caminhoCanonico,
    queryCanonica,
    `host:${p.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const paraAssinar = [ALGORITMO, carimbo, escopo, sha256Hex(pedidoCanonico)].join('\n')
  const assinatura = calcularAssinatura(paraAssinar, data, c)

  return `https://${p.host}${caminhoCanonico}?${queryCanonica}&X-Amz-Signature=${assinatura}`
}

/**
 * Chave de assinatura derivada: secret → data → região → serviço → `aws4_request`.
 *
 * Exportada porque a AWS publica vetor de teste para ela isoladamente, e é o
 * primeiro lugar onde conferir quando uma assinatura não casa.
 */
export function derivarChave(c: CredenciaisAws, data: string): Buffer {
  const kData = hmac(`AWS4${c.secretAccessKey}`, data)
  const kRegion = hmac(kData, c.region)
  const kService = hmac(kRegion, c.service)
  return hmac(kService, 'aws4_request')
}

function calcularAssinatura(paraAssinar: string, data: string, c: CredenciaisAws): string {
  return createHmac('sha256', derivarChave(c, data)).update(paraAssinar, 'utf8').digest('hex')
}

function queryCanonicaDe(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${codificarAws(k)}=${codificarAws(query[k] ?? '')}`)
    .join('&')
}

function minusculas(o: Readonly<Record<string, string>>): Record<string, string> {
  const saida: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) saida[k.toLowerCase()] = v
  return saida
}

export { sha256Hex }
