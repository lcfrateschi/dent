import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmazenamentoEmDisco } from './disco'
import { ErroArmazenamento } from './tipos'

let raiz: string
let store: ArmazenamentoEmDisco

beforeEach(async () => {
  raiz = await mkdtemp(join(tmpdir(), 'facilident-anexos-'))
  store = new ArmazenamentoEmDisco(raiz)
})

afterEach(async () => {
  await rm(raiz, { recursive: true, force: true })
})

const CONTEUDO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const CHAVE = `pacientes/${randomUUID()}/2026/${randomUUID()}.jpg`

describe('gravar e ler', () => {
  it('guarda o conteúdo e devolve tamanho e sha256', async () => {
    const r = await store.salvar(CHAVE, CONTEUDO, 'image/jpeg')

    expect(r.chave).toBe(CHAVE)
    expect(r.tamanhoBytes).toBe(CONTEUDO.byteLength)
    expect(r.sha256).toBe(createHash('sha256').update(CONTEUDO).digest('hex'))
  })

  it('devolve exatamente os mesmos bytes', async () => {
    await store.salvar(CHAVE, CONTEUDO, 'image/jpeg')
    const lido = await store.ler(CHAVE)
    expect([...lido]).toEqual([...CONTEUDO])
  })

  it('cria os diretórios do caminho', async () => {
    await store.salvar('a/b/c/d/e.jpg', CONTEUDO, 'image/jpeg')
    expect(await store.existe('a/b/c/d/e.jpg')).toBe(true)
  })

  it('aguenta arquivo grande sem corromper', async () => {
    // 5 MB de conteúdo variado — pega erro de encoding que passa em texto curto.
    const grande = new Uint8Array(5 * 1024 * 1024)
    for (let i = 0; i < grande.length; i++) grande[i] = (i * 31 + 7) % 256

    const r = await store.salvar('g.bin', grande, 'application/octet-stream')
    const lido = await store.ler('g.bin')

    expect(lido.byteLength).toBe(grande.byteLength)
    expect(createHash('sha256').update(lido).digest('hex')).toBe(r.sha256)
  })

  it('NÃO sobrescreve — anexo de prontuário perdido não volta', async () => {
    await store.salvar(CHAVE, CONTEUDO, 'image/jpeg')
    await expect(store.salvar(CHAVE, new Uint8Array([9]), 'image/jpeg')).rejects.toThrowError(
      ErroArmazenamento,
    )
    // E o original continua intacto.
    expect([...(await store.ler(CHAVE))]).toEqual([...CONTEUDO])
  })

  it('ler o que não existe é NAO_ENCONTRADO, não erro genérico', async () => {
    try {
      await store.ler('nao/existe.jpg')
      expect.unreachable('devia ter lançado')
    } catch (e) {
      expect(e).toBeInstanceOf(ErroArmazenamento)
      expect((e as ErroArmazenamento).codigo).toBe('NAO_ENCONTRADO')
    }
  })

  it('existe responde sem lançar', async () => {
    expect(await store.existe(CHAVE)).toBe(false)
    await store.salvar(CHAVE, CONTEUDO, 'image/jpeg')
    expect(await store.existe(CHAVE)).toBe(true)
  })

  it('remover é idempotente', async () => {
    await store.salvar(CHAVE, CONTEUDO, 'image/jpeg')
    await store.remover(CHAVE)
    expect(await store.existe(CHAVE)).toBe(false)
    await expect(store.remover(CHAVE)).resolves.toBeUndefined()
  })
})

describe('a chave NUNCA escapa da raiz', () => {
  /**
   * Este bloco é o motivo de o provedor em disco existir com cuidado. Uma chave
   * com travessia leria qualquer arquivo do servidor — `/etc/passwd`, o `.env`
   * com o segredo do JWT, o dump do banco.
   */
  const ATAQUES = [
    '../fora.jpg',
    '../../etc/passwd',
    'pacientes/../../../etc/passwd',
    'a/./../../b',
    '/etc/passwd',
    '/',
    '',
    '..',
    '.',
    'a//b',
    'a\\..\\b',
    'a\0.jpg',
    'a b.jpg',
    'açã.jpg',
    `${'a'.repeat(600)}.jpg`,
  ]

  it('recusa na leitura', async () => {
    for (const chave of ATAQUES) {
      await expect(store.ler(chave), JSON.stringify(chave)).rejects.toThrowError(ErroArmazenamento)
    }
  })

  it('recusa na escrita', async () => {
    for (const chave of ATAQUES) {
      await expect(
        store.salvar(chave, CONTEUDO, 'image/jpeg'),
        JSON.stringify(chave),
      ).rejects.toThrowError(ErroArmazenamento)
    }
  })

  it('recusa na remoção', async () => {
    for (const chave of ATAQUES) {
      await expect(store.remover(chave), JSON.stringify(chave)).rejects.toThrowError(
        ErroArmazenamento,
      )
    }
  })

  it('existe() devolve false em vez de vazar o resultado', async () => {
    for (const chave of ATAQUES) {
      expect(await store.existe(chave), JSON.stringify(chave)).toBe(false)
    }
  })

  it('um arquivo fora da raiz permanece ilegível', async () => {
    // Prova concreta: cria um segredo ao lado da raiz e tenta alcançá-lo.
    const segredo = join(raiz, '..', `segredo-${randomUUID()}.txt`)
    await writeFile(segredo, 'AUTH_SECRET=nao-devia-sair-daqui')

    try {
      for (const chave of ['../' + segredo.split('/').pop()!, `..%2f${segredo.split('/').pop()}`]) {
        await expect(store.ler(chave)).rejects.toThrowError(ErroArmazenamento)
      }
      // E o arquivo continua lá, intocado.
      expect(await readFile(segredo, 'utf8')).toContain('nao-devia-sair-daqui')
    } finally {
      await rm(segredo, { force: true })
    }
  })
})

describe('configuração', () => {
  it('recusa raiz vazia', () => {
    expect(() => new ArmazenamentoEmDisco('')).toThrowError(ErroArmazenamento)
    expect(() => new ArmazenamentoEmDisco('   ')).toThrowError(ErroArmazenamento)
  })

  it('identifica-se como disco', () => {
    expect(store.nome).toBe('disco')
  })
})
