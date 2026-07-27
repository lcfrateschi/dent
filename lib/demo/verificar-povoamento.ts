import { cifrarSegredo } from '@/lib/auth/mfaSegredo'
import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import { paciente, profissional, usuario } from '@/lib/db/schema'
import { clinicaParaScript } from '@/lib/demo/clinicaDaDemo'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

/**
 * Prova que **toda tela abre com dado** depois do `demo:preparar`.
 *
 *   npm run demo:verificar     (com o app rodando)
 *
 * ── Por que isto não é "abrir a tela e ver se responde 200" ─────────────────
 * Uma tela vazia responde 200. Ela renderiza, compila, passa em `tsc` e em qualquer
 * asserção de status — e não deixa ninguém avaliar nada, que é o problema que o
 * povoamento existe para resolver.
 *
 * Pior: **estado vazio produz falso verde em asserção negativa.** Na Fase 19, quatro
 * casos de IDOR passaram porque a página estava em branco: "o nome do outro paciente
 * não aparece" é verdade numa página que não mostra nada. É a décima primeira
 * ocorrência dessa forma no projeto.
 *
 * ── Como esta verificação evita o mesmo erro ────────────────────────────────
 * Cada rota é conferida por DUAS asserções que se opõem:
 *
 *   1. a marca `[DEMO]` aparece — há dado de demonstração na página;
 *   2. a frase de ESTADO VAZIO daquela tela **não** aparece.
 *
 * Uma sozinha não bastaria. `[DEMO]` pode vir do seletor de paciente no cabeçalho
 * enquanto a lista está vazia; e a ausência da frase de vazio pode significar que a
 * tela nem chegou a renderizar. As duas juntas dizem "esta tela tem conteúdo".
 *
 * ── A contraprova, que é o que dá valor ao resto ────────────────────────────
 * `--contraprova` roda as mesmas asserções contra um banco **só com `db:seed`** (sem
 * `demo:preparar`), onde elas **têm de reprovar**. Sem isso, "as telas têm dado" é uma
 * frase sobre páginas que ninguém olhou: um bug que fizesse toda asserção passar
 * passaria aqui também.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const SENHA = 'Verificacao-Povoamento-2026!'
const CONTRAPROVA = process.argv.includes('--contraprova')

let falhas = 0
let conferidas = 0

function conferir(ok: boolean, texto: string): void {
  conferidas++
  // Na contraprova o esperado é o CONTRÁRIO: reprovar é o resultado correto.
  const bom = CONTRAPROVA ? !ok : ok
  if (bom) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.log(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

function juntar(...listas: readonly string[][]): string {
  const mapa = new Map<string, string>()
  for (const lista of listas) {
    for (const bruto of lista) {
      const par = bruto.split(';')[0]!
      mapa.set(par.slice(0, par.indexOf('=')), par)
    }
  }
  return [...mapa.values()].join('; ')
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
      // Script que manda `codigo: ''` quebra no dia em que o segundo fator é ligado.
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

/**
 * As rotas do staff e a frase que cada uma mostra QUANDO ESTÁ VAZIA.
 *
 * As frases foram lidas do código de cada tela, não inventadas — se alguém reescrever o
 * estado vazio, esta verificação passa a acusar, e é o comportamento certo: ela deixa de
 * saber distinguir cheio de vazio.
 */
const ROTAS: readonly {
  readonly url: string
  readonly perfil: 'admin' | 'dentista' | 'financeiro'
  readonly vazio: string
  readonly rotulo: string
  /**
   * O que prova que há dado de demonstração NESTA tela. Padrão `[DEMO]`, que é a marca
   * de nome de pessoa e de descrição — mas nem toda tela mostra nome: a conciliação do
   * Pix exibe `txid`, e o dela começa com `DEMOPIX`. Marcador que a tela não renderiza é
   * asserção vazia, e a contraprova pega.
   */
  readonly marca?: string
}[] = [
  { url: '/relacionamento', perfil: 'admin', vazio: 'Nenhuma tarefa aberta', rotulo: 'filas de relacionamento' },
  { url: '/espera', perfil: 'admin', vazio: 'Ninguém aguardando', rotulo: 'lista de espera' },
  /**
   * "Nada fora da clínica." e não "Nenhuma ordem registrada.": a segunda só aparece com
   * o filtro `incluirFechadas` ligado, e a verificação abre a tela no estado padrão.
   * Peguei a frase pelo `grep` no arquivo e ela **existia** — só não era a que a tela
   * mostra por omissão, então a asserção passava sempre. Só a contraprova revelou.
   */
  { url: '/laboratorio', perfil: 'dentista', vazio: 'Nada fora da clínica', rotulo: 'ordens de laboratório' },
  { url: '/esterilizacao', perfil: 'admin', vazio: 'Nenhuma autoclave cadastrada', rotulo: 'ciclos de esterilização' },
  { url: '/caixa/custos', perfil: 'financeiro', vazio: 'Nenhuma despesa', rotulo: 'custos por competência' },
  { url: '/caixa/contas', perfil: 'financeiro', vazio: 'Nada a pagar', rotulo: 'contas a pagar' },
  { url: '/caixa/conciliacao', perfil: 'financeiro', vazio: 'Nenhuma liquidação', rotulo: 'conciliação do Pix', marca: 'DEMOPIX' },
]

/**
 * O fluxo de caixa é medido pelo NÚMERO, não por frase.
 *
 * A tela não tem estado vazio textual: com o banco sem movimento ela renderiza
 * "R$ 0,00" nos três cards e mais nada. Procurar frase ali seria asserção vazia — e foi:
 * "Nenhum lançamento" nunca aparece, então "não está no estado vazio" passava sempre,
 * inclusive num banco sem uma única despesa. A contraprova revelou.
 *
 * Os `data-teste` já existiam (a Fase 20 os pôs justamente para a asserção olhar o número
 * no lugar certo, em vez de procurar substring na página inteira).
 */
const VALORES_DO_CAIXA = ['entradas-liquidas', 'saidas', 'resultado-de-caixa'] as const

function valorDe(html: string, teste: string): string | null {
  const m = new RegExp(`data-teste="${teste}"[^>]*>([^<]*)<`, 's').exec(html)
  // Normaliza o espaço NÃO SEPARÁVEL que `Intl.NumberFormat` põe depois do "R$":
  // sem isto, esperado e obtido parecem idênticos no terminal e a comparação falha.
  return m?.[1] ? m[1].replace(/\u00a0/g, ' ').trim() : null
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('demo:verificar cria usuário de teste. Não roda em produção.')
  }

  console.log(
    CONTRAPROVA
      ? '\n═══ CONTRAPROVA: as telas devem estar VAZIAS (banco sem demo:preparar) ═══\n'
      : '\n═══ Toda tela abre com dado? ═══\n',
  )

  // ── Sessões: uma por perfil, porque as telas exigem recursos diferentes ────
  const sessoes: Record<string, string> = {}
  const criados: string[] = []

  for (const perfil of ['admin', 'dentista', 'financeiro'] as const) {
    const segredo = gerarSegredoTotp()
    const email = `povoamento-${perfil}-${Date.now()}@demo.local`
    const idUsuario = randomUUID()

    // Usuário e profissional na MESMA transação: a trava deferida de `drizzle/0021`
    // cobra no commit que dentista ativo tenha cadastro de profissional.
    await db.transaction(async (tx) => {
      await tx.insert(usuario).values({
        id: idUsuario,
        /**
         * **Sem a marca `[DEMO]` no nome**, e isto é resultado da contraprova.
         *
         * Com `[DEMO] Verificação admin`, o nome do usuário logado aparece no cabeçalho
         * do layout — então `html.includes('[DEMO]')` era **verdade em toda página**,
         * inclusive nas vazias. A asserção "mostra dado de demonstração" passava sem
         * nenhum dado de demonstração existir, e só a contraprova revelou.
         */
        nome: `Verificacao ${perfil}`,
        email,
        senhaHash: await gerarHashSenha(SENHA),
        perfil,
        // O id entra como dado autenticado da cifra — por isso ele é gerado antes.
        mfaSecret: cifrarSegredo(segredo, idUsuario),
        mfaAtivo: true,
      })
      if (perfil === 'dentista') {
        await tx
          .insert(profissional)
          .values({ usuarioId: idUsuario, cro: `PV${Date.now() % 100000}`, ufCro: 'SP' })
      }
    })
    criados.push(idUsuario)
    sessoes[perfil] = await entrar(email, segredo)
  }

  try {
    // ── 1. As telas de lista ─────────────────────────────────────────────────
    console.log('\x1b[36m1.\x1b[0m Telas de lista: têm dado e não estão no estado vazio')
    for (const r of ROTAS) {
      const res = await fetch(`${BASE}${r.url}`, { headers: { cookie: sessoes[r.perfil]! }, redirect: 'manual' })
      const html = res.status === 200 ? await res.text() : ''

      /**
       * O status entra na asserção, e separado: uma rota que responde 307 (sem
       * permissão) ou 500 tem HTML vazio, e aí "a frase de vazio não aparece" seria
       * verdade — o falso verde clássico. Sem este passo, um erro de permissão neste
       * script pareceria "tela cheia".
       */
      if (res.status !== 200) {
        conferir(false, `${r.rotulo}: ${r.url} respondeu ${res.status}, não 200`)
        continue
      }
      const marca = r.marca ?? '[DEMO]'
      conferir(html.includes(marca), `${r.rotulo}: mostra dado de demonstração ("${marca}")`)
      conferir(!html.includes(r.vazio), `${r.rotulo}: não está no estado vazio ("${r.vazio}")`)
    }

    // ── 1b. Fluxo de caixa: medido pelo número ───────────────────────────────
    console.log('\n\x1b[36m1b.\x1b[0m Fluxo de caixa: os valores não são todos zero')
    const resCaixa = await fetch(`${BASE}/caixa`, {
      headers: { cookie: sessoes.financeiro! },
      redirect: 'manual',
    })
    if (resCaixa.status !== 200) {
      conferir(false, `/caixa respondeu ${resCaixa.status}, não 200`)
    } else {
      const htmlCaixa = await resCaixa.text()
      for (const t of VALORES_DO_CAIXA) {
        const v = valorDe(htmlCaixa, t)
        // `null` (marcador ausente) conta como falha: marcador que desapareceu é
        // asserção que deixou de medir, e o silêncio pareceria sucesso.
        conferir(v !== null && v !== 'R$ 0,00', `fluxo de caixa: ${t} = ${v ?? '(marcador ausente)'}`)
      }
    }

    // ── 2. Periograma: é por paciente, então precisa do id ───────────────────
    console.log('\n\x1b[36m2.\x1b[0m Periograma (rota por paciente)')
    const [pacComExame] = await db
      .select({ id: paciente.id })
      .from(paciente)
      .where(sql`${paciente.clinicaId} = app_clinica_id() and ${paciente.nome} like '[DEMO]%'`)
      .orderBy(sql`${paciente.nome}`)
      .limit(1)

    if (!pacComExame) {
      conferir(false, 'periograma: nenhum paciente [DEMO] no banco')
    } else {
      const res = await fetch(`${BASE}/periograma/${pacComExame.id}`, {
        headers: { cookie: sessoes.dentista! },
        redirect: 'manual',
      })
      const html = res.status === 200 ? await res.text() : ''
      if (res.status !== 200) {
        conferir(false, `periograma respondeu ${res.status}, não 200`)
      } else {
        conferir(!html.includes('Nenhum exame registrado'), 'periograma: há exame registrado')
      }
    }

    // ── 3. Portal do paciente ────────────────────────────────────────────────
    /**
     * O portal usa realm de autenticação separado — cookie diferente, token opaco no
     * banco, tipo incompatível. Entrar aqui exigiria montar sessão de paciente, e este
     * script não faz isso: `portal:seguranca` já cobre o portal com 47 casos, incluindo
     * as rotas de anamnese e termos.
     *
     * Dito em voz alta porque a ausência pareceria esquecimento: **as três rotas do
     * portal (`/meu/agendar`, `/meu/anamnese`, `/meu/termos`) não são verificadas aqui.**
     */
    console.log('\n\x1b[36m3.\x1b[0m Portal do paciente')
    console.log('   \x1b[33m⊘\x1b[0m não coberto aqui — realm separado; ver npm run portal:seguranca')
  } finally {
    // ── Limpeza: os usuários de verificação saem ─────────────────────────────
    const c = await pool.connect()
    try {
      await c.query('begin')
      const desligadas = await desligarTriggersDeAplicacao(c)
      for (const id of criados) {
        await c.query('delete from audit_log where ator_id = $1', [id])
        await c.query('delete from profissional where usuario_id = $1', [id])
        await c.query('delete from usuario where id = $1', [id])
      }
      // ANTES do commit: `disable trigger` é DDL, e comitar desligado deixaria o
      // prontuário editável para sempre, em silêncio.
      await religarTriggersDeAplicacao(c, desligadas)
      await c.query('commit')
    } catch (e) {
      await c.query('rollback')
      console.error('   ⚠ falha ao limpar os usuários de verificação:', e)
    } finally {
      c.release()
    }
  }
}

clinicaParaScript()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    if (CONTRAPROVA) {
      console.log(
        falhas === 0
          ? `\n\x1b[32m═══ Contraprova OK: as ${conferidas} asserções reprovaram, como deviam ═══\x1b[0m\n`
          : `\n\x1b[31m✗ ${falhas} de ${conferidas} asserções PASSARAM num banco sem demo:preparar — elas não medem povoamento.\x1b[0m\n`,
      )
    } else {
      console.log(
        falhas === 0
          ? `\n\x1b[32m═══ ${conferidas} asserções: toda tela abre com dado ═══\x1b[0m\n`
          : `\n\x1b[31m${falhas} de ${conferidas} falharam.\x1b[0m\n`,
      )
    }
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
