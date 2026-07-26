/**
 * Formato e leitura da Tabela TUSS.
 *
 * Parte PURA do importador: validação de formato e parse do CSV. Fica no domínio —
 * e não junto do importador — porque o importador conversa com o banco, e uma
 * função de parse não deveria exigir `DATABASE_URL` para ser testada. Foi o que o
 * teste apontou.
 *
 * ── Por que não existe tabela TUSS embutida no projeto ───────────────────────
 * **Código inventado gera glosa.** A fonte é a Tabela 22 da ANS (procedimentos
 * odontológicos), publicada e revisada pela agência. Um código que "parece certo"
 * produz guia recusada semanas depois, quando o paciente já foi embora. O seed
 * deixa `codigo_tuss` NULO de propósito desde a Fase 1.
 */

export interface LinhaTuss {
  readonly codigoTuss: string
  readonly descricao: string
  /** Código interno do nosso catálogo, quando o arquivo trouxer o mapeamento. */
  readonly codigoInterno?: string
}

export interface ResultadoImportacao {
  readonly lidas: number
  readonly atualizados: number
  readonly semCorrespondencia: readonly string[]
  readonly ambiguos: readonly string[]
  readonly formatoInvalido: readonly string[]
  readonly aindaSemTuss: readonly string[]
}

/**
 * Formato do código TUSS odontológico.
 *
 * Oito dígitos, e os procedimentos odontológicos ficam na faixa que começa com
 * `81`. A checagem é de FORMATO, não de existência: só a ANS sabe se um código
 * existe, e é por isso que o arquivo dela é insumo obrigatório.
 */
export function codigoTussTemFormatoValido(codigo: string): boolean {
  return /^\d{8}$/.test(codigo.trim())
}

/** `true` para a faixa odontológica. Fora dela é provável erro de arquivo. */
export function ehFaixaOdontologica(codigo: string): boolean {
  return /^81\d{6}$/.test(codigo.trim())
}

/**
 * Lê o CSV.
 *
 * Tolerante com BOM, com aspas e com cabeçalho ausente — o arquivo vem de
 * download e passa por Excel antes de chegar aqui.
 */
export function lerCsvTuss(conteudo: string): {
  linhas: readonly LinhaTuss[]
  invalidas: readonly string[]
} {
  const semBom = conteudo.replace(/^﻿/, '')
  const linhas: LinhaTuss[] = []
  const invalidas: string[] = []

  for (const bruta of semBom.split(/\r?\n/)) {
    const linha = bruta.trim()
    if (linha.length === 0) continue

    const campos = linha.split(';').map((c) => c.trim().replace(/^"|"$/g, ''))
    const [primeiro, segundo, terceiro] = campos

    if (!primeiro) continue
    // Cabeçalho: primeira coluna não numérica.
    if (!/^\d/.test(primeiro)) continue

    if (!codigoTussTemFormatoValido(primeiro)) {
      invalidas.push(`${primeiro} — não são 8 dígitos`)
      continue
    }
    if (!ehFaixaOdontologica(primeiro)) {
      invalidas.push(`${primeiro} — fora da faixa odontológica (81xxxxxx)`)
      continue
    }

    linhas.push({
      codigoTuss: primeiro,
      descricao: segundo ?? '',
      codigoInterno: terceiro || undefined,
    })
  }

  return { linhas, invalidas }
}

/**
 * Normaliza descrição para comparação.
 *
 * Tira acento e pontuação porque o arquivo da ANS usa hífen simples onde o nosso
 * catálogo usa travessão — "resina composta - 2 faces" e "resina composta — 2
 * faces" são o mesmo procedimento e têm de casar.
 */
export function normalizarDescricao(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
