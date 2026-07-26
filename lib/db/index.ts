import 'dotenv/config'
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

/**
 * Cliente de conexão.
 *
 * ── Por que a conexão é PREGUIÇOSA ──────────────────────────────────────────
 * Antes, `DATABASE_URL` era exigida no topo do módulo. Parecia mais seguro e
 * quebrava o `next build`: a coleta de rotas importa cada página e cada rota de
 * API, então construir a imagem passava a exigir um banco — e um `docker
 * compose --profile prod build` falhava com "DATABASE_URL não definida", sem que
 * `npm test` ou `tsc` percebessem nada.
 *
 * Compilar não é conectar. O `Pool` do `pg` também não abre socket ao ser
 * construído — só na primeira query. Então o erro claro tem de aparecer na
 * primeira query, e é o que `poolReal()` faz.
 *
 * A garantia não afrouxou: nenhuma consulta acontece sem `DATABASE_URL`. O que
 * mudou é O MOMENTO da falha — da importação para o uso.
 *
 * `db` também é preguiçoso, e não só `pool`: `drizzle(pool, …)` lê membros do
 * pool ao ser construído, o que acordava o proxy na importação e recriava
 * exatamente o problema.
 */

let instancia: Pool | undefined

function poolReal(): Pool {
  if (instancia) return instancia
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL não definida. Copie .env.example para .env e preencha.')
  }
  instancia = new Pool({ connectionString: url })
  return instancia
}

/**
 * `pool` com a mesma interface de sempre para quem já o usa (`pool.connect()`,
 * `pool.end()`), mas construído no primeiro acesso a um membro.
 */
export const pool = new Proxy({} as Pool, {
  get(_alvo, prop, receptor) {
    const real = poolReal()
    const valor = Reflect.get(real, prop, receptor)
    return typeof valor === 'function' ? valor.bind(real) : valor
  },
  set(_alvo, prop, valor) {
    return Reflect.set(poolReal(), prop, valor)
  },
  has(_alvo, prop) {
    return Reflect.has(poolReal(), prop)
  },
})

type Cliente = NodePgDatabase<typeof schema> & { $client: Pool }

let clienteDrizzle: Cliente | undefined

function dbReal(): Cliente {
  if (!clienteDrizzle) clienteDrizzle = drizzle(poolReal(), { schema }) as Cliente
  return clienteDrizzle
}

export const db = new Proxy({} as Cliente, {
  get(_alvo, prop, receptor) {
    const real = dbReal()
    const valor = Reflect.get(real, prop, receptor)
    return typeof valor === 'function' ? valor.bind(real) : valor
  },
  has(_alvo, prop) {
    return Reflect.has(dbReal(), prop)
  },
})

export type Db = Cliente
export { schema }
