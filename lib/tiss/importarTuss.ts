import { readFile } from 'node:fs/promises'
import { db, pool } from '@/lib/db'
import { procedimento } from '@/lib/db/schema'
import {
  type LinhaTuss,
  type ResultadoImportacao,
  lerCsvTuss,
  normalizarDescricao,
} from '@/lib/domain/tuss'
import { eq, sql } from 'drizzle-orm'

/**
 * Importador da Terminologia Unificada em Saúde Suplementar (TUSS).
 *
 * `npm run tuss:importar -- caminho/do/arquivo.csv`
 *
 * ── Por que este arquivo não vem com dados ───────────────────────────────────
 * **Código TUSS inventado gera glosa.** A fonte é a Tabela 22 da ANS
 * (procedimentos odontológicos), publicada e revisada periodicamente pela agência.
 * Adivinhar um código que "parece certo" produz guia recusada e retrabalho — e o
 * pior: recusada em silêncio, semanas depois, quando o paciente já foi embora.
 *
 * Então o seed deixa `codigo_tuss` NULO de propósito (desde a Fase 1) e este
 * importador existe para receber o arquivo oficial quando a clínica baixá-lo do
 * site da ANS.
 *
 * ── Formato esperado ────────────────────────────────────────────────────────
 * CSV com separador `;` (o que o Excel brasileiro exporta), duas colunas mínimas:
 *
 *   codigo_tuss;descricao
 *   81000403;Restauração em resina composta - 2 faces
 *
 * O casamento com o catálogo é por **código interno** ou por descrição
 * aproximada, e o relatório diz exatamente o que não casou — porque casar errado é
 * pior que não casar: gera guia com código de outro procedimento.
 */

/**
 * Importa, casando com o catálogo.
 *
 * A ordem de casamento é do mais confiável para o menos:
 *
 *   1. **Código interno explícito** no arquivo — mapeamento que alguém fez à mão.
 *   2. **Descrição idêntica** depois de normalizar.
 *   3. Nada. Aproximação por palavra parecida **não** é tentada, e isso é decisão:
 *      "restauração 2 faces" e "restauração 3 faces" são parecidas e valem
 *      diferente. Casar errado gera guia com código de outro procedimento, o que é
 *      pior que guia sem código — a primeira é fraude involuntária, a segunda é
 *      glosa.
 */
export async function importarTuss(caminho: string): Promise<ResultadoImportacao> {
  const conteudo = await readFile(caminho, 'utf8')
  const { linhas, invalidas } = lerCsvTuss(conteudo)

  const catalogo = await db
    .select({
      id: procedimento.id,
      codigo: procedimento.codigo,
      nome: procedimento.nome,
      codigoTuss: procedimento.codigoTuss,
    })
    .from(procedimento)

  const porCodigoInterno = new Map(catalogo.map((p) => [p.codigo.toLowerCase(), p]))
  const porDescricao = new Map<string, typeof catalogo>()
  for (const p of catalogo) {
    const chave = normalizarDescricao(p.nome)
    porDescricao.set(chave, [...(porDescricao.get(chave) ?? []), p])
  }

  const semCorrespondencia: string[] = []
  const ambiguos: string[] = []
  let atualizados = 0

  for (const linha of linhas) {
    let alvo = linha.codigoInterno
      ? porCodigoInterno.get(linha.codigoInterno.toLowerCase())
      : undefined

    if (!alvo) {
      const candidatos = porDescricao.get(normalizarDescricao(linha.descricao)) ?? []
      if (candidatos.length === 1) {
        alvo = candidatos[0]
      } else if (candidatos.length > 1) {
        // Dois procedimentos do catálogo com o mesmo nome: quem decide é humano.
        ambiguos.push(`${linha.codigoTuss} "${linha.descricao}" casa com ${candidatos.length}`)
        continue
      }
    }

    if (!alvo) {
      semCorrespondencia.push(`${linha.codigoTuss} "${linha.descricao}"`)
      continue
    }

    await db
      .update(procedimento)
      .set({ codigoTuss: linha.codigoTuss })
      .where(eq(procedimento.id, alvo.id))
    atualizados++
  }

  const restantes = await db
    .select({ codigo: procedimento.codigo, nome: procedimento.nome })
    .from(procedimento)
    .where(sql`${procedimento.codigoTuss} is null and ${procedimento.ativo} = true`)
    .orderBy(procedimento.nome)

  return {
    lidas: linhas.length,
    atualizados,
    semCorrespondencia,
    ambiguos,
    formatoInvalido: invalidas,
    aindaSemTuss: restantes.map((r) => `${r.codigo} — ${r.nome}`),
  }
}

// ── Execução por linha de comando ────────────────────────────────────────────

async function main(): Promise<void> {
  const caminho = process.argv[2]

  if (!caminho) {
    console.error(`
Uso: npm run tuss:importar -- <arquivo.csv>

O arquivo vem da ANS: Tabela 22 (procedimentos odontológicos) da Terminologia
Unificada em Saúde Suplementar. Formato esperado, com separador ';':

  codigo_tuss;descricao[;codigo_interno]
  81000403;Restauração em resina composta - 2 faces;REST-2F

Sem este arquivo os procedimentos ficam com codigo_tuss NULO — de propósito.
Código inventado gera glosa, e glosa aparece semanas depois.
`)
    process.exit(1)
  }

  console.log(`\nImportando TUSS de ${caminho}…\n`)

  const r = await importarTuss(caminho)

  console.log(`  linhas válidas lidas ....... ${r.lidas}`)
  console.log(`  procedimentos atualizados .. ${r.atualizados}`)

  if (r.formatoInvalido.length > 0) {
    console.log(`\n  ⚠ ${r.formatoInvalido.length} linha(s) com formato inválido:`)
    for (const l of r.formatoInvalido.slice(0, 20)) console.log(`      ${l}`)
    if (r.formatoInvalido.length > 20) console.log(`      … e ${r.formatoInvalido.length - 20} outras`)
  }

  if (r.ambiguos.length > 0) {
    console.log(`\n  ⚠ ${r.ambiguos.length} caso(s) AMBÍGUO(S) — não importados:`)
    for (const l of r.ambiguos) console.log(`      ${l}`)
    console.log('      Resolva acrescentando a coluna de código interno no arquivo.')
  }

  if (r.semCorrespondencia.length > 0) {
    console.log(`\n  ${r.semCorrespondencia.length} código(s) do arquivo sem par no catálogo:`)
    for (const l of r.semCorrespondencia.slice(0, 20)) console.log(`      ${l}`)
    if (r.semCorrespondencia.length > 20) {
      console.log(`      … e ${r.semCorrespondencia.length - 20} outros`)
    }
    console.log('      (normal: a tabela da ANS tem mais procedimentos que a clínica faz)')
  }

  if (r.aindaSemTuss.length > 0) {
    console.log(`\n  ⚠ ${r.aindaSemTuss.length} procedimento(s) do catálogo AINDA sem TUSS:`)
    for (const l of r.aindaSemTuss) console.log(`      ${l}`)
    console.log('\n      Estes NÃO podem ser faturados a convênio até receberem código.')
  } else {
    console.log('\n  ✓ Todo o catálogo ativo tem código TUSS.')
  }

  console.log('')
}

// Só executa quando chamado direto, não quando importado pelo teste.
if (process.argv[1]?.includes('importarTuss')) {
  main()
    .then(async () => {
      await pool.end()
      process.exit(0)
    })
    .catch(async (e) => {
      console.error(e)
      await pool.end()
      process.exit(1)
    })
}
