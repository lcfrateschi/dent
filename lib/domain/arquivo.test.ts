import { describe, expect, it } from 'vitest'
import {
  BYTES_PARA_DETECTAR,
  type FormatoArquivo,
  LIMITE_BYTES,
  chaveArmazenamento,
  chaveEhSegura,
  detectarFormato,
  emMegabytes,
  nomeParaDownload,
  podeExibirEmbutido,
  validarArquivo,
} from './arquivo'
import { ErroDominio } from './erros'

/** Monta um cabeçalho de arquivo com os bytes dados, preenchendo o resto. */
function bytes(...valores: (number | string)[]): Uint8Array {
  const lista: number[] = []
  for (const v of valores) {
    if (typeof v === 'number') lista.push(v)
    else for (const c of v) lista.push(c.charCodeAt(0))
  }
  return new Uint8Array(lista)
}

function comPreenchimento(tamanho: number, ...valores: (number | string)[]): Uint8Array {
  const base = bytes(...valores)
  const saida = new Uint8Array(tamanho)
  saida.set(base.slice(0, tamanho))
  return saida
}

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'JFIF')
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const PDF = bytes('%PDF-1.7\n')
const WEBP = bytes('RIFF', 0x24, 0x00, 0x00, 0x00, 'WEBP')
const HEIC = bytes(0x00, 0x00, 0x00, 0x18, 'ftyp', 'heic')
const TIFF_LE = bytes(0x49, 0x49, 0x2a, 0x00)
const TIFF_BE = bytes(0x4d, 0x4d, 0x00, 0x2a)

/** DICOM: 128 bytes de preâmbulo e depois 'DICM'. */
function dicom(): Uint8Array {
  const b = new Uint8Array(140)
  b.set(bytes('DICM'), 128)
  return b
}

describe('detectar formato pelos bytes', () => {
  it('reconhece os formatos aceitos', () => {
    const casos: [Uint8Array, FormatoArquivo][] = [
      [JPEG, 'jpeg'],
      [PNG, 'png'],
      [PDF, 'pdf'],
      [WEBP, 'webp'],
      [HEIC, 'heic'],
      [TIFF_LE, 'tiff'],
      [TIFF_BE, 'tiff'],
      [dicom(), 'dicom'],
    ]
    for (const [b, esperado] of casos) {
      expect(detectarFormato(b), esperado).toBe(esperado)
    }
  })

  it('reconhece as variantes de HEIC/HEIF que o iPhone produz', () => {
    for (const marca of ['heic', 'heix', 'mif1', 'msf1', 'heim']) {
      expect(detectarFormato(bytes(0, 0, 0, 0x18, 'ftyp', marca)), marca).toBe('heic')
    }
  })

  it('não confunde MP4 com HEIC — os dois são ISO-BMFF', () => {
    // 'ftypisom' é vídeo. Aceitar como imagem encheria o prontuário de vídeo.
    expect(detectarFormato(bytes(0, 0, 0, 0x18, 'ftyp', 'isom'))).toBeNull()
    expect(detectarFormato(bytes(0, 0, 0, 0x18, 'ftyp', 'mp42'))).toBeNull()
  })

  it('recusa o que não reconhece', () => {
    for (const b of [
      bytes(),
      bytes(0x00),
      bytes('MZ'), // executável Windows
      bytes(0x7f, 'ELF'), // executável Linux
      bytes('PK', 0x03, 0x04), // zip / docx
      bytes('<!DOCTYPE html>'),
      bytes('GIF89a'), // não está na lista de aceitos
      bytes('<?xml version="1.0"?>'),
    ]) {
      expect(detectarFormato(b)).toBeNull()
    }
  })

  it('DICOM precisa dos 132 bytes — truncado antes disso não conclui', () => {
    const completo = dicom()
    expect(detectarFormato(completo)).toBe('dicom')
    expect(detectarFormato(completo.slice(0, 131))).toBeNull()
    expect(BYTES_PARA_DETECTAR).toBe(132)
  })

  it('não estoura lendo além do buffer', () => {
    // Prefixo de cada assinatura, cortado em todo tamanho possível.
    for (const b of [JPEG, PNG, PDF, WEBP, HEIC, dicom()]) {
      for (let n = 0; n <= b.length; n++) {
        expect(() => detectarFormato(b.slice(0, n))).not.toThrow()
      }
    }
  })

  it('não deixa 0x00 no preâmbulo do DICOM virar outro formato', () => {
    const b = dicom()
    expect(detectarFormato(b)).toBe('dicom')
  })
})

describe('validar arquivo', () => {
  const base = { nome: 'panoramica.jpg', tamanhoBytes: 500_000, bytesIniciais: JPEG }

  it('aceita radiografia em JPEG', () => {
    const r = validarArquivo(base, 'radiografia')
    expect(r.formato.formato).toBe('jpeg')
    expect(r.mimeDivergente).toBe(false)
  })

  it('aceita DICOM em radiografia e em exame', () => {
    const a = { nome: 'tomo.dcm', tamanhoBytes: 30_000_000, bytesIniciais: dicom() }
    expect(validarArquivo(a, 'radiografia').formato.formato).toBe('dicom')
    expect(validarArquivo(a, 'exame').formato.formato).toBe('dicom')
  })

  it('aceita HEIC de iPhone como foto clínica, marcando que não exibe no navegador', () => {
    const r = validarArquivo(
      { nome: 'IMG_4823.HEIC', tamanhoBytes: 2_000_000, bytesIniciais: HEIC },
      'foto_clinica',
    )
    expect(r.formato.formato).toBe('heic')
    expect(r.formato.exibivelNoNavegador).toBe(false)
    expect(podeExibirEmbutido('heic')).toBe(false)
  })

  it('RECUSA arquivo cuja extensão mente sobre o conteúdo', () => {
    // .jpg com bytes de executável: o caso clássico.
    expect(() =>
      validarArquivo({ nome: 'foto.jpg', tamanhoBytes: 1000, bytesIniciais: bytes('MZ', 0x90) }, 'foto_clinica'),
    ).toThrowError(ErroDominio)
  })

  it('detecta divergência entre o mime declarado e o real', () => {
    const r = validarArquivo(
      { ...base, mimeDeclarado: 'image/png' },
      'radiografia',
    )
    expect(r.formato.formato).toBe('jpeg')
    expect(r.mimeDivergente).toBe(true)
  })

  it('tolera os mimes que o navegador erra de boa-fé', () => {
    for (const declarado of ['application/octet-stream', 'image/jpg', 'IMAGE/JPEG', 'image/jpeg; charset=binary', '']) {
      expect(validarArquivo({ ...base, mimeDeclarado: declarado }, 'radiografia').mimeDivergente, declarado).toBe(false)
    }
    expect(
      validarArquivo({ nome: 'x.heic', tamanhoBytes: 1000, bytesIniciais: HEIC, mimeDeclarado: 'image/heif' }, 'foto_clinica')
        .mimeDivergente,
    ).toBe(false)
  })

  it('recusa imagem onde só cabe PDF', () => {
    expect(() =>
      validarArquivo({ nome: 'receita.jpg', tamanhoBytes: 1000, bytesIniciais: JPEG }, 'receita'),
    ).toThrowError(ErroDominio)
    expect(
      validarArquivo({ nome: 'receita.pdf', tamanhoBytes: 1000, bytesIniciais: PDF }, 'receita').formato.formato,
    ).toBe('pdf')
  })

  it('recusa vídeo e DICOM em foto clínica', () => {
    expect(() =>
      validarArquivo({ nome: 'x.dcm', tamanhoBytes: 1000, bytesIniciais: dicom() }, 'foto_clinica'),
    ).toThrowError(ErroDominio)
  })

  it('o limite é por tipo — tomografia é grande, receita não', () => {
    expect(LIMITE_BYTES.exame).toBeGreaterThan(LIMITE_BYTES.receita)

    const grande = { nome: 'x.pdf', tamanhoBytes: LIMITE_BYTES.receita + 1, bytesIniciais: PDF }
    expect(() => validarArquivo(grande, 'receita')).toThrowError(ErroDominio)
    // O mesmo tamanho passa como exame.
    expect(() => validarArquivo({ ...grande, bytesIniciais: PDF }, 'exame')).not.toThrow()
  })

  it('a mensagem de tamanho diz os dois números', () => {
    try {
      validarArquivo({ nome: 'x.pdf', tamanhoBytes: 9 * 1024 * 1024, bytesIniciais: PDF }, 'receita')
      expect.unreachable('devia ter lançado')
    } catch (e) {
      expect(e).toBeInstanceOf(ErroDominio)
      expect((e as ErroDominio).message).toContain('9.0 MB')
      expect((e as ErroDominio).message).toContain('5.0 MB')
    }
  })

  it('recusa arquivo vazio', () => {
    expect(() =>
      validarArquivo({ nome: 'x.pdf', tamanhoBytes: 0, bytesIniciais: PDF }, 'outro'),
    ).toThrowError(ErroDominio)
  })

  it('todo tipo de documento tem limite definido', () => {
    // Um tipo novo no enum sem limite aqui aceitaria qualquer tamanho.
    const tipos = [
      'atestado',
      'receita',
      'termo_consentimento',
      'orcamento_pdf',
      'radiografia',
      'foto_clinica',
      'exame',
      'documento_pessoal',
      'outro',
    ] as const
    for (const t of tipos) {
      expect(LIMITE_BYTES[t], t).toBeGreaterThan(0)
    }
  })
})

describe('chave de armazenamento', () => {
  const p = {
    pacienteId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    documentoId: 'b1ffc99a-9c0b-4ef8-bb6d-6bb9bd380a11',
    extensao: 'jpg',
    ano: 2026,
  }

  it('não usa o nome enviado', () => {
    expect(chaveArmazenamento(p)).toBe(
      'pacientes/3fa85f64-5717-4562-b3fc-2c963f66afa6/2026/b1ffc99a-9c0b-4ef8-bb6d-6bb9bd380a11.jpg',
    )
  })

  it('é estável e única por documento', () => {
    expect(chaveArmazenamento(p)).toBe(chaveArmazenamento(p))
    expect(chaveArmazenamento({ ...p, documentoId: '00000000-0000-4000-8000-000000000001' })).not.toBe(
      chaveArmazenamento(p),
    )
  })

  it('normaliza para minúsculas', () => {
    expect(chaveArmazenamento({ ...p, pacienteId: p.pacienteId.toUpperCase() })).toBe(
      chaveArmazenamento(p),
    )
  })

  it('recusa entrada que não é uuid ou extensão', () => {
    expect(() => chaveArmazenamento({ ...p, pacienteId: '../etc' })).toThrowError(ErroDominio)
    expect(() => chaveArmazenamento({ ...p, documentoId: 'x' })).toThrowError(ErroDominio)
    expect(() => chaveArmazenamento({ ...p, extensao: '../sh' })).toThrowError(ErroDominio)
    expect(() => chaveArmazenamento({ ...p, extensao: 'JPG' })).toThrowError(ErroDominio)
    expect(() => chaveArmazenamento({ ...p, ano: 1800 })).toThrowError(ErroDominio)
  })

  it('toda chave que geramos é segura', () => {
    expect(chaveEhSegura(chaveArmazenamento(p))).toBe(true)
  })
})

describe('chave segura', () => {
  it('aceita chaves normais', () => {
    for (const c of [
      'pacientes/3fa85f64-5717-4562-b3fc-2c963f66afa6/2026/doc.jpg',
      'orcamentos/2026/990001.pdf',
      'a',
      'a/b/c.tar.gz',
    ]) {
      expect(chaveEhSegura(c), c).toBe(true)
    }
  })

  it('RECUSA travessia de diretório e variantes', () => {
    for (const c of [
      '../etc/passwd',
      'pacientes/../../etc/passwd',
      'a/./b',
      'a/../b',
      '/etc/passwd',
      'a//b',
      'a/',
      '',
      'a\\b',
      'a\0b',
      'a b',
      'ação.pdf',
      'a;rm -rf /',
      'a?b=1',
      'a%2e%2e/b',
      `${'a'.repeat(513)}`,
    ]) {
      expect(chaveEhSegura(c), JSON.stringify(c)).toBe(false)
    }
  })

  it('não confunde ".." dentro de um nome com travessia', () => {
    expect(chaveEhSegura('a/foto..jpg')).toBe(true)
  })
})

describe('nome para download', () => {
  it('tira acento e espaço, mantém legível', () => {
    expect(nomeParaDownload('Radiografia Panorâmica.JPG', 'jpg')).toBe('Radiografia-Panoramica.jpg')
    expect(nomeParaDownload('foto_antes.png', 'png')).toBe('foto_antes.png')
  })

  it('corrige a extensão para a real', () => {
    // O arquivo dizia .png mas é JPEG: baixa como .jpg.
    expect(nomeParaDownload('imagem.png', 'jpg')).toBe('imagem.jpg')
  })

  it('NEUTRALIZA o que quebraria o Content-Disposition', () => {
    // `"` fecharia o filename e `\r\n` injetaria cabeçalho.
    expect(nomeParaDownload('a"b.jpg', 'jpg')).toBe('ab.jpg')
    expect(nomeParaDownload('a\r\nX-Evil: 1.jpg', 'jpg')).toBe('aX-Evil-1.jpg')
    // Aqui sobra só pontuação depois de tirar barra e "extensão", então cai no
    // nome neutro. O que importa é o que NÃO sobra: barra e ponto-ponto.
    expect(nomeParaDownload('../../etc/passwd', 'pdf')).toBe('documento.pdf')
    expect(nomeParaDownload('../../etc/passwd.pdf', 'pdf')).toBe('etcpasswd.pdf')
    expect(nomeParaDownload(';rm -rf /', 'pdf')).toBe('rm-rf.pdf')
  })

  it('nunca devolve nome vazio nem só extensão', () => {
    for (const n of ['', '   ', '...', '😀', '///']) {
      const r = nomeParaDownload(n, 'pdf')
      expect(r, JSON.stringify(n)).toBe('documento.pdf')
    }
  })

  it('trunca nome absurdamente longo', () => {
    const r = nomeParaDownload('a'.repeat(500), 'jpg')
    expect(r.length).toBeLessThanOrEqual(84)
    expect(r.endsWith('.jpg')).toBe(true)
  })

  it('o resultado é sempre seguro para cabeçalho', () => {
    for (const n of ['a"b', 'a\r\nb', 'ação', '../x', 'a\\b', 'a\0b', '😀x']) {
      const r = nomeParaDownload(n, 'jpg')
      expect(/^[A-Za-z0-9._-]+$/.test(r), `${n} → ${r}`).toBe(true)
    }
  })
})

describe('tamanho legível', () => {
  it('escolhe a unidade', () => {
    expect(emMegabytes(500)).toBe('500 B')
    expect(emMegabytes(2048)).toBe('2 KB')
    expect(emMegabytes(1024 * 1024)).toBe('1.0 MB')
    expect(emMegabytes(5.5 * 1024 * 1024)).toBe('5.5 MB')
    expect(emMegabytes(60 * 1024 * 1024)).toBe('60 MB')
  })
})
