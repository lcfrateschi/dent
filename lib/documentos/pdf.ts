/**
 * Escritor de PDF mínimo, para atestado, receita e orçamento.
 *
 * **Por que gerar PDF no servidor em vez de "imprimir a página".** Um atestado é
 * documento: a clínica tem de poder mostrar, anos depois, exatamente o papel que
 * entregou. Imprimir a tela pelo navegador significa que o arquivo arquivado e o
 * que o paciente levou são dois artefatos diferentes — versão de navegador,
 * margem, fonte, tudo muda. Aqui o PDF é gerado uma vez, tem SHA-256 gravado no
 * prontuário, e é o mesmo byte a byte para quem imprime e para quem audita.
 *
 * **Por que sem biblioteca.** É texto em A4 com uma fonte padrão. O que uma
 * biblioteca traria (fontes embutidas, imagem, layout complexo) não é usado aqui,
 * e o formato mínimo do PDF é simples o suficiente para ser escrito e — o que
 * importa — **verificado**: o teste relê a tabela xref e confere que cada
 * deslocamento cai no objeto certo, que é o jeito de errar neste formato.
 *
 * ── Limites conhecidos, de propósito ────────────────────────────────────────
 * Helvetica com WinAnsiEncoding, que cobre o português (á, ç, ã, õ). Sem
 * compressão, sem imagem, sem fonte embutida. Caractere fora do Latin-1 (emoji,
 * por exemplo) é substituído — melhor um '?' visível que um PDF ilegível.
 */

/** A4 em pontos (1/72"). */
export const A4 = { largura: 595.28, altura: 841.89 } as const

export type Fonte = 'normal' | 'negrito'

export interface Linha {
  readonly texto: string
  readonly fonte?: Fonte
  readonly tamanho?: number
  /** Espaço extra antes da linha, em pontos. */
  readonly espacoAntes?: number
  readonly centralizado?: boolean
  /**
   * Recuo à esquerda, em pontos.
   *
   * Existe porque espaço no início do texto NÃO recua nada: a quebra de linha
   * normaliza espaços em branco, então "    posologia" sai colado na margem. Foi
   * o que apareceu ao ler a receita gerada com `pdftotext`.
   */
  readonly recuo?: number
}

export interface OpcoesPdf {
  readonly titulo: string
  readonly autor?: string
  readonly margem?: number
  /** Data de criação. Parâmetro para o PDF ser reproduzível em teste. */
  readonly criadoEm?: Date
}

const LARGURA_MEDIA_CARACTERE = 0.5

/**
 * Larguras da Helvetica, em milésimos de em.
 *
 * Só o suficiente para quebrar linha de forma decente. Uma tabela completa (todos
 * os 224 glifos WinAnsi) tornaria o arquivo enorme para ganhar milímetros; os
 * caracteres fora da tabela usam a média, o que erra para o lado seguro (o texto
 * quebra um pouco antes do fim da linha).
 */
const LARGURAS: Readonly<Record<string, number>> = {
  ' ': 0.278,
  '!': 0.278,
  '"': 0.355,
  '(': 0.333,
  ')': 0.333,
  ',': 0.278,
  '-': 0.333,
  '.': 0.278,
  '/': 0.278,
  ':': 0.278,
  ';': 0.278,
  i: 0.222,
  j: 0.222,
  l: 0.222,
  t: 0.278,
  f: 0.278,
  r: 0.333,
  I: 0.278,
  J: 0.5,
  m: 0.833,
  w: 0.667,
  M: 0.833,
  W: 0.944,
  A: 0.667,
  B: 0.667,
  C: 0.722,
  D: 0.722,
  E: 0.667,
  G: 0.778,
  H: 0.722,
  N: 0.722,
  O: 0.778,
  Q: 0.778,
  R: 0.722,
  U: 0.722,
  V: 0.667,
}

function larguraDoTexto(texto: string, tamanho: number, negrito: boolean): number {
  let soma = 0
  for (const c of texto) soma += LARGURAS[c] ?? LARGURA_MEDIA_CARACTERE
  // Negrito da Helvetica é ~5% mais largo. Aproximação suficiente para quebra.
  return soma * tamanho * (negrito ? 1.05 : 1)
}

/**
 * Quebra o texto em linhas que caibam na largura dada.
 *
 * Palavra maior que a linha inteira (uma URL, por exemplo) é deixada estourar em
 * vez de ser cortada no meio: cortar mudaria o conteúdo do documento.
 */
export function quebrarLinhas(
  texto: string,
  larguraMax: number,
  tamanho: number,
  negrito = false,
): readonly string[] {
  const palavras = texto.split(/\s+/).filter((p) => p.length > 0)
  if (palavras.length === 0) return ['']

  const linhas: string[] = []
  let atual = ''

  for (const palavra of palavras) {
    const candidato = atual.length === 0 ? palavra : `${atual} ${palavra}`
    if (larguraDoTexto(candidato, tamanho, negrito) <= larguraMax || atual.length === 0) {
      atual = candidato
    } else {
      linhas.push(atual)
      atual = palavra
    }
  }
  if (atual.length > 0) linhas.push(atual)
  return linhas
}

/**
 * Codifica em WinAnsi (Latin-1) e escapa o que o PDF trata como sintaxe.
 *
 * `(`, `)` e `\` delimitam e escapam string em PDF: um paciente chamado
 * "Maria (Bebel)" quebraria o arquivo sem isto.
 */
function textoPdf(texto: string): string {
  let saida = ''
  for (const c of texto) {
    const ponto = c.codePointAt(0)!
    if (c === '(' || c === ')' || c === '\\') {
      saida += `\\${c}`
    } else if (ponto === 0x2018 || ponto === 0x2019) {
      saida += "'"
    } else if (ponto === 0x201c || ponto === 0x201d) {
      saida += '"'
    } else if (ponto === 0x2013 || ponto === 0x2014) {
      saida += '-'
    } else if (ponto >= 32 && ponto <= 126) {
      saida += c
    } else if (ponto >= 160 && ponto <= 255) {
      // WinAnsi coincide com Latin-1 nesta faixa: octal para não depender do
      // encoding com que o arquivo é escrito.
      saida += `\\${ponto.toString(8).padStart(3, '0')}`
    } else {
      // Fora do Latin-1 (emoji, por exemplo). Um '?' visível é melhor que um
      // documento ilegível.
      saida += '?'
    }
  }
  return saida
}

interface Pagina {
  readonly comandos: string[]
}

/**
 * Monta o PDF.
 *
 * Estrutura: catálogo → páginas → cada página com seu content stream, fontes
 * compartilhadas, e a tabela xref no fim com o deslocamento de cada objeto.
 * Deslocamento errado é o defeito clássico — e é o que o teste confere.
 */
export function gerarPdf(linhas: readonly Linha[], opcoes: OpcoesPdf): Uint8Array {
  const margem = opcoes.margem ?? 56 // ~2 cm
  const larguraUtil = A4.largura - margem * 2
  const alturaUtil = A4.altura - margem * 2

  const paginas: Pagina[] = []
  let comandos: string[] = []
  let y = A4.altura - margem

  function novaPagina(): void {
    if (comandos.length > 0) paginas.push({ comandos })
    comandos = []
    y = A4.altura - margem
  }

  for (const linha of linhas) {
    const tamanho = linha.tamanho ?? 11
    const negrito = linha.fonte === 'negrito'
    const alturaLinha = tamanho * 1.45
    const espaco = linha.espacoAntes ?? 0

    const recuo = linha.recuo ?? 0
    const partes =
      linha.texto.length === 0
        ? ['']
        : quebrarLinhas(linha.texto, larguraUtil - recuo, tamanho, negrito)

    y -= espaco

    for (const parte of partes) {
      if (y - alturaLinha < margem) novaPagina()

      const x = linha.centralizado
        ? margem + (larguraUtil - larguraDoTexto(parte, tamanho, negrito)) / 2
        : margem + recuo

      comandos.push(
        `BT /${negrito ? 'F2' : 'F1'} ${tamanho} Tf 1 0 0 1 ${x.toFixed(2)} ${(y - tamanho).toFixed(2)} Tm (${textoPdf(parte)}) Tj ET`,
      )
      y -= alturaLinha
    }
  }
  novaPagina()
  if (paginas.length === 0) paginas.push({ comandos: [] })

  void alturaUtil
  return montarArquivo(paginas, opcoes)
}

function montarArquivo(paginas: readonly Pagina[], opcoes: OpcoesPdf): Uint8Array {
  // Numeração: 1 catálogo, 2 árvore de páginas, 3 e 4 fontes, 5 info,
  // depois cada página e cada conteúdo em par.
  const objetos: string[] = []
  const idPrimeiraPagina = 6

  const idsPaginas = paginas.map((_, i) => idPrimeiraPagina + i * 2)

  objetos.push('<< /Type /Catalog /Pages 2 0 R >>')
  objetos.push(
    `<< /Type /Pages /Kids [${idsPaginas.map((id) => `${id} 0 R`).join(' ')}] /Count ${paginas.length} >>`,
  )
  objetos.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objetos.push(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  )
  objetos.push(
    `<< /Title (${textoPdf(opcoes.titulo)}) /Producer (Facilident) /Creator (Facilident)` +
      `${opcoes.autor ? ` /Author (${textoPdf(opcoes.autor)})` : ''}` +
      ` /CreationDate (${carimboPdf(opcoes.criadoEm ?? new Date())}) >>`,
  )

  paginas.forEach((pagina, i) => {
    const idConteudo = idsPaginas[i]! + 1
    objetos.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.largura.toFixed(2)} ${A4.altura.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idConteudo} 0 R >>`,
    )
    const fluxo = pagina.comandos.join('\n')
    objetos.push(`<< /Length ${Buffer.byteLength(fluxo, 'latin1')} >>\nstream\n${fluxo}\nendstream`)
  })

  // Monta o corpo guardando o deslocamento de cada objeto. `latin1` em todo o
  // caminho: contar bytes em UTF-8 desalinharia o xref, que é o defeito que
  // deixa o arquivo "corrompido" sem explicação.
  let corpo = '%PDF-1.4\n'
  const deslocamentos: number[] = []

  objetos.forEach((conteudo, i) => {
    deslocamentos.push(Buffer.byteLength(corpo, 'latin1'))
    corpo += `${i + 1} 0 obj\n${conteudo}\nendobj\n`
  })

  const inicioXref = Buffer.byteLength(corpo, 'latin1')
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`
  for (const d of deslocamentos) {
    xref += `${String(d).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`

  return new Uint8Array(Buffer.from(corpo + xref, 'latin1'))
}

/** `D:20260726131700-03'00'` — formato de data do PDF. */
function carimboPdf(d: Date): string {
  const iso = d.toISOString()
  return `D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}
