import { AsyncLocalStorage } from 'node:async_hooks'
import { cache } from 'react'

/**
 * O armazém do contexto de clínica, sozinho num módulo **sem importações do
 * projeto**.
 *
 * Está separado de `contexto.ts` de propósito: `lib/db/index.ts` precisa ler o
 * tenant ao pegar conexão, e `contexto.ts` precisa do `db` para o andaime
 * `clinicaAtual()`. Um importando o outro fecharia um ciclo — que em ESM às vezes
 * funciona e às vezes entrega `undefined` dependendo de quem foi importado
 * primeiro. Um módulo folha desfaz o ciclo em vez de apostar nele.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 *  Por que SÃO DOIS armazéns, e não um
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Porque um não funciona. Isto foi MEDIDO, não deduzido, e vale escrever inteiro
 * — a medição custou uma tarde e o sintoma aponta para o lugar errado.
 *
 * ── `AsyncLocalStorage`, e por que ele não basta ────────────────────────────
 * O desenho natural é `enterWith()` na leitura da sessão: o valor passa a valer
 * para a continuação daquele fluxo assíncrono, e o resto do handler o vê. Em Node
 * puro **funciona** — conferido num script de dez linhas, inclusive atravessando o
 * `await` de uma função chamada.
 *
 * E **não funciona no render de Server Component**. O React resume a continuação
 * do componente a partir da fila dele, com o contexto assíncrono capturado no
 * início do render — antes do `enterWith`. Ou seja:
 *
 *     const ator = await exigirPermissaoPagina(…)   // grava o tenant aqui
 *     const p = await acharPaciente(ator, id)       // …e aqui já está vazio
 *
 * O sintoma engana de um jeito raro: **login verde e toda página em 500** com "sem
 * contexto de clínica" — porque o login usa `run()`, que grava e lê no mesmo
 * escopo, e a página depende da propagação. Isso aponta para o banco, para a role,
 * para a política; para todo lado menos para o lugar certo.
 *
 * ── O store por requisição do React (`cache`) ──────────────────────────────
 * `cache(fn)` devolve **o mesmo objeto** durante toda uma requisição, e é o React
 * quem garante o escopo — exatamente a garantia que falta acima. Guardando ali um
 * objeto mutável, escrever no começo da requisição e ler no meio dela funciona,
 * porque não depende de propagação de contexto assíncrono nenhuma.
 *
 * A contrapartida: `cache` só vale DENTRO de requisição. Script, despachante e
 * seed não têm uma — e aí o `AsyncLocalStorage` continua sendo a resposta, com
 * `run()` explícito em volta do trabalho.
 *
 * ── Como os dois convivem ─────────────────────────────────────────────────
 * A gravação escreve nos dois. A leitura consulta **o ALS primeiro**, porque quem
 * usou `run()` foi explícito: é script, despachante ou webhook dizendo de quem é
 * este trabalho, e intenção explícita tem de vencer um valor que sobrou do render.
 */

export interface ContextoDeClinica {
  readonly clinicaId: string
}

/**
 * ── Por que via `globalThis` e não `new` direto ─────────────────────────────
 *
 * `new AsyncLocalStorage()` no topo do módulo parece obviamente certo e **não é**,
 * num app Next. O bundler pode avaliar o mesmo módulo mais de uma vez, em camadas
 * diferentes (server component, server action, route handler). Cada avaliação cria
 * um `AsyncLocalStorage` PRÓPRIO — e dois armazéns diferentes não se veem: a página
 * grava no dela, `lib/db/index.ts` lê do dele e encontra vazio.
 *
 * O sintoma disso é cruel, porque não parece bug de bundling: **toda consulta de
 * página estoura com "sem contexto de clínica"**, enquanto o login funciona (o
 * login usa `run()`, que grava e lê na mesma instância, dentro da mesma camada).
 * Foi assim que apareceu aqui — sete rotas em 500 e o login verde, o que aponta
 * para todo lado menos para o lugar certo.
 *
 * `Symbol.for` mora no registro global de símbolos do processo, então a chave é a
 * mesma em toda avaliação do módulo, e o `??=` garante uma instância só. Não é
 * gambiarra de framework: é o mesmo motivo pelo qual o cliente do banco também é
 * um singleton preguiçoso.
 */
const CHAVE = Symbol.for('facilident.armazemDeClinica')

type Global = typeof globalThis & {
  [CHAVE]?: AsyncLocalStorage<ContextoDeClinica>
}

const globalComArmazem = globalThis as Global

export const armazemDeClinica: AsyncLocalStorage<ContextoDeClinica> =
  (globalComArmazem[CHAVE] ??= new AsyncLocalStorage<ContextoDeClinica>())

/**
 * A caixa da requisição. Uma por requisição, garantida pelo React.
 *
 * Mutável de propósito: o valor é escrito depois de ela existir, quando a sessão é
 * lida. É o jeito de ter estado por requisição no App Router sem embrulhar cada
 * página numa closure.
 */
const caixaDaRequisicao = cache((): { clinicaId: string | null } => ({ clinicaId: null }))

/**
 * A caixa, ou `null` fora de requisição.
 *
 * `cache()` fora de um render do React estoura — ou, dependendo da versão, devolve
 * um objeto NOVO a cada chamada, o que é pior porque parece funcionar. O `try`
 * cobre os dois e devolve `null`, que é a resposta honesta: aqui não há
 * requisição, então quem manda é o `AsyncLocalStorage`.
 */
function caixa(): { clinicaId: string | null } | null {
  try {
    return caixaDaRequisicao()
  } catch {
    return null
  }
}

/** A clínica do contexto, ou `null` quando ainda não há sessão. */
export function clinicaDoContexto(): string | null {
  return armazemDeClinica.getStore()?.clinicaId ?? caixa()?.clinicaId ?? null
}

/**
 * Grava o tenant nos DOIS armazéns. Ver o cabeçalho deste arquivo para o porquê.
 *
 * Chamada por quem autenticou — `lib/authz/sessao.ts` e `lib/portal/sessao.ts`.
 * Não chame de outro lugar: definir o tenant sem ter verificado credencial é o
 * mesmo que não verificar credencial.
 */
export function gravarClinicaDoContexto(clinicaId: string): void {
  const c = caixa()
  if (c) c.clinicaId = clinicaId
  armazemDeClinica.enterWith({ clinicaId })
}
