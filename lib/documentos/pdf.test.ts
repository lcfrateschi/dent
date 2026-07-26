import { describe, expect, it } from 'vitest'
import { detectarFormato } from '@/lib/domain/arquivo'
import { A4, type Linha, gerarPdf, quebrarLinhas } from './pdf'

function texto(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1')
}

/**
 * Relê a tabela xref e confere cada deslocamento.
 *
 * É o verificador que importa neste formato: deslocamento errado produz um
 * arquivo que abre "corrompido" sem dizer por quê, e é o efeito de contar bytes
 * em UTF-8 num arquivo escrito em Latin-1 — o erro clássico ao gerar PDF com
 * acento.
 */
function conferirXref(bytes: Uint8Array): { objetos: number; startxref: number } {
  const conteudo = texto(bytes)

  const posStartxref = conteudo.lastIndexOf('startxref')
  expect(posStartxref, 'startxref presente').toBeGreaterThan(0)

  const inicioXref = Number(
    conteudo
      .slice(posStartxref + 'startxref'.length)
      .trim()
      .split(/\s/)[0],
  )
  expect(Number.isFinite(inicioXref)).toBe(true)
  // O deslocamento tem de apontar exatamente para a palavra 'xref'.
  expect(conteudo.slice(inicioXref, inicioXref + 4)).toBe('xref')

  const bloco = conteudo.slice(inicioXref)
  const cabecalho = /^xref\n0 (\d+)\n/.exec(bloco)
  expect(cabecalho, 'cabeçalho do xref').not.toBeNull()
  const total = Number(cabecalho![1])

  const entradas = [...bloco.matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)]
  expect(entradas.length, 'uma entrada por objeto, mais a livre').toBe(total)

  // A primeira é a entrada livre; as demais têm de cair em "<n> 0 obj".
  entradas.slice(1).forEach((entrada, i) => {
    const deslocamento = Number(entrada[1])
    const numeroObjeto = i + 1
    expect(
      conteudo.slice(deslocamento, deslocamento + `${numeroObjeto} 0 obj`.length),
      `objeto ${numeroObjeto} no deslocamento ${deslocamento}`,
    ).toBe(`${numeroObjeto} 0 obj`)
  })

  return { objetos: total - 1, startxref: inicioXref }
}

const LINHAS: Linha[] = [
  { texto: 'ATESTADO ODONTOLÓGICO', fonte: 'negrito', tamanho: 14, centralizado: true },
  { texto: '' },
  { texto: 'Atesto que Joana Pereira esteve sob meus cuidados.', espacoAntes: 12 },
  { texto: 'Campinas, 26 de julho de 2026.' },
]

const OPCOES = { titulo: 'Atestado', criadoEm: new Date('2026-07-26T13:17:00Z') }

describe('estrutura do PDF', () => {
  it('começa com o cabeçalho e termina com %%EOF', () => {
    const pdf = gerarPdf(LINHAS, OPCOES)
    const s = texto(pdf)
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
  })

  it('é reconhecido como PDF pela nossa própria detecção de formato', () => {
    // Fecha o ciclo: o arquivo gerado passa pela validação de upload.
    const pdf = gerarPdf(LINHAS, OPCOES)
    expect(detectarFormato(pdf.slice(0, 132))).toBe('pdf')
  })

  it('a tabela xref aponta para os objetos certos', () => {
    const { objetos } = conferirXref(gerarPdf(LINHAS, OPCOES))
    // 5 fixos (catálogo, páginas, 2 fontes, info) + página + conteúdo.
    expect(objetos).toBe(7)
  })

  it('o xref continua correto com ACENTO no texto', () => {
    // Este é o caso que quebra: 'ç' e 'ã' contam 2 bytes em UTF-8 e 1 em Latin-1.
    // Se a contagem usar o encoding errado, todos os deslocamentos saem furados.
    const pdf = gerarPdf(
      [
        { texto: 'Atestado de comparecimento — ação, coração, José, Iúna' },
        { texto: 'Ãáâàçéêíóôõúü ÀÁÂÃÇÉÊÍÓÔÕÚÜ' },
      ],
      OPCOES,
    )
    conferirXref(pdf)
  })

  it('declara o /Length do fluxo em bytes, não em caracteres', () => {
    const pdf = gerarPdf([{ texto: 'ção ção ção ção ção' }], OPCOES)
    const s = texto(pdf)
    const declarado = Number(/<< \/Length (\d+) >>\nstream\n/.exec(s)![1])
    const inicio = s.indexOf('stream\n') + 'stream\n'.length
    const fim = s.indexOf('\nendstream')
    expect(fim - inicio).toBe(declarado)
  })

  it('usa A4 e as duas fontes', () => {
    const s = texto(gerarPdf(LINHAS, OPCOES))
    expect(s).toContain('/MediaBox [0 0 595.28 841.89]')
    expect(s).toContain('/BaseFont /Helvetica')
    expect(s).toContain('/BaseFont /Helvetica-Bold')
    expect(s).toContain('/Encoding /WinAnsiEncoding')
  })

  it('é reproduzível: mesma entrada, mesmos bytes', () => {
    // Necessário para o sha256 arquivado significar algo.
    const a = gerarPdf(LINHAS, OPCOES)
    const b = gerarPdf(LINHAS, OPCOES)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  it('sem linhas ainda produz um PDF válido de uma página', () => {
    const pdf = gerarPdf([], OPCOES)
    conferirXref(pdf)
    expect(texto(pdf)).toContain('/Count 1')
  })
})

describe('escape e codificação', () => {
  it('escapa parêntese e barra invertida', () => {
    // "Maria (Bebel)" quebraria o arquivo sem isto.
    const s = texto(gerarPdf([{ texto: 'Maria (Bebel) \\ fim' }], OPCOES))
    expect(s).toContain('(Maria \\(Bebel\\) \\\\ fim)')
    conferirXref(gerarPdf([{ texto: 'Maria (Bebel) \\ fim' }], OPCOES))
  })

  it('parêntese desbalanceado não quebra a estrutura', () => {
    for (const t of ['(', ')', '((()', 'a)b(c', '\\', '\\\\)']) {
      conferirXref(gerarPdf([{ texto: t }], OPCOES))
    }
  })

  it('acento sai em octal do WinAnsi', () => {
    const s = texto(gerarPdf([{ texto: 'ação' }], OPCOES))
    // ç = 0xE7 = 347 octal; ã = 0xE3 = 343 octal.
    expect(s).toContain('\\347')
    expect(s).toContain('\\343')
  })

  it('substitui o que não existe no Latin-1 em vez de gerar arquivo ilegível', () => {
    const s = texto(gerarPdf([{ texto: 'sorriso 😀 novo' }], OPCOES))
    expect(s).toContain('sorriso ? novo')
    conferirXref(gerarPdf([{ texto: 'sorriso 😀 novo' }], OPCOES))
  })

  it('normaliza aspas e travessões tipográficos', () => {
    const s = texto(gerarPdf([{ texto: '“aspas” ‘simples’ — travessão' }], OPCOES))
    expect(s).toContain('"aspas" \'simples\' - travess')
  })

  it('quebra de linha no texto não escapa para a sintaxe do PDF', () => {
    // Um \n cru dentro de string PDF é aceito, mas ) e ( seriam o problema;
    // aqui só se garante que a estrutura sobrevive.
    conferirXref(gerarPdf([{ texto: 'linha1\nlinha2' }], OPCOES))
  })
})

describe('quebra de linha', () => {
  it('divide o texto em linhas que caibam', () => {
    const linhas = quebrarLinhas('a '.repeat(200).trim(), 200, 11)
    expect(linhas.length).toBeGreaterThan(1)
  })

  it('não corta palavra maior que a linha', () => {
    // Cortar mudaria o conteúdo do documento.
    const gigante = 'a'.repeat(300)
    expect(quebrarLinhas(gigante, 100, 11)).toEqual([gigante])
  })

  it('texto vazio devolve uma linha vazia', () => {
    expect(quebrarLinhas('', 200, 11)).toEqual([''])
    expect(quebrarLinhas('   ', 200, 11)).toEqual([''])
  })

  it('colapsa espaços múltiplos', () => {
    expect(quebrarLinhas('a    b', 500, 11)).toEqual(['a b'])
  })
})

describe('paginação', () => {
  it('cria página nova quando o texto não cabe', () => {
    const muitas: Linha[] = Array.from({ length: 200 }, (_, i) => ({ texto: `Linha ${i + 1}` }))
    const pdf = gerarPdf(muitas, OPCOES)
    const s = texto(pdf)

    const contagem = /\/Count (\d+)/.exec(s)![1]
    expect(Number(contagem)).toBeGreaterThan(1)
    conferirXref(pdf)
  })

  it('o xref cresce junto com as páginas', () => {
    const muitas: Linha[] = Array.from({ length: 200 }, (_, i) => ({ texto: `Linha ${i + 1}` }))
    const { objetos } = conferirXref(gerarPdf(muitas, OPCOES))
    const paginas = Number(/\/Count (\d+)/.exec(texto(gerarPdf(muitas, OPCOES)))![1])
    // 5 fixos + 2 objetos por página.
    expect(objetos).toBe(5 + paginas * 2)
  })

  it('nenhum texto é posicionado fora da página', () => {
    const muitas: Linha[] = Array.from({ length: 120 }, (_, i) => ({ texto: `Linha ${i}` }))
    const s = texto(gerarPdf(muitas, OPCOES))
    const posicoes = [...s.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)]
    expect(posicoes.length).toBeGreaterThan(100)
    for (const p of posicoes) {
      const x = Number(p[1])
      const y = Number(p[2])
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(A4.largura)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThan(A4.altura)
    }
  })
})
