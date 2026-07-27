import { sql } from 'drizzle-orm'
import { bigint, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { clinicaId } from './tenant'

/**
 * Numeração sequencial POR CLÍNICA — orçamento e guia TISS.
 *
 * ── Por que uma tabela, e não a sequence que já existia ─────────────────────
 * `orcamento_numero_seq` e `guia_numero_seq` são sequences globais. Com várias
 * clínicas no mesmo banco elas continuariam corretas (número nunca repete), e
 * ainda assim erradas: a clínica veria os próprios orçamentos numerados 1, 7, 12,
 * 31 — os buracos são os documentos das OUTRAS clínicas. Para quem recebe, isso
 * lê como "cadê o orçamento 2 ao 6?", e a resposta honesta ("estão em outro
 * cliente nosso") é a pior possível.
 *
 * ── Por que isto NÃO é o `max(numero) + 1` que a 0014 rejeitou ──────────────
 * A `drizzle/0014` recusou `max(numero) + 1` por concorrência, com razão: dois
 * faturamentos simultâneos leem o mesmo máximo e geram o mesmo número. O
 * mecanismo aqui é diferente — um `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * sobre **uma linha**: quem chega primeiro trava a linha do contador daquela
 * clínica, quem chega depois espera e lê o valor já incrementado. Não existe
 * janela entre ler e gravar, porque é a mesma instrução.
 *
 * O lock é por (clínica, escopo): duas clínicas faturando ao mesmo tempo não se
 * esperam. Duas pessoas da MESMA clínica se esperam por alguns milissegundos, o
 * que é o preço da numeração sem buraco — e é o comportamento certo, porque
 * numeração contígua é justamente uma exigência de serialização.
 *
 * Ganho de lambuja sobre a sequence: transação abortada **devolve** o número, em
 * vez de queimá-lo. A 0014 documentava o buraco como aceitável; agora não há
 * buraco.
 */
export const contador = pgTable(
  'contador',
  {
    clinicaId: clinicaId(),
    /**
     * `'orcamento'`, `'guia_tiss'` ou `'ordem_laboratorio'`. Texto e não enum:
     * acrescentar escopo não deve pedir migration de tipo — e foi exatamente isso
     * que permitiu a ordem de laboratório entrar na Fase 21 sem tocar num `ALTER
     * TYPE`, que não pode usar o valor novo na mesma transação que o cria.
     */
    escopo: text('escopo').notNull(),
    /** O PRÓXIMO número a entregar. Começa em 1. */
    proximo: bigint('proximo', { mode: 'number' }).notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.clinicaId, t.escopo] })],
)

/**
 * O default das colunas de número. Ler `proximo_numero('orcamento')` já
 * incrementa — é function volátil de propósito, e por isso **não** pode ser usada
 * em consulta de leitura.
 */
export function proximoNumero(escopo: 'orcamento' | 'guia_tiss' | 'ordem_laboratorio') {
  /**
   * `sql.raw` e não `sql\`…${escopo}\``: o `drizzle-kit generate` recusa
   * parâmetro de bind em valor de DEFAULT ("we don't support params for `sql`
   * default values") — e com razão, porque um DEFAULT vive no catálogo do banco,
   * onde não existe parâmetro para ligar.
   *
   * `raw` com interpolação normalmente seria caminho de injeção. Aqui não é: o
   * tipo do argumento é uma união de dois literais, então o compilador só deixa
   * passar 'orcamento' ou 'guia_tiss'. Se um dia isto virar `string`, volta a ser.
   */
  return sql.raw(`proximo_numero('${escopo}')`)
}
