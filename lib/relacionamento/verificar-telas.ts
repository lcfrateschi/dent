import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { clinicaParaScript } from '@/lib/demo/clinicaDaDemo'
import { db, pool } from '@/lib/db'
import { profissional, usuario } from '@/lib/db/schema'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { eq, sql } from 'drizzle-orm'

/**
 * A tela de relacionamento, por HTTP e com sessão de verdade.
 *
 * `npm run relacionamento:telas`
 *
 * ── Por que HTTP e não só `npm test` ───────────────────────────────────────
 * Porque o que esta verificação prova não é a consulta — isso o
 * `relacionamento:demo` já faz. Prova a **camada de autorização**: que a página
 * abre para quem tem `relacionamento:ler`, que ela NÃO abre para quem não tem, e
 * que a diferença entre ver e trabalhar a fila chega até o HTML.
 *
 * Um teste unitário da matriz de permissões passaria com a página esquecendo de
 * chamar `exigirPermissaoPagina`. Só o HTTP pega isso.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const SENHA = 'Relacionamento-Telas-2026'
const MARCA = '[RELTELA]'

let falhas = 0

function conferir(ok: boolean, texto: string): void {
  if (ok) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    falhas++
    console.log(`   \x1b[31m✗ ${texto}\x1b[0m`)
  }
}

function juntar(...listas: string[][]): string {
  const porNome = new Map<string, string>()
  for (const lista of listas) {
    for (const bruto of lista) {
      const par = bruto.split(';')[0]
      if (!par || !par.includes('=')) continue
      porNome.set(par.slice(0, par.indexOf('=')), par)
    }
  }
  return [...porNome.values()].join('; ')
}

async function entrar(email: string, segredo: string): Promise<string> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntar(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email,
      senha: SENHA,
      codigo: gerarCodigoTotp(segredo),
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })
  if (r2.status >= 400 || r2.headers.get('location')?.includes('error=')) {
    throw new Error(`login falhou para ${email}: ${r2.status}`)
  }
  return juntar(c1.split('; '), r2.headers.getSetCookie())
}

/**
 * Abre a fila **sem seguir redirecionamento**.
 *
 * `fetch` segue redirect por padrão, e é isso que torna `status === 200` uma
 * asserção enganosa aqui: sessão inválida redireciona para `/entrar`, o `fetch`
 * segue, e o 200 que chega é o da **tela de login**. O caso ficaria verde provando
 * que o login responde — não que a página abriu. `redirect: 'manual'` faz 307 ser
 * 307.
 */
async function abrirFila(cookie: string): Promise<Response> {
  return await fetch(`${BASE}/relacionamento`, { headers: { cookie }, redirect: 'manual' })
}

async function criarUsuario(perfil: 'recepcao' | 'dentista' | 'financeiro'): Promise<{
  email: string
  segredo: string
}> {
  const segredo = gerarSegredoTotp()
  const email = `reltela-${perfil}-${Date.now()}@local`
  const senhaHash = await gerarHashSenha(SENHA)

  // Transação: a trava deferida da `drizzle/0021` cobra no commit que usuário
  // `dentista` ativo tenha linha em `profissional`.
  await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(usuario)
      .values({
        nome: `${MARCA} ${perfil}`,
        email,
        senhaHash,
        perfil,
        mfaSecret: segredo,
        mfaAtivo: true,
      })
      .returning({ id: usuario.id })
    if (perfil === 'dentista') {
      await tx
        .insert(profissional)
        .values({ usuarioId: u!.id, cro: `8${String(Date.now()).slice(-5)}`, ufCro: 'SP' })
    }
  })

  return { email, segredo }
}

/**
 * Uma tarefa na fila, para a verificação ter o que verificar.
 *
 * Sem ela `FilaTrabalho` devolve o texto de "nenhuma tarefa" e nenhum botão — para
 * qualquer perfil. As asserções de autorização passariam sem tocar em
 * `podeTrabalhar`: verde pelo motivo errado, o padrão que este projeto já pagou
 * sete vezes.
 *
 * A tarefa é de `inadimplencia` porque é a que precisa de menos fixture: uma
 * cobrança e uma parcela vencida. E ela usa o paciente que o `demo:preparar` já
 * criou, para não montar prontuário do zero.
 */
async function criarTarefaDeTeste(): Promise<void> {
  await db.execute(sql`
    with p as (select id from paciente order by criado_em limit 1),
         c as (
           insert into cobranca (paciente_id, valor_total, forma)
           select p.id, '100.00', 'boleto' from p returning id, paciente_id
         ),
         pa as (
           insert into parcela (cobranca_id, numero, vencimento, valor, status)
           select c.id, 1, hoje_na_clinica() - 10, '100.00', 'aberta' from c returning id
         )
    insert into tarefa_relacionamento
      (tipo, paciente_id, chave_idempotencia, parcela_id, prazo)
    select 'inadimplencia', c.paciente_id, ${`${MARCA}:`} || pa.id, pa.id, hoje_na_clinica()
      from c, pa
  `)
}

async function limparTarefaDeTeste(): Promise<void> {
  await db.execute(sql`
    delete from contato_relacionamento where tarefa_id in (
      select id from tarefa_relacionamento where chave_idempotencia like ${`${MARCA}:%`})`)
  await db.execute(sql`
    with t as (
      delete from tarefa_relacionamento
       where chave_idempotencia like ${`${MARCA}:%`}
      returning parcela_id
    ), pa as (
      delete from parcela where id in (select parcela_id from t) returning cobranca_id
    )
    delete from cobranca where id in (select cobranca_id from pa)
  `)
}

async function main(): Promise<void> {
  console.log('\n═══ Tela de relacionamento, por HTTP e com sessão ═══')

  // A fila precisa ter linha, senão as asserções de autorização não medem nada.
  await limparTarefaDeTeste()
  await criarTarefaDeTeste()

  console.log('\n\x1b[36m1. Sem sessão\x1b[0m')
  const semSessao = await fetch(`${BASE}/relacionamento`, { redirect: 'manual' })
  conferir(
    semSessao.status === 307 || semSessao.status === 302,
    `sem sessão a página redireciona (${semSessao.status}), não responde 200`,
  )

  console.log('\n\x1b[36m2. Recepção: vê a fila E pode trabalhá-la\x1b[0m')
  const recepcao = await criarUsuario('recepcao')
  const cookieRecepcao = await entrar(recepcao.email, recepcao.segredo)
  const rRec = await abrirFila(cookieRecepcao)
  const htmlRec = await rRec.text()
  conferir(rRec.status === 200, `/relacionamento responde 200 para recepção (${rRec.status})`)
  conferir(htmlRec.includes('Relacionamento'), 'a página renderizou o título')
  conferir(
    !htmlRec.includes('Seu perfil vê a fila e não a trabalha'),
    'não mostra o aviso de somente-leitura — recepção trabalha a fila',
  )
  conferir(
    htmlRec.includes('>Registrar contato</button>'),
    'e o botão de registrar contato ESTÁ lá — é o par da asserção do dentista',
  )

  console.log('\n\x1b[36m3. Dentista: vê a fila e NÃO a trabalha\x1b[0m')
  const dentista = await criarUsuario('dentista')
  const cookieDentista = await entrar(dentista.email, dentista.segredo)
  const rDen = await abrirFila(cookieDentista)
  const htmlDen = await rDen.text()
  conferir(rDen.status === 200, `/relacionamento responde 200 para dentista (${rDen.status})`)
  /**
   * Esta é a asserção que vale: a diferença entre ver e trabalhar tem de chegar ao
   * HTML. Se `podeTrabalhar` fosse ignorado na renderização, o botão de dispensar
   * apareceria para quem a matriz de permissões não autoriza — e a server action
   * recusaria depois, com um erro que o usuário leria como bug.
   */
  conferir(
    htmlDen.includes('Seu perfil vê a fila e não a trabalha'),
    'o aviso de somente-leitura aparece — `podeTrabalhar` chegou ao HTML',
  )
  /**
   * ── Por que a asserção é pelo `<button`, e não pelo texto ─────────────────
   * A primeira versão fazia `!html.includes('Registrar contato')` e **reprovou com o
   * código correto**: essa frase aparece dentro do próprio aviso de somente-leitura
   * ("Registrar contato, resolver e dispensar são da recepção…"). Substring frouxa
   * colidiu com a minha própria prosa.
   *
   * E havia um problema pior por baixo: com a fila VAZIA, `FilaTrabalho` devolve o
   * texto de "nenhuma tarefa" e botão nenhum — para qualquer perfil. A asserção
   * passaria sem exercitar `podeTrabalhar`. Por isso este script cria uma tarefa
   * antes: uma verificação de autorização sobre lista vazia não verifica nada.
   */
  conferir(
    !htmlDen.includes('>Registrar contato</button>'),
    'e o BOTÃO de registrar contato não é renderizado para ele (fila não vazia)',
  )

  console.log('\n\x1b[36m4. Financeiro: inadimplência é fila dele\x1b[0m')
  const financeiro = await criarUsuario('financeiro')
  const cookieFin = await entrar(financeiro.email, financeiro.segredo)
  const rFin = await abrirFila(cookieFin)
  conferir(rFin.status === 200, `/relacionamento responde 200 para financeiro (${rFin.status})`)
  const htmlFin = await rFin.text()
  conferir(
    !htmlFin.includes('Seu perfil vê a fila e não a trabalha'),
    'financeiro trabalha a fila — é ele quem cobra',
  )

  /**
   * Os dois deletes na MESMA transação, e nesta ordem.
   *
   * `profissional` antes por causa do FK `restrict`; e **juntos** porque a trava
   * deferida de `drizzle/0021` cobra no commit que todo usuário `dentista` ativo
   * tenha linha em `profissional`. Apagar o `profissional` e comitar deixaria um
   * dentista sem profissional por um instante — e o instante é justamente onde a
   * constraint deferida olha.
   *
   * É a mesma lição que a criação já ensinou (e que o CLAUDE.md registra), com o
   * sinal invertido. Ela morde nas duas pontas.
   */
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`delete from profissional where usuario_id in (
            select id from usuario where nome like ${`${MARCA}%`})`,
    )
    await tx.delete(usuario).where(sql`${usuario.nome} like ${`${MARCA}%`}`)
  })
  await limparTarefaDeTeste()
  console.log('\nDados da verificação removidos.')
}

clinicaParaScript()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32mTela de relacionamento conferida.\x1b[0m\n'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m\n`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('\nFalha:', e instanceof Error ? e.message : e)
    await pool.end()
    process.exit(1)
  })
