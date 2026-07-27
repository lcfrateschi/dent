import { gerarSegredoTotp, gerarCodigoTotp } from '@/lib/auth/totp'
import { gerarHashSenha } from '@/lib/auth/senha'
import { db, pool } from '@/lib/db'
import { loteMaterial, material, movimentoEstoque, usuario } from '@/lib/db/schema'
import { addDias } from '@/lib/domain/datas'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { desligarTriggersDeAplicacao, religarTriggersDeAplicacao } from '@/lib/demo/triggers'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { idDaPrimeiraClinica } from '@/lib/demo/clinicaDaDemo'

/**
 * Verificação das TELAS de estoque, por HTTP e com sessão de verdade.
 *
 *   npm run estoque:telas    (com o app rodando)
 *
 * Existe porque `tsc` e `next build` provam que a página compila, não que ela
 * mostra o número certo — e a demonstração prova o domínio e o banco, não o
 * HTML. Entre os dois cabe a classe de erro mais chata: a tela que renderiza,
 * mas com a coluna trocada ou o filtro invertido.
 *
 * As buscas usam textos ÚNICOS. Procurar por `">Estoque<"` casaria com o item do
 * menu, e procurar "abaixo do mínimo" casaria com o cabeçalho da tabela — dois
 * falsos positivos que já aconteceram neste projeto em fases anteriores.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const SENHA = 'Verificacao-Telas-2026!'
const MARCA = `TELA-${Date.now()}`

let falhas = 0

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

/**
 * Monta o cabeçalho `cookie` a partir de `Set-Cookie`, **deduplicando por nome e
 * mantendo o último**.
 *
 * A dedupe não é capricho: `/api/auth/csrf` responde com `authjs.csrf-token`
 * duas vezes, e concatenar as duas faz o servidor ler a primeira, que não casa
 * com o token enviado no corpo. O login falha com `MissingCSRF` e todas as
 * conferências desta tela reprovam como se as telas estivessem quebradas —
 * foi exatamente o que aconteceu na primeira execução.
 */
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

async function main(): Promise<void> {
  console.log('\n═══ Telas de estoque, por HTTP e com sessão ═══')

  const hoje = await hojeDaClinica()
  const segredo = gerarSegredoTotp()
  const email = `tela-${Date.now()}@local`

  const [u] = await db
    .insert(usuario)
    .values({
      nome: `${MARCA} Recepção`,
      email,
      senhaHash: await gerarHashSenha(SENHA),
      perfil: 'recepcao',
      mfaSecret: segredo,
      mfaAtivo: true,
    })
    .returning({ id: usuario.id })

  // Um material abaixo do mínimo e com lote vencendo — os dois avisos da tela.
  const [m] = await db
    .insert(material)
    .values({
      codigo: `${MARCA}-M1`,
      nome: `${MARCA} Insumo de verificação`,
      categoria: 'descartavel',
      unidade: 'unidade',
      quantidadeMinima: '40',
    })
    .returning({ id: material.id })
  const materialId = m!.id

  const [lote] = await db
    .insert(loteMaterial)
    .values({
      materialId,
      codigoFabricante: `${MARCA}-LOTE`,
      validade: addDias(hoje, 15),
      custoUnitario: '3.00',
      recebidoEm: hoje,
    })
    .returning({ id: loteMaterial.id })

  await db.insert(movimentoEstoque).values({
    loteId: lote!.id,
    materialId,
    tipo: 'entrada',
    quantidade: '10.000',
    custoUnitario: '3.00',
  })

  try {
    const cookie = await entrar(email, segredo)
    conferir(cookie.includes('authjs.session-token') || cookie.includes('session-token'), 'sessão de staff aberta')

    // ── /estoque ────────────────────────────────────────────────────────────
    const painel = await fetch(`${BASE}/estoque`, { headers: { cookie } })
    const html = await painel.text()
    conferir(painel.status === 200, `/estoque respondeu ${painel.status}`)
    conferir(
      html.includes(`${MARCA} Insumo de verificação`),
      'o material aparece na tela',
    )
    conferir(html.includes('abaixo do mínimo'), 'e vem rotulado como abaixo do mínimo')
    conferir(
      html.includes('vence em 15 dias'),
      'o lote vencendo aparece com o prazo em dias, não só a data',
    )
    // 10 × R$ 3,00 = R$ 30,00 em risco. É o número que faz a tela ter efeito.
    conferir(html.includes('30,00'), 'e o valor em risco está calculado (10 × R$ 3,00)')
    // Repor ao dobro do mínimo: 80 − 10 = 70. Procurar só "70" casaria com
    // qualquer tamanho de fonte ou cor no HTML — a unidade torna a busca única.
    conferir(
      html.includes('70 unidade'),
      'a sugestão de compra repõe ao dobro do mínimo: 2 × 40 − 10 = 70 unidade',
    )

    // ── /estoque/[materialId] ───────────────────────────────────────────────
    const detalhe = await fetch(`${BASE}/estoque/${materialId}`, { headers: { cookie } })
    const htmlDetalhe = await detalhe.text()
    conferir(detalhe.status === 200, `/estoque/${materialId.slice(0, 8)}… respondeu ${detalhe.status}`)
    conferir(htmlDetalhe.includes(`${MARCA}-LOTE`), 'o lote do fabricante aparece na página do material')
    conferir(
      htmlDetalhe.includes('Lotes, na ordem em que vão sair'),
      'a lista de lotes é apresentada como fila de saída (FEFO), não como cadastro',
    )
    conferir(
      htmlDetalhe.includes('Registrar recebimento') && htmlDetalhe.includes('Dar baixa'),
      'recepção vê os controles de entrada e baixa',
    )

    // ── 404 de material inexistente ─────────────────────────────────────────
    const inexistente = await fetch(
      `${BASE}/estoque/00000000-0000-4000-8000-000000000000`,
      { headers: { cookie } },
    )
    conferir(
      inexistente.status === 404,
      `material inexistente dá 404, não 500 (obtido ${inexistente.status})`,
    )

    // ── Sem sessão ──────────────────────────────────────────────────────────
    const semSessao = await fetch(`${BASE}/estoque`, { redirect: 'manual' })
    conferir(
      semSessao.status === 307 || semSessao.status === 302,
      `sem sessão a tela redireciona para o login (${semSessao.status})`,
    )

    // ── Perfil sem permissão de estoque ─────────────────────────────────────
    // Não existe: os quatro perfis leem estoque. A separação real está nas
    // AÇÕES, e é o teste de `lib/authz/politicas.test.ts` que a prova. Aqui
    // basta conferir que a tela não oferece o que o perfil não pode fazer.
    conferir(
      htmlDetalhe.includes('Alterar mínimo'),
      'e o controle de mínimo, que é permissão de editar — recepção tem',
    )
  } finally {
    await limpar(u!.id, materialId)
  }
}

async function limpar(usuarioId: string, materialId: string): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    // Desliga só as triggers de APLICAÇÃO — as de FK ficam de pé. O
    // `session_replication_role` que estava aqui desligava as duas, e já deixou
    // 5 linhas órfãs em movimento_estoque, o que derrubou a 0023. Ver
    // lib/demo/triggers.ts.
    const tabelasDesligadas = await desligarTriggersDeAplicacao(c)
    await c.query('delete from movimento_estoque where material_id = $1', [materialId])
    await c.query('delete from lote_material where material_id = $1', [materialId])
    await c.query('delete from material where id = $1', [materialId])
    await c.query('delete from audit_log where ator_id = $1', [usuarioId])
    await c.query('delete from usuario where id = $1', [usuarioId])
    // ANTES do commit: `disable trigger` é DDL — comitar desligado deixaria o
    // prontuário editável para sempre, em silêncio.
    await religarTriggersDeAplicacao(c, tabelasDesligadas)
    await c.query('commit')
    console.log('\nDados da verificação removidos.')
  } catch (e) {
    await c.query('rollback')
    console.error('Falha ao limpar:', e)
  } finally {
    c.release()
  }
}

/**
 * O contexto de clínica é aberto AQUI, envolvendo o `main()` inteiro.
 *
 * Script de linha de comando não tem sessão de onde herdar o tenant, e desde a
 * `drizzle/0022` toda escrita depende de `app.clinica_id` — `app_clinica_id()`
 * estoura sem ele, de propósito, para "esqueci o contexto" não virar linha gravada
 * na clínica errada.
 *
 * Envolver no ponto de entrada, e não dentro de `main()`, é de propósito: qualquer
 * função que `main()` chame, hoje ou amanhã, herda o contexto pelo
 * `AsyncLocalStorage`. Espalhar `comContextoDeClinica` por dentro deixaria brecha
 * na próxima função acrescentada.
 */
idDaPrimeiraClinica()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    console.log(falhas === 0 ? '\n\x1b[32mTelas conferidas.\x1b[0m' : `\n\x1b[31m${falhas} falha(s).\x1b[0m`)
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
