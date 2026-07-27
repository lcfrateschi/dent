import { clinicaDoContexto } from '@/lib/tenant/contexto'
import { Client } from 'pg'

/**
 * O CNPJ da clínica de demonstração. É a chave natural dela — ver o comentário do
 * upsert em `preparar.ts`.
 */
export const CNPJ_DA_DEMO = '11222333000181'

/**
 * Descobre o id da clínica de demonstração **sem contexto de tenant**.
 *
 * ── Por que isto precisa existir ────────────────────────────────────────────
 * Os scripts de demonstração enfrentam um problema de galinha e ovo: para o `db`
 * do projeto entregar uma conexão, ele define `app.clinica_id` em toda acquisição
 * (`lib/db/index.ts`), e sem contexto de sessão cai na subconsulta escalar
 * `(select id from clinica)`. Essa subconsulta é **sem `LIMIT` de propósito**: com
 * duas clínicas ela estoura ("more than one row returned by a subquery"), para o
 * app fechado em vez de aberto.
 *
 * O efeito colateral é que, num banco que já tem a clínica do `db:seed` mais a da
 * demonstração, `demo:preparar`, `demo:limpar` e `demo:codigo` não conseguem nem
 * LER a tabela `clinica` para descobrir com qual deveriam trabalhar. Não é bug do
 * andaime — é o que ele foi feito para fazer. Falta o caminho declarado "esta
 * operação não tem tenant", que é o caso do onboarding.
 *
 * Então esta função abre conexão própria, direta, faz UMA consulta e fecha. É
 * pouca coisa e é honesta: fica visível que este é o único ponto que escapa do
 * envelope, em vez de o escape estar espalhado por três scripts.
 *
 * ⚠️ Contorno de ferramenta de desenvolvimento, não desenho. O caminho definitivo
 * é `lib/db/index.ts` oferecer um modo sem tenant explícito; está anotado no
 * relatório da Fase 17.
 */
export async function idDaClinicaDaDemo(): Promise<string | null> {
  return await comConexaoCrua(async (conexao) => {
    for (const id of await enumerarClinicas(conexao)) {
      // Com o contexto posto, a política deixa a clínica ver a própria linha. Sem
      // ele, `app_clinica_id()` estoura — e é por isso que a enumeração vem da
      // função `SECURITY DEFINER`, e não de um `select` em `clinica`.
      await conexao.query('select set_config($1, $2, false)', ['app.clinica_id', id])
      /**
       * `id = $1` **e** contexto posto, os dois. Não é cinto e suspensório por
       * medo: é que cada um cobre um papel diferente.
       *
       * Como `facilident_app`, a política só deixa ver a clínica do contexto — o
       * `where id` seria redundante. Como DONO (que é como os scripts de
       * verificação rodam, porque a limpeza precisa de `DISABLE TRIGGER`), não há
       * política nenhuma, e sem o `where id` esta consulta responde "sim" para
       * QUALQUER id que eu ponha no contexto: ela encontraria a clínica da
       * demonstração e devolveria o id errado.
       *
       * Foi exatamente esse o bug: o laço devolvia sempre a primeira clínica, e o
       * `admin:verificar` foi rodar numa sobra de teste vazia. A sonda parecia
       * filtrar e não filtrava — o defeito desta fase inteira, dentro do código
       * escrito para consertá-la.
       */
      const r = await conexao.query('select 1 from clinica where id = $1 and cnpj = $2', [
        id,
        CNPJ_DA_DEMO,
      ])
      if (r.rowCount && r.rowCount > 0) return id
    }
    return null
  })
}

/**
 * Como `idDaClinicaDaDemo`, mas estoura se ela não existir — para quem não tem o
 * que fazer sem ela.
 */
export async function exigirClinicaDaDemo(): Promise<string> {
  const id = await idDaClinicaDaDemo()
  if (!id) {
    throw new Error(
      'A clínica de demonstração não existe neste banco. Rode `npm run demo:preparar` primeiro.',
    )
  }
  return id
}

/**
 * A primeira clínica do banco, resolvida **sem contexto de tenant**.
 *
 * É o que os scripts de demonstração usam para abrir o próprio contexto. Eles
 * criam a própria equipe e os próprios pacientes e não recebem clínica de
 * lugar nenhum — antes contavam com o andaime de `lib/db/index.ts`, que preenchia
 * `app.clinica_id` a partir da única linha de `clinica`. O andaime saiu (com razão:
 * sem contexto agora é erro, não palpite), então quem não tem sessão precisa
 * dizer de qual clínica está falando.
 *
 * `ORDER BY id` e não `LIMIT 1` solto: sem ordenação o Postgres devolve "alguma"
 * linha e o script escolhe clínica diferente entre execuções — o tipo de
 * instabilidade que ninguém reproduz.
 *
 * ⚠️ Só para ferramenta de desenvolvimento. Em produção, quem decide o tenant é a
 * credencial, nunca a ordem das linhas.
 */
/**
 * A clínica em que um script de desenvolvimento deve trabalhar.
 *
 * ── Por que isto não é mais "a primeira" ────────────────────────────────────
 * Era `select id from clinica order by id limit 1`. Funcionava porque havia uma
 * clínica só — e o dia em que passaram a existir sete (uma de verdade e seis
 * sobras de teste adversarial), a "primeira" virou uma clínica de depuração vazia.
 * O `admin:verificar` foi rodar nela e falhou dizendo que o catálogo não existe.
 *
 * É **o mesmo defeito que esta fase inteira foi corrigir**, só que dentro de um
 * script em vez de dentro de uma consulta: `limit 1` sem critério devolve "alguma",
 * e "alguma" é errado de um jeito que não parece erro.
 *
 * A ordem de escolha, e cada passo tem motivo:
 *   1. `--clinica=<uuid>` na linha de comando — explícito ganha de qualquer
 *      heurística, e é o que salva quem tem um banco com várias;
 *   2. a clínica de demonstração (pelo CNPJ) — é a documentada como ambiente de
 *      desenvolvimento, e é a que tem catálogo, pacientes e usuários;
 *   3. se existe exatamente UMA, ela;
 *   4. senão **estoura**, listando as candidatas. Fechado, não aberto: escolher
 *      sozinho aqui é como o script vai gravar dado de teste dentro do tenant
 *      errado.
 */
export async function clinicaParaScript(): Promise<string> {
  const doArgumento = process.argv
    .find((a) => a.startsWith('--clinica='))
    ?.slice('--clinica='.length)

  return await comConexaoCrua(async (conexao) => {
    const ids = await enumerarClinicas(conexao)
    if (ids.length === 0) {
      throw new Error('Nenhuma clínica neste banco. Rode `npm run db:seed` antes.')
    }

    if (doArgumento) {
      if (!ids.includes(doArgumento)) {
        throw new Error(`--clinica=${doArgumento} não existe neste banco.`)
      }
      return doArgumento
    }

    for (const id of ids) {
      await conexao.query('select set_config($1, $2, false)', ['app.clinica_id', id])
      /**
       * `id = $1` **e** contexto posto, os dois. Não é cinto e suspensório por
       * medo: é que cada um cobre um papel diferente.
       *
       * Como `facilident_app`, a política só deixa ver a clínica do contexto — o
       * `where id` seria redundante. Como DONO (que é como os scripts de
       * verificação rodam, porque a limpeza precisa de `DISABLE TRIGGER`), não há
       * política nenhuma, e sem o `where id` esta consulta responde "sim" para
       * QUALQUER id que eu ponha no contexto: ela encontraria a clínica da
       * demonstração e devolveria o id errado.
       *
       * Foi exatamente esse o bug: o laço devolvia sempre a primeira clínica, e o
       * `admin:verificar` foi rodar numa sobra de teste vazia. A sonda parecia
       * filtrar e não filtrava — o defeito desta fase inteira, dentro do código
       * escrito para consertá-la.
       */
      const r = await conexao.query('select 1 from clinica where id = $1 and cnpj = $2', [
        id,
        CNPJ_DA_DEMO,
      ])
      if (r.rowCount && r.rowCount > 0) return id
    }

    const unica = ids[0]
    if (ids.length === 1 && unica) return unica

    const rotulos: string[] = []
    for (const id of ids) {
      await conexao.query('select set_config($1, $2, false)', ['app.clinica_id', id])
      const r = await conexao.query<{ razao_social: string }>(
        'select razao_social from clinica where id = $1',
        [id],
      )
      rotulos.push(`  --clinica=${id}   ${r.rows[0]?.razao_social ?? '(sem nome)'}`)
    }
    throw new Error(
      `Este banco tem ${ids.length} clínicas e nenhuma é a de demonstração. ` +
        `Escolha uma explicitamente:\n${rotulos.join('\n')}`,
    )
  })
}

/** @deprecated Use `clinicaParaScript()` — "a primeira" não é critério. */
export const idDaPrimeiraClinica = clinicaParaScript

async function comConexaoCrua<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const conexao = new Client({ connectionString: process.env.DATABASE_URL })
  await conexao.connect()
  try {
    return await fn(conexao)
  } finally {
    await conexao.end()
  }
}

/**
 * Os ids das clínicas, sem contexto de tenant.
 *
 * `clinicas_para_processamento()` é `SECURITY DEFINER` e foi criada na
 * `drizzle/0024` para o despachante — que, como `facilident_app`, enxergaria **uma**
 * clínica e deixaria as outras sem lembrete, sem erro e sem log. Reusá-la aqui evita
 * criar uma segunda porta para o mesmo problema.
 *
 * O que isto substituiu: `select id from clinica order by id limit 1`. Aquilo
 * funcionava como dono das tabelas e **parou de funcionar** quando a aplicação
 * passou a conectar como `facilident_app`, porque a política de `clinica` chama
 * `app_clinica_id()` e ela estoura sem contexto. O erro era o galo cantando certo:
 * ler a lista de tenants não é operação de tenant.
 */
async function enumerarClinicas(conexao: Client): Promise<readonly string[]> {
  const r = await conexao.query<{ id: string }>('select clinicas_para_processamento() as id')
  return r.rows.map((x) => x.id)
}

/**
 * A clínica em que este script está rodando, exigida.
 *
 * Açúcar sobre `clinicaDoContexto()` para os scripts que precisam FILTRAR por
 * clínica explicitamente — o que ainda é necessário porque a aplicação conecta como
 * dona das tabelas, e **dono ignora política de RLS**. Uma consulta de catálogo sem
 * filtro vê todas as clínicas.
 *
 * Estoura em vez de devolver `null`: um script que perdeu o contexto tem de parar,
 * não seguir consultando sem filtro.
 */
export function clinicaDaExecucao(): string {
  const id = clinicaDoContexto()
  if (!id) {
    throw new Error(
      'Sem contexto de clínica neste script. O `main()` precisa estar envolvido em ' +
        'comContextoDeClinica() — ver o rodapé dos demonstrar.ts.',
    )
  }
  return id
}
