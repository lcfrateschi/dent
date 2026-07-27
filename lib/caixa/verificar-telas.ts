import { cifrarSegredo } from '@/lib/auth/mfaSegredo'
import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import { categoriaDespesa, despesa, pagamentoDespesa, profissional, usuario } from '@/lib/db/schema'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import { clinicaParaScript } from '@/lib/demo/clinicaDaDemo'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { randomUUID } from 'node:crypto'

/**
 * Verificação das TELAS do caixa, por HTTP e com sessão de verdade.
 *
 *   npm run caixa:telas    (com o app rodando)
 *
 * ── O que esta verificação existe para pegar ────────────────────────────────
 * `tsc` prova que a página compila; `caixa:demo` prova o domínio e o banco. Entre os
 * dois cabe a classe de erro que este módulo mais teme: **a tela que mostra o número do
 * regime errado.** Uma página de "quanto o mês custou" que somasse pela data do
 * pagamento renderiza, compila, passa em todo teste de unidade — e faz a contadora
 * recusar o relatório.
 *
 * Por isso o caso central é um só, montado com número calculado à mão:
 *
 *   aluguel de R$ 3.200,00 — competência JULHO, pago em AGOSTO
 *   prótese de R$   850,00 — competência JULHO, paga em JULHO
 *
 *   "quanto custou julho"          → 4.050,00   (as duas, pela competência)
 *   "entrou e saiu em julho"       →   850,00   (só a paga em julho)
 *   "entrou e saiu em agosto"      → 3.200,00   (só o aluguel)
 *
 * Se as duas primeiras telas mostrarem o mesmo número, uma delas está errada — e é isso
 * que a asserção cobra. Uma verificação que só olhasse "a tela abriu" passaria com as
 * duas somando pelo mesmo campo.
 *
 * ── Contraprova de tela vazia ───────────────────────────────────────────────
 * A forma mais comum de falso verde em tela é a **página em branco**: com a lista vazia,
 * "o valor errado não aparece" é verdade porque nada aparece. Quatro casos de IDOR
 * passaram assim na Fase 19. Então toda asserção negativa daqui tem um `deveAparecer` ao
 * lado, e há um passo que **prova que o par funciona** — ele confere que o valor plantado
 * aparece na tela do mês certo antes de afirmar que não aparece na do mês errado.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const SENHA = 'Verificacao-Caixa-2026!'
const MARCA = `CX-${Date.now()}`

// Datas fixas num ano futuro: assim as asserções não competem com dado real da clínica,
// e o mês de "agosto" nunca coincide com o mês corrente por acidente.
const ANO = new Date().getUTCFullYear() + 2
const JULHO_1 = `${ANO}-07-01`
const JULHO_31 = `${ANO}-07-31`
const AGOSTO_1 = `${ANO}-08-01`
const AGOSTO_31 = `${ANO}-08-31`

let falhas = 0

/**
 * Lê o valor de um `data-teste`, para a asserção olhar o número NO LUGAR CERTO.
 *
 * A primeira versão desta verificação procurava a string solta no HTML — e passou com a
 * tela sabotada para somar pela competência: ela achou "850,00" no card de *resultado*
 * (−850,00) e concluiu que o de *saídas* estava correto. Procurar substring numa página
 * inteira responde "este número aparece em algum lugar", que não é a pergunta.
 */
function valorDe(html: string, teste: string): string | null {
  const m = new RegExp(`data-teste="${teste}"[^>]*>([^<]*)<`, 's').exec(html)
  if (!m?.[1]) return null
  /**
   * Normaliza o espaço ANTES de comparar.
   *
   * `Intl.NumberFormat('pt-BR', { style: 'currency' })` separa o símbolo do valor com
   * **espaço não separável** (U+00A0), não com espaço comum — então `'R$ 850,00'`
   * escrito à mão nunca é igual ao que a tela produz, e a asserção reprova mostrando
   * `obtido R$ 850,00`, idêntico ao esperado. Perdi uma execução nisso.
   */
  return m[1].replace(/\u00a0|&nbsp;/g, ' ').trim()
}

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

/** Dedupe por nome mantendo o último — `/api/auth/csrf` manda o cookie duas vezes. */
function juntar(...listas: readonly string[][]): string {
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
      // O código vai SEMPRE, mesmo com `MFA_DESABILITADO=true` (onde é ignorado).
      // Script que manda `codigo: ''` quebra no dia em que o segundo fator é ligado — e
      // aconteceu com o `tenant:seguranca`, que passou a acusar "0/6 rotas abrem".
      codigo: gerarCodigoTotp(segredo),
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })
  if (r2.status >= 400 || r2.headers.get('location')?.includes('error=')) {
    throw new Error(`login falhou: ${r2.status} ${r2.headers.get('location') ?? ''}`)
  }
  return juntar(c1.split('; '), r2.headers.getSetCookie())
}

interface Criados {
  readonly financeiroId: string
  readonly dentistaId: string
  readonly categoriaId: string
  readonly aluguelId: string
  readonly proteseId: string
}

async function main(): Promise<void> {
  console.log('\n═══ Telas do caixa, por HTTP e com sessão ═══\n')

  const segredoFin = gerarSegredoTotp()
  const segredoDent = gerarSegredoTotp()
  const emailFin = `caixa-fin-${Date.now()}@local`
  const emailDent = `caixa-dent-${Date.now()}@local`

  // Ids gerados antes do INSERT: `cifrarSegredo` amarra o texto cifrado ao `usuario.id`
  // (é o dado autenticado adicional que impede copiar o próprio segredo cifrado para a
  // linha de outra pessoa), e o id só existiria depois de inserir.
  const idFin = randomUUID()
  const idDent = randomUUID()

  /**
   * Usuário e `profissional` na MESMA transação.
   *
   * A trava deferida de `drizzle/0021` cobra **no commit** que dentista ativo tenha
   * cadastro de profissional. Dois inserts soltos comitam separado e o primeiro já
   * viola — a mensagem é `Usuário … tem perfil dentista e nenhum cadastro de
   * profissional`, e ela chega no `commit`, não no `insert`, o que faz o rastro apontar
   * para o lugar errado. É a lição registrada no `CLAUDE.md`, e eu a redescobri aqui.
   */
  const criados = await db.transaction(async (tx) => {
    await tx.insert(usuario).values({
      id: idFin,
      nome: `${MARCA} Financeiro`,
      email: emailFin,
      senhaHash: await gerarHashSenha(SENHA),
      perfil: 'financeiro',
      mfaSecret: cifrarSegredo(segredoFin, idFin),
      mfaAtivo: true,
    })
    await tx.insert(usuario).values({
      id: idDent,
      nome: `${MARCA} Dentista sem caixa`,
      email: emailDent,
      senhaHash: await gerarHashSenha(SENHA),
      perfil: 'dentista',
      mfaSecret: cifrarSegredo(segredoDent, idDent),
      mfaAtivo: true,
    })
    await tx
      .insert(profissional)
      .values({ usuarioId: idDent, cro: `CX${Date.now() % 100000}`, ufCro: 'SP' })
    return { idFin, idDent }
  })

  const [cat] = await db
    .insert(categoriaDespesa)
    .values({ nome: `${MARCA} Ocupação`, natureza: 'fixa' })
    .returning({ id: categoriaDespesa.id })
  const categoriaId = cat!.id

  // ── O caso que separa os dois regimes ──────────────────────────────────────
  const [aluguel] = await db
    .insert(despesa)
    .values({
      categoriaId,
      descricao: `${MARCA} Aluguel de julho`,
      valor: '3200.00',
      competencia: JULHO_1,
      vencimento: `${ANO}-08-05`,
    })
    .returning({ id: despesa.id })

  const [protese] = await db
    .insert(despesa)
    .values({
      categoriaId,
      descricao: `${MARCA} Laboratorio de protese`,
      valor: '850.00',
      competencia: JULHO_1,
      vencimento: `${ANO}-07-20`,
    })
    .returning({ id: despesa.id })

  // Aluguel PAGO EM AGOSTO; prótese paga em julho.
  await db.insert(pagamentoDespesa).values({
    despesaId: aluguel!.id,
    valor: '3200.00',
    pagoEm: `${ANO}-08-05`,
    meio: 'transferencia',
  })
  await db.insert(pagamentoDespesa).values({
    despesaId: protese!.id,
    valor: '850.00',
    pagoEm: `${ANO}-07-18`,
    meio: 'pix',
  })

  const tudo: Criados = {
    financeiroId: criados.idFin,
    dentistaId: criados.idDent,
    categoriaId,
    aluguelId: aluguel!.id,
    proteseId: protese!.id,
  }

  try {
    const cookie = await entrar(emailFin, segredoFin)
    conferir(cookie.includes('session-token'), 'sessão de financeiro aberta')

    // ── 1. Custo por competência: julho custou 4.050 ─────────────────────────
    console.log('\n\x1b[36m1.\x1b[0m Competência — "quanto o mês custou"')
    const custos = await fetch(`${BASE}/caixa/custos?de=${JULHO_1}&ate=${JULHO_31}`, {
      headers: { cookie },
    })
    const htmlCustos = await custos.text()
    conferir(custos.status === 200, `/caixa/custos respondeu ${custos.status}`)
    // `deveAparecer`: sem esta asserção, as negativas abaixo passariam numa página vazia.
    conferir(
      htmlCustos.includes(`${MARCA} Ocupação`),
      'a categoria plantada aparece — a tela NÃO está vazia (contraprova das negativas)',
    )
    conferir(
      htmlCustos.includes('4.050,00'),
      'julho custou 4.050,00: as duas despesas, pela competência',
    )
    conferir(
      htmlCustos.includes('Regime de competência'),
      'a tela declara o regime que usa, em texto',
    )
    conferir(
      htmlCustos.includes('quanto a clínica consumiu'),
      'e declara a pergunta que responde',
    )

    // ── 2. Fluxo de caixa de julho: só 850 ───────────────────────────────────
    console.log('\n\x1b[36m2.\x1b[0m Caixa de julho — "entrou e saiu do banco"')
    const caixaJulho = await fetch(`${BASE}/caixa?de=${JULHO_1}&ate=${JULHO_31}`, {
      headers: { cookie },
    })
    const htmlJulho = await caixaJulho.text()
    conferir(caixaJulho.status === 200, `/caixa respondeu ${caixaJulho.status}`)
    const saidasJulho = valorDe(htmlJulho, 'saidas')
    conferir(
      saidasJulho === 'R$ 850,00',
      `as SAÍDAS de julho são a prótese paga em julho — R$ 850,00 (obtido ${saidasJulho ?? 'nada'})`,
    )
    /**
     * **A asserção central**, e ela é sobre o número exato no lugar exato.
     *
     * R$ 4.050,00 é o total por COMPETÊNCIA de julho. Se ele aparecer no card de saídas
     * do fluxo de caixa, a tela está somando pelo regime errado — o erro clássico deste
     * módulo, que compila, renderiza e passa em todo teste de unidade.
     *
     * Provado por sabotagem: trocando `fluxoDeCaixaDoPeriodo` por
     * `despesasPorCompetencia` na tela, esta asserção reprova com
     * `obtido R$ 4.050,00`. A versão anterior — `!html.includes('3.200,00')` — **passava**
     * com a tela sabotada, porque o total errado renderiza como 4.050,00 e a string
     * procurada nunca aparecia.
     */
    conferir(
      saidasJulho !== 'R$ 4.050,00',
      'e NÃO são o total por competência (R$ 4.050,00) — se fossem, a tela somaria pelo regime errado',
    )
    conferir(htmlJulho.includes('Regime de caixa'), 'a tela declara o regime de caixa')

    // ── 3. Fluxo de caixa de agosto: o aluguel ───────────────────────────────
    console.log('\n\x1b[36m3.\x1b[0m Caixa de agosto — o aluguel aparece aqui')
    const caixaAgosto = await fetch(`${BASE}/caixa?de=${AGOSTO_1}&ate=${AGOSTO_31}`, {
      headers: { cookie },
    })
    const htmlAgosto = await caixaAgosto.text()
    const saidasAgosto = valorDe(htmlAgosto, 'saidas')
    conferir(
      saidasAgosto === 'R$ 3.200,00',
      `as saídas de AGOSTO são o aluguel de julho pago em agosto — R$ 3.200,00 (obtido ${
        saidasAgosto ?? 'nada'
      })`,
    )
    conferir(
      saidasAgosto !== 'R$ 4.050,00' && saidasAgosto !== 'R$ 850,00',
      'e não são nem o total por competência nem a prótese — cada regime tem o seu mês',
    )
    conferir(
      htmlAgosto.includes('Base da comissão em uso'),
      'a base da comissão fica visível — a escolha muda a folha e não deve ser descoberta por diferença',
    )

    // ── 4. Contas a pagar: as duas estão pagas, então a fila fica sem elas ──
    console.log('\n\x1b[36m4.\x1b[0m Contas a pagar — "o que ainda devo"')
    const contas = await fetch(`${BASE}/caixa/contas`, { headers: { cookie } })
    const htmlContas = await contas.text()
    conferir(contas.status === 200, `/caixa/contas respondeu ${contas.status}`)
    conferir(
      !htmlContas.includes(`${MARCA} Aluguel de julho`),
      'conta paga por inteiro sai da fila de contas a pagar',
    )
    const todas = await fetch(`${BASE}/caixa/contas?pagas=1`, { headers: { cookie } })
    const htmlTodas = await todas.text()
    conferir(
      htmlTodas.includes(`${MARCA} Aluguel de julho`),
      'e reaparece em "ver todas" — a contraprova de que a filtragem é o filtro, não ausência de dado',
    )
    conferir(
      htmlTodas.includes('Lançar despesa'),
      'financeiro vê o controle de lançamento',
    )
    /**
     * O formulário é conferido por `?lancar=1`, que o abre já no HTML servido.
     *
     * A primeira versão desta asserção olhava `/caixa/contas?pagas=1` e reprovava — o
     * formulário está atrás do botão "Lançar despesa" e não existe na marcação inicial.
     * A asserção estava errada, não a tela.
     *
     * O conserto **não** foi afrouxar a asserção nem abrir o formulário por padrão: foi
     * torná-lo linkável. A propriedade que interessa é real e vale cobrar — os dois
     * campos de data existem SEPARADOS, e é essa separação que impede alguém de escolher
     * entre "quanto custou julho" e "quando eu pago" sem saber que está escolhendo.
     */
    const comForm = await fetch(`${BASE}/caixa/contas?lancar=1`, { headers: { cookie } })
    const htmlForm = await comForm.text()
    conferir(
      htmlForm.includes('o mês a que a despesa pertence'),
      'o formulário pede COMPETÊNCIA, com a explicação do que ela decide',
    )
    conferir(
      htmlForm.includes('manda na fila de contas a pagar'),
      'e pede VENCIMENTO como campo separado — quem preenche não escolhe entre os dois sem saber',
    )
    // Contraprova do par: sem `?lancar=1` os dois textos não estão lá, então as duas
    // asserções acima medem o formulário, e não texto solto da página.
    conferir(
      !htmlTodas.includes('o mês a que a despesa pertence'),
      'e sem ?lancar=1 o formulário não vem no HTML — as duas asserções acima olham o formulário mesmo',
    )

    // ── 5. Conciliação ───────────────────────────────────────────────────────
    console.log('\n\x1b[36m5.\x1b[0m Conciliação do Pix')
    const conc = await fetch(`${BASE}/caixa/conciliacao`, { headers: { cookie } })
    const htmlConc = await conc.text()
    conferir(conc.status === 200, `/caixa/conciliacao respondeu ${conc.status}`)
    conferir(
      htmlConc.includes('Provedor Pix simulado'),
      'avisa que o provedor é simulado — sem isso alguém conclui que o Pix está no ar',
    )
    conferir(
      htmlConc.includes('sem dono'),
      'a lista de liquidações sem destino existe e é a primeira da tela',
    )

    // ── 6. Perfil sem permissão ──────────────────────────────────────────────
    console.log('\n\x1b[36m6.\x1b[0m RBAC — dentista não vê o caixa')
    const cookieDent = await entrar(emailDent, segredoDent)
    for (const rota of ['/caixa', '/caixa/custos', '/caixa/contas', '/caixa/conciliacao']) {
      const r = await fetch(`${BASE}${rota}`, { headers: { cookie: cookieDent }, redirect: 'manual' })
      const destino = r.headers.get('location') ?? ''
      conferir(
        destino.includes('/sem-permissao'),
        `${rota} manda o dentista para /sem-permissao (obtido ${r.status} ${destino || 'sem redirect'})`,
      )
    }

    // ── 7. Sem sessão ────────────────────────────────────────────────────────
    console.log('\n\x1b[36m7.\x1b[0m Sem sessão')
    const semSessao = await fetch(`${BASE}/caixa`, { redirect: 'manual' })
    conferir(
      semSessao.status === 307 || semSessao.status === 302,
      `sem sessão redireciona para o login (${semSessao.status})`,
    )
  } finally {
    await limpar(tudo)
  }
}

async function limpar(c: Criados): Promise<void> {
  const conexao = await pool.connect()
  try {
    await conexao.query('begin')
    // Só as triggers de APLICAÇÃO. `session_replication_role` desligaria também as de
    // FK, e já deixou 5 linhas órfãs neste projeto — o que derrubou uma migration meses
    // depois. Ver lib/demo/triggers.ts.
    const desligadas = await desligarTriggersDeAplicacao(conexao)
    await conexao.query('delete from pagamento_despesa where despesa_id = any($1::uuid[])', [
      [c.aluguelId, c.proteseId],
    ])
    await conexao.query('delete from despesa where id = any($1::uuid[])', [
      [c.aluguelId, c.proteseId],
    ])
    await conexao.query('delete from categoria_despesa where id = $1', [c.categoriaId])
    await conexao.query('delete from audit_log where ator_id = any($1::uuid[])', [
      [c.financeiroId, c.dentistaId],
    ])
    await conexao.query('delete from profissional where usuario_id = $1', [c.dentistaId])
    await conexao.query('delete from usuario where id = any($1::uuid[])', [
      [c.financeiroId, c.dentistaId],
    ])
    // ANTES do commit: `disable trigger` é DDL, e comitar desligado deixaria o
    // prontuário editável para sempre, em silêncio.
    await religarTriggersDeAplicacao(conexao, desligadas)
    await conexao.query('commit')
    console.log('\nDados da verificação removidos.')
  } catch (e) {
    await conexao.query('rollback')
    console.error('Falha ao limpar:', e)
    falhas++
  } finally {
    conexao.release()
  }
}

clinicaParaScript()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32m═══ Telas do caixa conferidas ═══\x1b[0m\n'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m\n`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
