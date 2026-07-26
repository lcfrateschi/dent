import { describe, expect, it } from 'vitest'
import {
  type CredenciaisAws,
  assinarPedido,
  carimboAmz,
  codificarAws,
  dataAmz,
  derivarChave,
  urlPreAssinada,
} from './sigv4'

/**
 * Vetores OFICIAIS da AWS.
 *
 * É o que torna possível afirmar que o SigV4 daqui está certo **sem ter conta na
 * AWS** — mesmo argumento dos vetores do RFC 6238 em `lib/auth/totp.test.ts`.
 * Se um destes falhar, a assinatura está errada e o S3 responderia
 * `SignatureDoesNotMatch`, que não explica nada.
 */

describe('derivação da chave de assinatura', () => {
  /**
   * A ordem da cadeia (data → região → serviço → `aws4_request`) fica provada
   * pelos vetores de pedido completo abaixo: um deles usa `service`, outro `s3`,
   * e trocar dois elos daria assinatura diferente em pelo menos um. Não há
   * constante avulsa aqui de propósito — conferir a derivação contra um número
   * que o próprio código produziu não provaria nada.
   */
  it('é sensível a cada elo da cadeia', () => {
    const c: CredenciaisAws = {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'iam',
    }
    const base = derivarChave(c, '20120215').toString('hex')

    expect(derivarChave(c, '20120216').toString('hex')).not.toBe(base)
    expect(derivarChave({ ...c, region: 'us-west-2' }, '20120215').toString('hex')).not.toBe(base)
    expect(derivarChave({ ...c, service: 's3' }, '20120215').toString('hex')).not.toBe(base)
    expect(derivarChave({ ...c, secretAccessKey: 'outro' }, '20120215').toString('hex')).not.toBe(base)
    // Região e serviço não são intercambiáveis — a ordem importa.
    expect(derivarChave({ ...c, region: 'iam', service: 'us-east-1' }, '20120215').toString('hex')).not.toBe(base)
    expect(base).toHaveLength(64)
  })
})

describe('get-vanilla (suíte de testes SigV4 da AWS)', () => {
  const c: CredenciaisAws = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
  }
  const agora = new Date('2015-08-30T12:36:00Z')

  it('produz o Authorization esperado', () => {
    const p = assinarPedido({
      metodo: 'GET',
      host: 'example.amazonaws.com',
      caminho: '/',
      hashDoCorpo: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      credenciais: c,
      agora,
    })

    expect(p.cabecalhos.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
  })
})

describe('S3 — exemplos da documentação', () => {
  const c: CredenciaisAws = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
  }
  const agora = new Date('2013-05-24T00:00:00Z')

  it('GET Object com Range — assinatura no cabeçalho', () => {
    const p = assinarPedido({
      metodo: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      caminho: '/test.txt',
      cabecalhos: {
        range: 'bytes=0-9',
        'x-amz-content-sha256':
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      hashDoCorpo: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      credenciais: c,
      agora,
    })

    expect(p.cabecalhos.authorization).toContain(
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
    expect(p.cabecalhos.authorization).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    )
  })

  it('URL pré-assinada de GET, 24 h', () => {
    const url = urlPreAssinada({
      metodo: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      caminho: '/test.txt',
      expiraEmSegundos: 86400,
      credenciais: c,
      agora,
    })

    expect(url).toContain(
      'X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
    expect(url).toContain('X-Amz-Expires=86400')
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request')
  })
})

describe('codificação de caminho e query', () => {
  it('codifica como a AWS, não como encodeURIComponent', () => {
    // `encodeURIComponent` deixa !'()* passarem — e é aí que a assinatura quebra
    // sem mensagem que ajude.
    expect(codificarAws("!'()*")).toBe('%21%27%28%29%2A')
    expect(codificarAws('a b')).toBe('a%20b')
    expect(codificarAws('a+b')).toBe('a%2Bb')
    expect(codificarAws('A-Za-z0-9-._~')).toBe('A-Za-z0-9-._~')
  })

  it('mantém a barra no caminho e a codifica na query', () => {
    expect(codificarAws('/pacientes/x/y.jpg', true)).toBe('/pacientes/x/y.jpg')
    expect(codificarAws('/pacientes/x/y.jpg')).toBe('%2Fpacientes%2Fx%2Fy.jpg')
  })

  it('codifica acento em UTF-8', () => {
    expect(codificarAws('ação')).toBe('a%C3%A7%C3%A3o')
  })

  it('a query sai em ordem alfabética', () => {
    const url = urlPreAssinada({
      metodo: 'GET',
      host: 'b.s3.amazonaws.com',
      caminho: '/k',
      expiraEmSegundos: 60,
      credenciais: {
        accessKeyId: 'A',
        secretAccessKey: 'S',
        region: 'auto',
        service: 's3',
      },
      agora: new Date('2026-07-26T13:17:00Z'),
      query: { 'response-content-type': 'image/jpeg' },
    })
    const query = url.split('?')[1]!
    const nomes = query.split('&').map((p) => p.split('=')[0]!)
    // X-Amz-Signature é acrescentada por último, fora da canônica.
    const canonicos = nomes.filter((n) => n !== 'X-Amz-Signature')
    expect(canonicos).toEqual([...canonicos].sort())
  })
})

describe('carimbos', () => {
  it('formata sem separadores e em UTC', () => {
    const d = new Date('2026-07-26T13:17:05.987Z')
    expect(carimboAmz(d)).toBe('20260726T131705Z')
    expect(dataAmz(d)).toBe('20260726')
  })

  it('não vaza fuso local', () => {
    // A mesma instante em qualquer fuso dá o mesmo carimbo.
    expect(carimboAmz(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('20260101T000000Z')
  })
})

describe('propriedades da assinatura', () => {
  const c: CredenciaisAws = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'segredo',
    region: 'auto',
    service: 's3',
  }
  const agora = new Date('2026-07-26T13:17:00Z')
  const base = {
    metodo: 'GET' as const,
    host: 'bucket.r2.cloudflarestorage.com',
    caminho: '/pacientes/a/2026/b.jpg',
    hashDoCorpo: 'UNSIGNED-PAYLOAD',
    credenciais: c,
    agora,
  }

  function assinatura(p: Parameters<typeof assinarPedido>[0]): string {
    return /Signature=([0-9a-f]+)/.exec(assinarPedido(p).cabecalhos.authorization ?? '')![1]!
  }

  it('muda se qualquer parte do pedido mudar', () => {
    const original = assinatura(base)
    expect(assinatura({ ...base, metodo: 'PUT' })).not.toBe(original)
    expect(assinatura({ ...base, caminho: '/outro.jpg' })).not.toBe(original)
    expect(assinatura({ ...base, hashDoCorpo: 'abc' })).not.toBe(original)
    expect(assinatura({ ...base, agora: new Date('2026-07-26T13:18:00Z') })).not.toBe(original)
    expect(assinatura({ ...base, credenciais: { ...c, secretAccessKey: 'outro' } })).not.toBe(original)
    expect(assinatura({ ...base, credenciais: { ...c, region: 'us-east-1' } })).not.toBe(original)
    expect(assinatura({ ...base, cabecalhos: { 'x-amz-meta-a': '1' } })).not.toBe(original)
  })

  it('é estável para o mesmo pedido', () => {
    expect(assinatura(base)).toBe(assinatura(base))
  })

  it('não é sensível a maiúsculas no nome do cabeçalho', () => {
    expect(assinatura({ ...base, cabecalhos: { 'Content-Type': 'image/jpeg' } })).toBe(
      assinatura({ ...base, cabecalhos: { 'content-type': 'image/jpeg' } }),
    )
  })

  it('colapsa espaço interno do valor, como manda a especificação', () => {
    expect(assinatura({ ...base, cabecalhos: { 'x-amz-meta-a': 'um   dois' } })).toBe(
      assinatura({ ...base, cabecalhos: { 'x-amz-meta-a': 'um dois' } })
    )
    expect(assinatura({ ...base, cabecalhos: { 'x-amz-meta-a': '  x  ' } })).toBe(
      assinatura({ ...base, cabecalhos: { 'x-amz-meta-a': 'x' } }),
    )
  })

  it('a URL montada preserva o caminho codificado', () => {
    const p = assinarPedido({ ...base, caminho: '/pacientes/a b/c.jpg' })
    expect(p.url).toBe('https://bucket.r2.cloudflarestorage.com/pacientes/a%20b/c.jpg')
  })
})
