import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
/**
 * Chave no formato da Fase 17 em diante: `clinicas/<clinicaId>/…`.
 *
 * `salvar` recusa chave sem tenant (`CHAVE_SEM_TENANT`); `ler` aceita, porque
 * `drizzle/0011` congela `documento.storage_key` e arquivo já gravado não muda de
 * lugar. Os dois casos disso estão abaixo, juntos, para a assimetria não parecer
 * descuido.
 */
const CLINICA = randomUUID()
const CHAVE = `clinicas/${CLINICA}/pacientes/${randomUUID()}/2026/${randomUUID()}.jpg`

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
    const funda = `clinicas/${CLINICA}/a/b/c/d/e.jpg`
    await store.salvar(funda, CONTEUDO, 'image/jpeg')
    expect(await store.existe(funda)).toBe(true)
  })

  it('aguenta arquivo grande sem corromper', async () => {
    // 5 MB de conteúdo variado — pega erro de encoding que passa em texto curto.
    const grande = new Uint8Array(5 * 1024 * 1024)
    for (let i = 0; i < grande.length; i++) grande[i] = (i * 31 + 7) % 256

    const rasa = `clinicas/${CLINICA}/g.bin`
    const r = await store.salvar(rasa, grande, 'application/octet-stream')
    const lido = await store.ler(rasa)

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
      await store.ler(`clinicas/${CLINICA}/nao/existe.jpg`)
      expect.unreachable('devia ter lançado')
    } catch (e) {
      expect(e).toBeInstanceOf(ErroArmazenamento)
      expect((e as ErroArmazenamento).codigo).toBe('NAO_ENCONTRADO')
    }
  })

  it('GRAVAR exige que a chave declare a clínica', async () => {
    // Sem isto, um gerador novo que esquecesse o prefixo produziria arquivo que
    // nenhuma exportação por clínica encontraria — e o erro apareceria meses
    // depois, na hora de levar o prontuário de um cliente que está saindo.
    const antiga = 'pacientes/00000000-0000-4000-8000-000000000001/2026/x.jpg'
    try {
      await store.salvar(antiga, CONTEUDO, 'image/jpeg')
      expect.unreachable('devia ter lançado')
    } catch (e) {
      expect((e as ErroArmazenamento).codigo).toBe('CHAVE_SEM_TENANT')
    }
  })

  it('LER aceita chave anterior à Fase 17 — e isso é decisão, não esquecimento', async () => {
    // `drizzle/0011` congela `documento.storage_key`: renomear a chave de um
    // documento já gravado exigiria desligar uma trava de prontuário. Então o
    // arquivo antigo continua onde está, e a leitura continua funcionando. O
    // detalhe que prova a assimetria: a mesma chave que `salvar` recusa, `ler`
    // encontra.
    const antiga = `pacientes/${randomUUID()}/2026/${randomUUID()}.jpg`
    const alvo = join(raiz, antiga)
    await mkdir(dirname(alvo), { recursive: true })
    await writeFile(alvo, CONTEUDO)

    expect(await store.existe(antiga)).toBe(true)
    expect(Buffer.from(await store.ler(antiga)).equals(Buffer.from(CONTEUDO))).toBe(true)

    // E ela continua sendo recusada na escrita, no mesmo teste, para a assimetria
    // ficar visível a quem leia só um caso.
    await expect(store.salvar(antiga, CONTEUDO, 'image/jpeg')).rejects.toThrow()
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
