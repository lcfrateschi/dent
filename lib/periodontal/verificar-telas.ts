import { randomUUID } from 'node:crypto'
import { cifrarSegredo } from '@/lib/auth/mfaSegredo'
import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  autoclave,
  cicloEsterilizacao,
  paciente,
  periograma,
  periogramaDente,
  periogramaSitio,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { idDaPrimeiraClinica } from '@/lib/demo/clinicaDaDemo'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { registrarMedidasComAtor } from './periograma'
import { eq } from 'drizzle-orm'

/**
 * Verificação das TELAS clínicas (Fase 21), por HTTP e com sessão de verdade.
 *
 *   npm run clinico:telas    (com o app rodando)
 *
 * `tsc` e `next build` provam que a página compila; a demonstração prova o domínio e
 * o banco. Entre os dois cabe o erro mais chato: a tela que renderiza com a coluna
 * trocada, o filtro invertido — ou que **renderiza vazia**.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  A ARMADILHA QUE ESTE ARQUIVO FOI ESCRITO PARA EVITAR
 *
 *  "O dado do outro paciente não aparece" é verdade numa página em branco. Quatro
 *  casos de IDOR da Fase 19 passaram exatamente assim: o recurso estava desligado, a
 *  página mostrava só um aviso, e a asserção negativa deu verde sem medir nada.
 *
 *  Por isso **toda asserção negativa aqui tem um `deveFuncionar` ao lado**: antes de
 *  afirmar que algo não aparece, o script prova que a página de fato renderizou o
 *  conteúdo que deveria. E há um caso que exercita a contraprova ao contrário —
 *  procurando um texto que NÃO deve existir na página — para mostrar que o
 *  `deveFuncionar` reprova quando a página está vazia.
 * ══════════════════════════════════════════════════════════════════════════════
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const SENHA = 'Verificacao-Clinico-2026!'
const MARCA = `CLIN-${Date.now()}`

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
 * Dedupe por nome mantendo o último: `/api/auth/csrf` responde com
 * `authjs.csrf-token` duas vezes, e concatenar as duas faz o servidor ler a primeira,
 * que não casa com o token do corpo. O login falha com `MissingCSRF` e tudo reprova
 * como se as telas estivessem quebradas.
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
      // O código vai SEMPRE, mesmo com `MFA_DESABILITADO=true` (onde é ignorado).
      // Script que manda `codigo: ''` quebra no dia em que o segundo fator é ligado, e
      // o `tenant:seguranca` quebrou assim.
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
 * Lê um atributo da tag que carrega um `data-teste`.
 *
 * ── Por que isto existe ─────────────────────────────────────────────────────
 * A primeira versão deste script afirmava `html.includes('value="5"')` e
 * `html.includes('value="2"')` para provar que as medidas voltaram preenchidas. A
 * segunda **passava pelo motivo errado**: `value="2"` casa com
 * `<option value="2">II</option>` do seletor de furca, que existe em toda linha de
 * molar. E `html.includes('>7<')` para o NIC é do mesmo tipo — num exame de 192
 * medidas, procurar um algarismo solto no HTML é asserção que passa sempre.
 *
 * A saída certa não é afrouxar e sim apontar: `data-teste` identifica o elemento, e a
 * comparação acontece **naquele lugar**.
 */
function atributoDe(html: string, teste: string, atributo: string): string | null {
  const i = html.indexOf(`data-teste="${teste}"`)
  if (i === -1) return null
  // A tag termina no primeiro `>` depois do marcador. Atributo fora dela não conta.
  const fim = html.indexOf('>', i)
  const tag = html.slice(i, fim === -1 ? undefined : fim)
  const m = new RegExp(`${atributo}="([^"]*)"`).exec(tag)
  return m ? m[1]! : null
}

async function pegar(caminho: string, cookie: string): Promise<{ status: number; html: string }> {
  const r = await fetch(`${BASE}${caminho}`, { headers: { cookie }, redirect: 'manual' })
  const html = r.status === 200 ? await r.text() : ''
  return { status: r.status, html }
}

/**
 * Cria staff com MFA **cifrado**, gerando o uuid antes do INSERT.
 *
 * `cifrarSegredo` amarra o texto cifrado ao `usuario.id` (dado autenticado adicional),
 * então o id precisa existir antes. Guardar em texto claro funcionaria — o formato
 * legado é aceito — e seria escrever hoje o que a próxima limpeza vai ter de migrar.
 */
async function criarStaff(
  perfil: 'dentista' | 'recepcao',
): Promise<{ ator: Ator; email: string; segredo: string }> {
  const id = randomUUID()
  const segredo = gerarSegredoTotp()
  const email = `${perfil}-${MARCA.toLowerCase()}@local`

  const { profissionalId } = await db.transaction(async (tx) => {
    await tx.insert(usuario).values({
      id,
      nome: `${MARCA} ${perfil}`,
      email,
      senhaHash: await gerarHashSenha(SENHA),
      perfil,
      mfaSecret: cifrarSegredo(segredo, id),
      mfaAtivo: true,
    })
    // Dentista ativo precisa de linha em `profissional` NO MESMO COMMIT — a trava
    // deferida de `drizzle/0021` cobra ali, e dois inserts soltos violam no primeiro.
    let pid: string | null = null
    if (perfil === 'dentista') {
      const [p] = await tx
        .insert(profissional)
        .values({ usuarioId: id, cro: `${MARCA.slice(-6)}`, ufCro: 'SP' })
        .returning({ id: profissional.id })
      pid = p!.id
    }
    return { profissionalId: pid }
  })

  const [linha] = await db
    .select({ clinicaId: usuario.clinicaId })
    .from(usuario)
    .where(eq(usuario.id, id))

  return {
    ator: {
      usuarioId: id,
      clinicaId: linha!.clinicaId,
      nome: `${MARCA} ${perfil}`,
      email,
      perfil,
      profissionalId,
    },
    email,
    segredo,
  }
}

async function main(): Promise<void> {
  console.log('\n═══ Telas clínicas (periograma, laboratório, esterilização) ═══')

  const dentista = await criarStaff('dentista')
  const recepcao = await criarStaff('recepcao')

  const [pac] = await db
    .insert(paciente)
    .values({ nome: `${MARCA} Paciente`, dataNascimento: '1985-06-10' })
    .returning({ id: paciente.id })
  const pacienteId = pac!.id

  // ── Exame com medidas de verdade ──────────────────────────────────────────
  //
  // Números escolhidos para a asserção ser específica: o 16 tem PS 5 e recessão 2,
  // logo NIC 7 — e 7 não aparece em nenhum outro lugar da página. Procurar "5" casaria
  // com qualquer coisa.
  const [ex] = await db
    .insert(periograma)
    .values({ pacienteId, profissionalId: dentista.ator.profissionalId! })
    .returning({ id: periograma.id })
  const exameId = ex!.id

  await registrarMedidasComAtor(
    dentista.ator,
    exameId,
    [{ denteFdi: 16, mobilidade: 1, furca: 2 }],
    [
      { denteFdi: 16, sitio: 'mesio_vestibular', profundidadeMm: 5, recessaoMm: 2, sangramento: true },
      { denteFdi: 16, sitio: 'vestibular', profundidadeMm: 3, recessaoMm: 0 },
    ],
  )

  const cookieDentista = await entrar(dentista.email, dentista.segredo)
  const cookieRecepcao = await entrar(recepcao.email, recepcao.segredo)

  // ── 1. Periograma: a tela abre e mostra os números gravados ───────────────
  console.log('\n\x1b[36m1.\x1b[0m Periograma')
  const p1 = await pegar(`/periograma/${pacienteId}`, cookieDentista)
  conferir(p1.status === 200, `/periograma/<paciente> responde ${p1.status}`)

  // ESTE é o `deveFuncionar` que sustenta as asserções negativas abaixo: se a página
  // não renderizou a grade, tudo o que se afirmar sobre o que ela não mostra é vazio.
  const grade = p1.html.includes('Grade de sondagem') || p1.html.includes('data-campo=')
  conferir(grade, 'a grade renderizou (deveFuncionar — sem isto, o resto não mede nada)')

  conferir(p1.html.includes(`${MARCA} Paciente`), 'o nome do paciente aparece')
  conferir(
    p1.html.includes('data-campo="16:mesio_vestibular:ps"'),
    'o campo do sítio mésio-vestibular do 16 existe na grade',
  )
  const psGravada = atributoDe(p1.html, 'ps-16-mesio_vestibular', 'value')
  const recGravada = atributoDe(p1.html, 'rec-16-mesio_vestibular', 'value')
  conferir(
    psGravada === '5' && recGravada === '2',
    `as medidas gravadas voltam no campo certo (PS ${psGravada ?? 'ausente'}, recessão ${recGravada ?? 'ausente'})`,
  )

  const nic = atributoDe(p1.html, 'nic-16-mesio_vestibular', 'data-valor')
  conferir(nic === '7', `o NIC daquele sítio é 5 + 2 = 7 (obtido: ${nic ?? 'ausente'})`)

  // Contraprova do leitor: um sítio SEM medida tem NIC vazio. Se `atributoDe` estivesse
  // devolvendo qualquer coisa, este caso passaria junto com o de cima.
  const nicVazio = atributoDe(p1.html, 'nic-16-palatina', 'data-valor')
  conferir(
    nicVazio === '',
    `sítio não medido fica sem NIC, não com zero (obtido: ${JSON.stringify(nicVazio)})`,
  )

  // Furca: o 16 é molar e tem o campo; o 21 é incisivo e mostra "raiz única".
  conferir(
    p1.html.includes('Furca do dente 16'),
    'o 16 (molar) oferece o campo de furca',
  )
  conferir(
    !p1.html.includes('Furca do dente 21'),
    'o 21 (incisivo) NÃO oferece campo de furca — a tela obedece ao modelo',
  )
  conferir(
    !p1.html.includes('Furca do dente 14'),
    'o 14 também não — está fora da lista de multirradiculares, por escolha conservadora',
  )
  // Sítio por arcada: o superior tem palatina, o inferior lingual. Sítio errado seria
  // gravável só se a grade o oferecesse.
  conferir(
    p1.html.includes('data-campo="16:palatina:ps"') &&
      !p1.html.includes('data-campo="16:lingual:ps"'),
    'o 16 (superior) tem sítio palatino e não lingual',
  )
  conferir(
    p1.html.includes('data-campo="36:lingual:ps"') &&
      !p1.html.includes('data-campo="36:palatina:ps"'),
    'o 36 (inferior) tem sítio lingual e não palatino',
  )

  // ── 2. Contraprova do deveFuncionar ──────────────────────────────────────
  //
  // Prova que a asserção positiva reprova quando o conteúdo não está lá: procuramos um
  // texto que a página não tem. Se isto der verde, `includes` está sempre verdadeiro e
  // TODAS as asserções acima são decorativas.
  console.log('\n\x1b[36m2.\x1b[0m Contraprova: a conferência sabe reprovar')
  const inventado = `NAO-EXISTE-${MARCA}`
  conferir(
    !p1.html.includes(inventado),
    `texto inexistente não é encontrado (se falhasse, todo includes acima seria vazio)`,
  )

  // ── 3. Perfil errado vai para /sem-permissao ──────────────────────────────
  console.log('\n\x1b[36m3.\x1b[0m RBAC: o menu esconder não é segurança')
  const p3 = await fetch(`${BASE}/periograma/${pacienteId}`, {
    headers: { cookie: cookieRecepcao },
    redirect: 'manual',
  })
  const destino = p3.headers.get('location') ?? ''
  conferir(
    p3.status === 307 || p3.status === 302 || destino.includes('sem-permissao'),
    `recepção pedindo o periograma por URL: ${p3.status} → ${destino || '(sem redirect)'}`,
  )

  // ── 4. Laboratório e esterilização abrem ─────────────────────────────────
  console.log('\n\x1b[36m4.\x1b[0m Laboratório e esterilização')
  const p4 = await pegar('/laboratorio', cookieDentista)
  conferir(p4.status === 200, `/laboratorio responde ${p4.status}`)
  conferir(
    p4.html.includes('Laboratório') && p4.html.includes('fora do prazo'),
    'a tela do laboratório renderizou o resumo de prazo',
  )

  const p5 = await pegar('/esterilizacao', cookieRecepcao)
  conferir(p5.status === 200, `/esterilizacao responde ${p5.status} para a recepção`)
  /*
   * Âncora que existe SEMPRE, e a escolha custou uma falha.
   *
   * A primeira versão procurava `'indicador biológico'` — texto que só aparece quando
   * há carga pendente ou autoclave cadastrada. Neste ponto do script não há nenhuma
   * das duas (a autoclave é criada no passo 5), então a página estava no seu estado
   * vazio e a asserção reprovou.
   *
   * Reprovou pelo motivo certo: eu estava medindo **presença de dado** e chamando
   * aquilo de "a tela explica". A frase do subtítulo é renderizada com ou sem dado, e é
   * ela que a asserção deve olhar.
   */
  conferir(
    p5.html.includes('sai dias depois da carga'),
    'a tela de esterilização explica que o biológico vem depois (texto do estado vazio também)',
  )
  conferir(
    p5.html.includes('RDC 15'),
    'e diz explicitamente que o registro NÃO é conformidade com a RDC 15',
  )

  // ── 5. Ciclo pendente aparece como trabalho ──────────────────────────────
  console.log('\n\x1b[36m5.\x1b[0m Ciclo pendente de biológico')
  const [auto] = await db
    .insert(autoclave)
    .values({ nome: `${MARCA} Autoclave`, ativo: true })
    .returning({ id: autoclave.id })

  await db.insert(cicloEsterilizacao).values({
    autoclaveId: auto!.id,
    responsavelId: recepcao.ator.usuarioId,
    numero: 1,
    iniciadoEm: new Date(),
    conteudo: `${MARCA} caixa de periodontia`,
    indicadorQuimico: 'aprovado',
  })

  const p6 = await pegar('/esterilizacao', cookieRecepcao)
  conferir(
    p6.html.includes(`${MARCA} caixa de periodontia`),
    'o ciclo recém-registrado aparece na lista',
  )
  conferir(
    p6.html.includes('aguardando o indicador biológico'),
    'e é contado como pendente — é o que a tela existe para tornar visível',
  )
  conferir(
    p6.html.includes('Negativo') && p6.html.includes('Positivo'),
    'a recepção pode lançar o resultado (tem permissão de editar estoque)',
  )

  // ── Limpeza ──────────────────────────────────────────────────────────────
  console.log('\n\x1b[36m6.\x1b[0m Limpeza')
  /*
   * Sem `DISABLE TRIGGER` aqui, e isso foi conferido em vez de presumido: entre as
   * tabelas que este script cria, só `paciente` tem trigger de aplicação
   * (`paciente_toca_atualizado_em`), e ela não bloqueia `DELETE`. As do periograma não
   * são append-only — a imutabilidade da Fase 21 está nas colunas GERADAS, não em
   * trigger de exclusão.
   *
   * Desligar trigger "por segurança" seria pedir o poder de furar FK sem precisar
   * dele, e é exatamente o atalho que deixou 5 movimentos de estoque órfãos neste
   * projeto.
   */
  await db.delete(periogramaSitio).where(eq(periogramaSitio.periogramaId, exameId))
  await db.delete(periogramaDente).where(eq(periogramaDente.periogramaId, exameId))
  await db.delete(periograma).where(eq(periograma.id, exameId))

  await db.delete(cicloEsterilizacao).where(eq(cicloEsterilizacao.autoclaveId, auto!.id))
  await db.delete(autoclave).where(eq(autoclave.id, auto!.id))
  await db.delete(paciente).where(eq(paciente.id, pacienteId))

  // Usuário e profissional na MESMA transação, pelo mesmo motivo da criação.
  await db.transaction(async (tx) => {
    if (dentista.ator.profissionalId) {
      await tx.delete(profissional).where(eq(profissional.id, dentista.ator.profissionalId))
    }
    await tx.delete(usuario).where(eq(usuario.id, dentista.ator.usuarioId))
  })
  await db.delete(usuario).where(eq(usuario.id, recepcao.ator.usuarioId))
  console.log('   ✓ dados da verificação removidos')
}

idDaPrimeiraClinica()
  .then((clinicaId) => comContextoDeClinica(clinicaId, main))
  .then(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32m═══ Telas clínicas conferidas ═══\x1b[0m\n'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m\n`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
