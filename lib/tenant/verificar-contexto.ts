import { db, pool } from '@/lib/db'
import { cadeira, clinica } from '@/lib/db/schema'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { eq } from 'drizzle-orm'
import { Client } from 'pg'

/**
 * CNPJ único por execução, só para fixture.
 *
 * Não passa por `cnpjEhValido` (dígito verificador) porque o banco não valida
 * dígito — quem valida é `lib/domain/cnpj.ts`, na borda. O que o banco cobra é
 * unicidade, e é isso que precisa variar entre execuções.
 */
function cnpjSintetico(n: number): string {
  return String(Date.now()).slice(-12).padStart(12, '0') + String(n).padStart(2, '0')
}

/**
 * Prova o contexto de clínica contra um Postgres real.
 *
 * ── Por que este script existe ──────────────────────────────────────────────
 * O mecanismo do tenant é invisível: nenhuma chamada `db.insert(…)` menciona
 * `clinica_id`, e o valor certo aparece por causa de `DEFAULT app_clinica_id()`
 * mais o `set_config` que `lib/db/index.ts` faz ao pegar conexão. Mecanismo
 * invisível que funciona e mecanismo invisível que está quebrado têm a mesma
 * aparência — até o dia em que dois clientes veem o dado um do outro.
 *
 * O caso 3 é o que justifica o script inteiro: ele reprova a versão ANTERIOR
 * desta implementação, que definia o contexto em `pool.on('connect')`. Aquele
 * gancho roda em conexão nova, não em conexão reaproveitada; com o pool limitado a
 * UMA conexão, a segunda clínica escrevia com o contexto da primeira. Um teste que
 * não force o reaproveitamento passa igual nos dois desenhos, e por isso não prova
 * nada.
 *
 *   DATABASE_URL=postgres://…/sessao_teste npx tsx lib/tenant/verificar-contexto.ts
 */

// ── Guarda ────────────────────────────────────────────────────────────────────
// Este script cria uma SEGUNDA clínica, e é justamente isso que o andaime de
// `lib/db/index.ts` trata como motivo para o app parar. Rodá-lo no banco de
// desenvolvimento derrubaria o login de quem estiver usando o sistema.
const url = process.env.DATABASE_URL ?? ''
const banco = url.split('/').pop()?.split('?')[0] ?? ''
if (!banco || banco === 'facilident') {
  console.error(
    `Recusado: DATABASE_URL aponta para "${banco || '(vazio)'}".\n` +
      'Este script cria duas clínicas e deixa dado de teste atrás.\n' +
      'Use um banco descartável:\n' +
      "  docker compose exec -T db psql -U facilident -d postgres -c 'CREATE DATABASE sessao_teste'",
  )
  process.exit(1)
}

let falhas = 0
function ok(desc: string, condicao: boolean, detalhe = ''): void {
  console.log(`  ${condicao ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${desc}${detalhe ? ` — ${detalhe}` : ''}`)
  if (!condicao) falhas++
}

async function esperaErro(desc: string, fn: () => Promise<unknown>, trecho: string): Promise<void> {
  try {
    await fn()
    ok(desc, false, 'NÃO estourou, e devia')
  } catch (e) {
    const msg = mensagemDoBanco(e)
    ok(desc, msg.includes(trecho), msg.slice(0, 120))
  }
}

/**
 * O Drizzle embrulha o erro do Postgres: `e.message` é só "Failed query: …" e o
 * texto que importa está em `e.cause`. Sem andar a corrente, todo `espera_erro`
 * passaria pelo motivo errado.
 */
function mensagemDoBanco(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  while (atual instanceof Error) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  return partes.join(' | ')
}

/**
 * Zera as duas tabelas por uma conexão CRUA, fora do pool.
 *
 * Não é preguiça: o pool define contexto de clínica em toda acquisição, e com duas
 * clínicas no banco (estado em que o caso 5 termina, de propósito) o caminho sem
 * sessão **recusa a conexão**. A limpeza precisaria de contexto para poder apagar
 * justamente o que impede o contexto de existir. Reset de fixture não é operação
 * de aplicação, e é honesto que ele use outra porta.
 */
async function limpar(): Promise<void> {
  const cru = new Client({ connectionString: url })
  await cru.connect()
  try {
    await cru.query('truncate cadeira, contador, clinica cascade')
  } finally {
    await cru.end()
  }
}

async function main(): Promise<void> {
  console.log(`\n═══ Contexto de clínica — banco "${banco}" ═══\n`)

  await limpar()

  // ── 1. Sem contexto e sem clínica: estoura, e a mensagem ensina ────────────
  console.log('1. Sem clínica no banco, o DEFAULT estoura')
  await esperaErro(
    'insert sem contexto é recusado',
    () => db.insert(cadeira).values({ nome: 'Sala 1' }),
    'app.clinica_id',
  )

  // ── 2. Uma clínica: o andaime resolve, e o insert acerta ───────────────────
  /**
   * ── Este caso mudou de sentido, e a mudança é o ponto ─────────────────────
   *
   * Ele afirmava "com UMA clínica, o andaime de `lib/db/index.ts` preenche o
   * contexto": a conexão sem sessão caía na única clínica do banco. Esse andaime
   * **saiu**, por dois motivos:
   *
   *   • sob RLS, ler `clinica` já exige contexto — o andaime tentava descobrir o
   *     tenant lendo a tabela que o tenant protege, e a role de aplicação não
   *     conseguia nem abrir conexão;
   *   • adivinhar tenant é a categoria de erro que a Fase 17 existe para eliminar.
   *
   * Então a afirmação agora é a OPOSTA, e mais forte: **nem com uma clínica só a
   * escrita passa sem contexto.** Quem escreve diz de quem é o dado — a aplicação
   * pela credencial apresentada, o script por `comContextoDeClinica`.
   */
  console.log('\n2. Nem com UMA clínica o contexto é adivinhado')
  const [a] = await db
    .insert(clinica)
    // CNPJ derivado do carimbo de tempo, e NÃO o `11222333000181` do
    // `demo:preparar`: agora que `clinica_cnpj_uk` existe, um valor fixo colide em
    // qualquer banco onde a demonstração já rodou. Foi essa forma de colisão que
    // quebrou o `db:verificar`.
    .values({ razaoSocial: 'Clínica A', cnpj: cnpjSintetico(1) })
    .returning({ id: clinica.id })
  if (!a) throw new Error('não criou a clínica A')

  await esperaErro(
    'com uma clínica no banco, insert sem contexto CONTINUA recusado',
    () => db.insert(cadeira).values({ nome: 'Sala sem contexto' }),
    'app.clinica_id',
  )

  /**
   * E a contraprova: dentro do envelope, a mesma escrita passa e nasce na clínica
   * certa **sem ninguém mencionar `clinica_id`** — que é o que o `DEFAULT
   * app_clinica_id()` compra. Sem esta metade, o caso acima provaria apenas que a
   * escrita está quebrada.
   */
  await comContextoDeClinica(a.id, () => db.insert(cadeira).values({ nome: 'Sala com contexto' }))
  const [comContexto] = await comContextoDeClinica(a.id, () =>
    db
      .select({ clinicaId: cadeira.clinicaId })
      .from(cadeira)
      .where(eq(cadeira.nome, 'Sala com contexto')),
  )
  ok(
    'no envelope, a linha nasceu na clínica A sem ninguém passar clinica_id',
    comContexto?.clinicaId === a.id,
  )

  // ── 3. Duas clínicas na MESMA conexão — o caso que reprova o desenho antigo ─
  console.log('\n3. Duas clínicas, uma conexão só: o contexto não pode vazar de uma para a outra')
  const [b] = await db
    .insert(clinica)
    .values({ razaoSocial: 'Clínica B', cnpj: cnpjSintetico(2) })
    .returning({ id: clinica.id })
  if (!b) throw new Error('não criou a clínica B')

  /**
   * `max: 1` é o coração do caso. Com uma conexão só no pool, a escrita da clínica
   * B **obrigatoriamente** reaproveita a conexão que a clínica A acabou de usar. É
   * a condição em que `on('connect')` (que só roda em conexão nova) deixaria B
   * escrever com o contexto de A.
   */
  const antes = (pool as unknown as { options: { max?: number } }).options
  antes.max = 1

  await comContextoDeClinica(a.id, () => db.insert(cadeira).values({ nome: 'Sala A' }))
  await comContextoDeClinica(b.id, () => db.insert(cadeira).values({ nome: 'Sala B' }))

  /**
   * A conferência é feita **uma clínica por vez, cada uma no seu contexto**, e não
   * numa leitura só que enxerga as duas. Dois motivos:
   *   • com duas clínicas no banco, uma leitura sem contexto nem conecta (caso 5);
   *   • e depois da RLS entrar (`drizzle/0023`), a leitura da clínica A **não vai
   *     ver** a linha de B. Um teste escrito para ver as duas passaria hoje e
   *     começaria a falhar por motivo nenhum. Escrito assim, ele sobrevive à RLS.
   */
  const salaA = await comContextoDeClinica(a.id, async () => {
    const [l] = await db
      .select({ clinicaId: cadeira.clinicaId })
      .from(cadeira)
      .where(eq(cadeira.nome, 'Sala A'))
    return l
  })
  const salaB = await comContextoDeClinica(b.id, async () => {
    const [l] = await db
      .select({ clinicaId: cadeira.clinicaId })
      .from(cadeira)
      .where(eq(cadeira.nome, 'Sala B'))
    return l
  })

  ok('Sala A ficou na clínica A', salaA?.clinicaId === a.id)
  ok(
    'Sala B ficou na clínica B (e NÃO herdou o contexto de A na conexão reusada)',
    salaB?.clinicaId === b.id,
    salaB?.clinicaId === a.id ? 'VAZOU: herdou o contexto de A' : '',
  )

  // ── 4. Contraprova: a comparação do caso 3 sabe reprovar? ──────────────────
  console.log('\n4. Contraprova — a comparação do caso 3 distingue as duas clínicas')
  ok(
    'os dois ids são diferentes, então "ficou na clínica certa" quer dizer algo',
    a.id !== b.id,
    'se A e B tivessem o mesmo id, o caso 3 passaria sem provar nada',
  )
  const trocada = await comContextoDeClinica(a.id, async () => {
    await db.insert(cadeira).values({ nome: 'Sala trocada' })
    const [l] = await db
      .select({ clinicaId: cadeira.clinicaId })
      .from(cadeira)
      .where(eq(cadeira.nome, 'Sala trocada'))
    return l
  })
  ok(
    'linha escrita no contexto de A não sai com o id de B',
    trocada?.clinicaId === a.id && trocada?.clinicaId !== b.id,
  )

  /**
   * ── 5. O caminho sem sessão falha SEMPRE, não só com duas clínicas ─────────
   *
   * Este caso também mudou de sentido. Ele afirmava que, com duas clínicas, a
   * subconsulta sem `LIMIT` do andaime recusava a conexão ("more than one row
   * returned by a subquery") — uma trava que só armava quando o segundo cliente
   * existisse.
   *
   * Com o andaime fora, a garantia deixou de depender de quantas clínicas há: sem
   * contexto, `app_clinica_id()` estoura, com uma clínica ou com mil. Trocar uma
   * trava condicional por uma incondicional é a diferença entre "quebra quando
   * ficar perigoso" e "nunca funciona errado".
   */
  console.log('\n5. O caminho sem sessão falha sempre, não só quando há duas clínicas')
  await esperaErro(
    'com DUAS clínicas, insert sem contexto continua recusado — pelo mesmo motivo de sempre',
    () => db.insert(cadeira).values({ nome: 'Sala sem contexto 2' }),
    'app.clinica_id',
  )

  await limpar()

  console.log(
    falhas === 0
      ? '\n\x1b[32m═══ Contexto de clínica verificado ═══\x1b[0m\n'
      : `\n\x1b[31m═══ ${falhas} caso(s) falharam ═══\x1b[0m\n`,
  )
  if (falhas > 0) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('\nFalha:', mensagemDoBanco(e))
    process.exitCode = 1
  })
  .finally(() => pool.end())
