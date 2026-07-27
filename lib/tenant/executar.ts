import { db, type Db } from '@/lib/db'
import { sql } from 'drizzle-orm'

/**
 * Executar com o tenant no contexto da transação.
 *
 * ── O que isto resolve ──────────────────────────────────────────────────────
 * Row Level Security precisa saber QUAL clínica está falando, e a única forma de
 * dizer isso ao Postgres sem passar o valor em toda query é uma variável de
 * sessão. Mas `lib/db/index.ts` usa um **pool**: a conexão que atendeu esta
 * requisição atende a próxima, de outra clínica. Uma variável de sessão comum
 * (`SET app.clinica_id`) sobreviveria à requisição e a clínica seguinte herdaria
 * o contexto da anterior — o vazamento exato que a RLS existe para impedir,
 * causado pelo mecanismo que deveria impedi-lo.
 *
 * Daí o envelope: `set_config(…, is_local => true)` vale **até o fim da
 * transação** e é desfeito no commit e no rollback, então a conexão volta ao pool
 * limpa. Sem transação não há contexto, e sem contexto `app_clinica_id()` estoura
 * — o erro é alto e imediato, não um relatório vazio.
 *
 * ── Por que `set_config()` e não `SET LOCAL` ────────────────────────────────
 * `SET LOCAL app.clinica_id = $1` **não existe**: o comando `SET` não aceita
 * parâmetro de bind, só literal. Interpolar o uuid na string funcionaria e seria
 * o começo de uma injeção de SQL no lugar mais sensível do sistema.
 * `set_config()` é função, aceita bind, e o terceiro argumento `true` é o
 * "LOCAL".
 *
 * ── Quem chama ──────────────────────────────────────────────────────────────
 * - a aplicação, uma vez por requisição, com o tenant vindo do `Ator` (staff) ou
 *   da `SessaoPortal` (paciente);
 * - os scripts de linha de comando e o despachante, **a cada iteração** — um
 *   laço que processa clínicas diferentes precisa trocar de contexto entre elas,
 *   e um `comClinica` em volta do laço inteiro daria a todas o contexto da
 *   primeira.
 */

/**
 * O que uma função de escrita/leitura aceita: o cliente direto ou a transação.
 *
 * Existe para os seeds e os scripts, que precisam rodar dentro do envelope. O
 * tipo da transação é derivado do próprio `db` em vez de escrito à mão — assinar
 * `PgTransaction<NodePgQueryResultHKT, …>` na mão é o tipo de declaração que
 * apodrece na próxima atualização do Drizzle.
 */
export type Transacao = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Executor = Db | Transacao

/**
 * Roda `fn` numa transação com `app.clinica_id` definido.
 *
 * Tudo dentro vê só a clínica indicada quando a RLS estiver ligada, e as colunas
 * `clinica_id` são preenchidas pelo `DEFAULT app_clinica_id()` — por isso os
 * ~114 pontos de escrita do sistema não precisaram passar a mencionar o tenant.
 */
export async function comClinica<T>(
  clinicaId: string,
  fn: (tx: Transacao) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.clinica_id', ${clinicaId}, true)`)
    return fn(tx)
  })
}
