import 'dotenv/config'
import { clinicaDoContexto } from '@/lib/tenant/armazem'
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type PoolClient } from 'pg'
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

/**
 * ── O contexto de clínica entra AQUI, ao pegar conexão ──────────────────────
 *
 * Desde a `drizzle/0022` toda coluna `clinica_id` tem `DEFAULT app_clinica_id()`,
 * e essa função **estoura** sem contexto. Então alguém tem de definir
 * `app.clinica_id` antes de qualquer consulta — e "antes de qualquer consulta"
 * quer dizer, na prática, ao pegar a conexão do pool.
 *
 * Este é o único lugar do sistema que faz isso, e é por isso que as centenas de
 * chamadas `db.select(…)` e `db.insert(…)` espalhadas pelo código **não
 * precisaram mudar**. Se o tenant tivesse de ser passado adiante, seriam ~114
 * pontos de escrita para tocar, e o que ficasse de fora gravaria na clínica
 * errada em silêncio.
 *
 * ── Por que na ACQUISIÇÃO e não em `pool.on('connect')` ────────────────────
 * `on('connect')` roda quando uma conexão NOVA é aberta — não quando uma já
 * existente é reaproveitada. Num pool, a segunda requisição costuma reusar a
 * conexão da primeira, e herdaria o contexto dela. Com uma clínica só isso é
 * inofensivo (o valor é o mesmo), com duas é o vazamento exato que a RLS existe
 * para impedir. Aqui roda em toda acquisição, então o valor é sempre reescrito e
 * carry-over não existe.
 *
 * (O `on('connect')` que estava aqui antes tinha um segundo problema: não
 * esperava o `set_config` terminar. A primeira consulta podia sair na frente.)
 *
 * ── Por que `set_config(…, false)` e não `LOCAL` ───────────────────────────
 * `LOCAL` só vale dentro de transação, e aqui não há uma — a conexão acabou de
 * ser pega e o que vem depois pode ser uma consulta solta. O que substitui a
 * garantia do `LOCAL` é o parágrafo acima: como toda acquisição reescreve o
 * valor, nunca se lê o de outro. `comClinica()` (`lib/tenant/executar.ts`)
 * continua usando `LOCAL`, porque lá existe transação e é a forma mais forte.
 */
async function definirContexto(cliente: PoolClient, clinicaId: string | null): Promise<void> {
  if (clinicaId) {
    await cliente.query('select set_config($1, $2, false)', ['app.clinica_id', clinicaId])
    return
  }

  /**
   * ── Sem sessão: o contexto é LIMPO, não adivinhado ─────────────────────────
   *
   * Há caminhos legítimos sem tenant, e todos eles são "antes de saber de quem é":
   * a tela de login, o `authorize()` do Auth.js **antes** de resolver a clínica
   * pelo e-mail, a leitura da sessão do portal **antes** de resolver pelo hash do
   * token, o webhook do WhatsApp **antes** de resolver pelo `phone_number_id`, e a
   * coleta de rotas do `next build`.
   *
   * Aqui havia um andaime: `set_config('app.clinica_id', (select id from clinica))`,
   * que caía na única clínica do banco. Ele saiu por dois motivos, e o segundo é o
   * que importa:
   *
   * 1. sob RLS, ler `clinica` **já exige contexto** — o andaime tentava resolver o
   *    contexto lendo a tabela que o contexto protege, e a role de aplicação não
   *    conseguia nem abrir conexão;
   * 2. adivinhar tenant é a categoria de erro que esta fase existe para eliminar.
   *    Os três pontos que precisavam dele agora resolvem a clínica **a partir da
   *    credencial que o cliente apresentou** (`lib/tenant/resolver.ts`), que é a
   *    única fonte legítima.
   *
   * ── Por que LIMPAR e não simplesmente não definir ──────────────────────────
   * Esta é a parte que não pode ser omitida. A conexão vem de um **pool**: se a
   * requisição anterior era da clínica A e esta não tem sessão, deixar o valor
   * como está faz a consulta de login rodar **filtrada pela clínica A**. Com duas
   * clínicas isso é o vazamento clássico de carry-over em pool — e ele acerta
   * exatamente o caminho de autenticação, o pior lugar possível.
   *
   * Limpando, `app_clinica_id()` volta a estourar com a mensagem que diz o que
   * fazer. Fecha, não abre.
   */
  await cliente.query('select set_config($1, $2, false)', ['app.clinica_id', ''])
}

/**
 * `Pool` que entrega toda conexão já com o contexto de clínica definido.
 *
 * Subclasse e não objeto próprio: o Drizzle decide se abre transação com
 * `this.client instanceof Pool`. Um cliente "parecido com Pool" passaria a rodar
 * transação na mesma conexão de outras consultas — e é exatamente o tipo de
 * quebra que não aparece em teste e aparece em produção sob carga.
 *
 * `pool.query()` do `pg` chama `this.connect(cb)` internamente, então sobrescrever
 * `connect` cobre os dois caminhos: consulta solta e transação.
 */
class PoolComContexto extends Pool {
  override connect(): Promise<PoolClient>
  override connect(
    cb: (err: Error | undefined, cliente?: PoolClient, liberar?: () => void) => void,
  ): void
  override connect(
    cb?: (err: Error | undefined, cliente?: PoolClient, liberar?: () => void) => void,
  ): Promise<PoolClient> | void {
    // Lido AQUI, de forma síncrona: estamos no contexto assíncrono de quem
    // chamou. Depois do primeiro `await` ainda estaríamos, mas ler já resolve a
    // dúvida e deixa o valor explícito no `.then` abaixo.
    const clinicaId = clinicaDoContexto()

    const promessa = super.connect().then(async (cliente) => {
      try {
        await definirContexto(cliente, clinicaId)
      } catch (e) {
        // `release(true)` DESTRÓI a conexão em vez de devolvê-la ao pool. Se o
        // `set_config` falhou, não se sabe em que estado ela está — devolvê-la
        // seria emprestar contexto indefinido para a próxima requisição. E sem
        // release nenhum, o pool secaria em silêncio.
        cliente.release(true)
        throw e
      }
      return cliente
    })

    if (!cb) return promessa
    promessa.then(
      (cliente) => cb(undefined, cliente, () => cliente.release()),
      (e) => cb(e instanceof Error ? e : new Error(String(e))),
    )
  }
}

let instancia: Pool | undefined

function poolReal(): Pool {
  if (instancia) return instancia
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL não definida. Copie .env.example para .env e preencha.')
  }
  instancia = new PoolComContexto({ connectionString: url })
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
