/**
 * Geração de CSV.
 *
 * Duas coisas para acertar, e a segunda é de segurança:
 *
 * 1. **Escape.** Vírgula, aspas e quebra de linha dentro do valor precisam de
 *    aspas duplas, e a aspas em si dobra. Nome de paciente com vírgula ("Silva,
 *    Maria") é o caso que aparece no primeiro dia.
 *
 * 2. **Injeção de fórmula.** Célula que começa com `=`, `+`, `-`, `@`, TAB ou CR
 *    é interpretada como FÓRMULA pelo Excel e pelo Google Sheets. Um paciente
 *    cadastrado como `=HYPERLINK("http://malicioso","clique")` — ou um campo de
 *    observação com `=cmd|...`— vira ataque contra quem abre a planilha, não
 *    contra o nosso servidor. É a razão de o CSV ser gerado por aqui e não por
 *    concatenação espalhada.
 *
 * O separador padrão é **ponto e vírgula**, não vírgula: o Excel em português usa
 * `;` e abrir um CSV com `,` joga tudo numa coluna só. Quem exporta é a recepção,
 * não um programa.
 */

const PERIGOSOS = ['=', '+', '-', '@', '\t', '\r']

/**
 * Neutraliza uma célula.
 *
 * Prefixa com apóstrofo o que o Excel leria como fórmula. O apóstrofo não aparece
 * na célula — é o marcador de texto literal —, então o dado continua legível.
 */
export function celulaCsv(valor: unknown, separador = ';'): string {
  if (valor === null || valor === undefined) return ''

  let texto = String(valor)

  // Número negativo legítimo (-150.00) começa com '-'. Deixar passar seria
  // esvaziar a proteção; prefixar quebraria o valor. A saída é aspas simples só
  // quando NÃO é número.
  const ehNumero = /^-?\d+([.,]\d+)?$/.test(texto)

  if (!ehNumero && PERIGOSOS.some((c) => texto.startsWith(c))) {
    texto = `'${texto}`
  }

  const precisaAspas =
    texto.includes(separador) ||
    texto.includes('"') ||
    texto.includes('\n') ||
    texto.includes('\r')

  return precisaAspas ? `"${texto.replace(/"/g, '""')}"` : texto
}

export interface OpcoesCsv {
  readonly separador?: string
  /**
   * BOM UTF-8 no início. **Ligado por padrão**: sem ele o Excel no Windows lê
   * "Restauração" como "RestauraÃ§Ã£o", e o relatório chega ilegível a quem
   * pediu.
   */
  readonly bom?: boolean
}

export function gerarCsv(
  cabecalho: readonly string[],
  linhas: readonly (readonly unknown[])[],
  opcoes: OpcoesCsv = {},
): string {
  const separador = opcoes.separador ?? ';'
  const partes = [cabecalho.map((c) => celulaCsv(c, separador)).join(separador)]

  for (const linha of linhas) {
    partes.push(linha.map((c) => celulaCsv(c, separador)).join(separador))
  }

  // CRLF: é o que a especificação do CSV pede e o que o Excel espera.
  const corpo = partes.join('\r\n')
  return (opcoes.bom === false ? '' : '﻿') + corpo
}

/**
 * Nome de arquivo seguro para `Content-Disposition`.
 *
 * Mesma preocupação de `nomeParaDownload` em `lib/domain/arquivo.ts`: aspas e CRLF
 * quebrariam o cabeçalho.
 */
export function nomeDeArquivoCsv(base: string, de: string, ate: string): string {
  const limpo = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${limpo || 'relatorio'}_${de}_a_${ate}.csv`
}

/** Dinheiro para planilha: vírgula decimal, sem símbolo nem separador de milhar. */
export function dinheiroCsv(valor: string): string {
  return valor.replace('.', ',')
}
