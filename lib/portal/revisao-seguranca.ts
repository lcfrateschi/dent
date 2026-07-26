import { randomUUID } from 'node:crypto'
import { gerarConvite, gerarTokenDeSessao, hashDoTokenDeSessao } from '@/lib/auth/convite'
import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  documento,
  paciente,
  pacienteConta,
  pacienteSessao,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { COOKIE_PORTAL } from './sessao'
import { eq } from 'drizzle-orm'

/**
 * Revisão de segurança do portal — **obrigatória nesta fase** (ROADMAP).
 *
 * `npm run portal:seguranca`
 *
 * Não é teste de feliz caminho: é uma bateria **adversarial**. Cada caso tenta
 * fazer algo que não deveria funcionar, e o script falha se qualquer tentativa
 * tiver êxito. É a diferença entre "o portal funciona" e "o portal não vaza".
 *
 * O que está sendo atacado:
 *
 *   A. IDOR — ler dado de outro paciente trocando id na URL
 *   B. Cruzamento de realms — cookie de staff no portal e vice-versa
 *   C. Sessão — token forjado, revogado, expirado, de conta desativada
 *   D. Convite — reuso, expirado, token de outra conta
 *   E. Força bruta — bloqueio depois de N tentativas
 *   F. Enumeração — a resposta não revela se a conta existe
 *
 * Dois pacientes são criados, cada um com dado próprio, e o script tenta acessar
 * o dado do B usando a sessão do A.
 */

const BASE = 'http://localhost:3000'
const SENHA_A = 'portal seguro A 42'
const SENHA_B = 'portal seguro B 42'
const SENHA_STAFF = 'Staff-Revisao-2026!x'

let falhas = 0
let passaram = 0

function bloco(titulo: string): void {
  console.log(`\n\x1b[1m${titulo}\x1b[0m`)
}

/** Registra o resultado de uma tentativa de ataque. */
function deveFalhar(condicaoDeSeguranca: boolean, descricao: string, detalhe = ''): void {
  if (condicaoDeSeguranca) {
    passaram++
    console.log(`   \x1b[32m✓ bloqueado\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  } else {
    falhas++
    console.error(`   \x1b[31m✗ VAZOU\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  }
}

function deveFuncionar(condicao: boolean, descricao: string, detalhe = ''): void {
  if (condicao) {
    passaram++
    console.log(`   \x1b[32m✓\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  } else {
    falhas++
    console.error(`   \x1b[31m✗ quebrou\x1b[0m ${descricao}${detalhe ? ` — ${detalhe}` : ''}`)
  }
}

function juntar(...listas: string[][]): string {
  const m = new Map<string, string>()
  for (const l of listas)
    for (const b of l) {
      const par = b.split(';')[0]!
      m.set(par.slice(0, par.indexOf('=')), par)
    }
  return [...m.values()].join('; ')
}

/** Login no portal por HTTP, devolvendo o cookie. */
async function entrarNoPortalHttp(
  email: string,
  senha: string,
): Promise<{ cookie: string | null; corpo: string }> {
  // O login do portal é server action; chamar por HTTP exigiria o id da action.
  // Então a sessão é aberta pelo caminho de produção (a action) via um endpoint
  // interno? Não existe. Aqui o script cria a sessão como o servidor criaria e
  // usa o cookie — o que é fiel: o que se está testando é o CONSUMO do cookie.
  const [conta] = await db
    .select({ id: pacienteConta.id })
    .from(pacienteConta)
    .where(eq(pacienteConta.email, email))

  if (!conta) return { cookie: null, corpo: 'conta inexistente' }

  const { token, hash } = gerarTokenDeSessao()
  await db.insert(pacienteSessao).values({
    contaId: conta.id,
    tokenHash: hash,
    expiraEm: new Date(Date.now() + 12 * 3_600_000),
    ip: '127.0.0.1',
    userAgent: 'revisao-seguranca',
  })
  void senha
  return { cookie: `${COOKIE_PORTAL}=${token}`, corpo: '' }
}

async function entrarComoStaff(email: string, segredo: string): Promise<string> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntar(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email,
      senha: SENHA_STAFF,
      codigo: gerarCodigoTotp(segredo),
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })
  return juntar(c1.split('; '), r2.headers.getSetCookie())
}

async function main(): Promise<void> {
  console.log('\n═══ Revisão de segurança do portal do paciente ═══')

  const criados = { usuarios: [] as string[], pacientes: [] as string[] }

  // ── Cenário: dois pacientes com dado próprio, e um dentista ────────────────
  const segredoStaff = gerarSegredoTotp()
  const emailStaff = `rev-staff-${Date.now()}@local`
  // As duas linhas na MESMA transação: a trava deferida de `drizzle/0021` cobra
  // no commit que dentista ativo tenha cadastro de profissional.
  const { uStaff, prof } = await db.transaction(async (tx) => {
    const [novoUsuario] = await tx
      .insert(usuario)
      .values({
        nome: 'Dra. Revisão',
        email: emailStaff,
        senhaHash: await gerarHashSenha(SENHA_STAFF),
        perfil: 'dentista',
        mfaSecret: segredoStaff,
        mfaAtivo: true,
      })
      .returning({ id: usuario.id })
    const [novoProf] = await tx
      .insert(profissional)
      .values({ usuarioId: novoUsuario!.id, cro: `S${Date.now() % 100000}`, ufCro: 'SP' })
      .returning({ id: profissional.id })
    return { uStaff: novoUsuario, prof: novoProf }
  })
  criados.usuarios.push(uStaff!.id)

  const marca = Date.now()
  const contas: { pacienteId: string; contaId: string; email: string; senha: string }[] = []

  for (const [i, senha] of [SENHA_A, SENHA_B].entries()) {
    const [p] = await db
      .insert(paciente)
      .values({ nome: `Revisão Paciente ${i === 0 ? 'A' : 'B'}`, dataNascimento: '1990-01-01' })
      .returning({ id: paciente.id })
    criados.pacientes.push(p!.id)

    const email = `rev-p${i}-${marca}@local`
    const [c] = await db
      .insert(pacienteConta)
      .values({
        pacienteId: p!.id,
        email,
        senhaHash: await gerarHashSenha(senha),
        senhaDefinidaEm: new Date(),
      })
      .returning({ id: pacienteConta.id })

    contas.push({ pacienteId: p!.id, contaId: c!.id, email, senha })
  }

  const A = contas[0]!
  const B = contas[1]!

  // Dado do paciente B, que o A vai tentar alcançar.
  const inicioB = new Date(Date.now() + 48 * 3_600_000)
  const [agB] = await db
    .insert(agendamento)
    .values({
      pacienteId: B.pacienteId,
      profissionalId: prof!.id,
      inicio: inicioB,
      fim: new Date(inicioB.getTime() + 3_600_000),
    })
    .returning({ id: agendamento.id })

  const orcB = await criarOrcamentoEnviado(B.pacienteId, prof!.id, uStaff!.id)
  const docB = await criarDocumento(B.pacienteId, uStaff!.id)

  try {
    const sessaoA = await entrarNoPortalHttp(A.email, A.senha)
    if (!sessaoA.cookie) throw new Error('não consegui abrir sessão do paciente A')
    const cookieA = sessaoA.cookie

    // ── A. IDOR ─────────────────────────────────────────────────────────────
    bloco('A. IDOR — sessão do paciente A tentando alcançar dado do paciente B')

    const orcamentoDeB = await fetch(`${BASE}/meu/orcamentos/${orcB.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      orcamentoDeB.status === 404,
      'abrir orçamento de outro paciente pela URL',
      `status ${orcamentoDeB.status}`,
    )

    const documentoDeB = await fetch(`${BASE}/api/meu/documentos/${docB.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      documentoDeB.status === 404,
      'baixar documento de outro paciente',
      `status ${documentoDeB.status}`,
    )

    // Contraprova: o próprio documento tem de ser alcançável. Sem isto,
    // "bloqueado" poderia significar apenas que a rota está quebrada — que foi
    // exatamente o defeito que esta revisão encontrou na primeira execução.
    const docA = await criarDocumento(A.pacienteId, uStaff!.id)
    const meuDocumento = await fetch(`${BASE}/api/meu/documentos/${docA.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFuncionar(
      // 500 = integridade recusada (o arquivo de teste não existe no storage), o
      // que ainda prova que a AUTORIZAÇÃO passou. 401/404 provariam o contrário.
      meuDocumento.status !== 401 && meuDocumento.status !== 404,
      'o paciente A alcança o documento DELE (autorização passou)',
      `status ${meuDocumento.status}`,
    )

    // O próprio dado do A precisa continuar funcionando — senão "bloqueado" seria
    // só o portal estar quebrado.
    const orcA = await criarOrcamentoEnviado(A.pacienteId, prof!.id, uStaff!.id)
    const meuOrcamento = await fetch(`${BASE}/meu/orcamentos/${orcA.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFuncionar(
      meuOrcamento.status === 200,
      'o paciente A abre o orçamento DELE',
      `status ${meuOrcamento.status}`,
    )

    const inicio = await fetch(`${BASE}/meu`, { headers: { cookie: cookieA } })
    const htmlInicio = inicio.status === 200 ? await inicio.text() : ''
    deveFalhar(
      !htmlInicio.includes('Revisão Paciente B'),
      'nome de outro paciente aparecer na tela inicial',
    )
    deveFalhar(
      !htmlInicio.includes(agB!.id),
      'id de agendamento de outro paciente aparecer no HTML',
    )

    // ── B. Cruzamento de realms ─────────────────────────────────────────────
    bloco('B. Realms — cookie de um lado tentando abrir o outro')

    const cookieStaff = await entrarComoStaff(emailStaff, segredoStaff)
    deveFuncionar(cookieStaff.includes('authjs.session-token'), 'staff conseguiu entrar no sistema')

    const staffNoPortal = await fetch(`${BASE}/meu`, {
      headers: { cookie: cookieStaff },
      redirect: 'manual',
    })
    deveFalhar(
      staffNoPortal.status !== 200,
      'sessão de STAFF abrir o portal do paciente',
      `status ${staffNoPortal.status} → ${staffNoPortal.headers.get('location') ?? '—'}`,
    )

    const pacienteNoStaff = await fetch(`${BASE}/pacientes`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      pacienteNoStaff.status !== 200,
      'sessão de PACIENTE abrir a área da clínica',
      `status ${pacienteNoStaff.status} → ${pacienteNoStaff.headers.get('location') ?? '—'}`,
    )

    const pacienteNoPainel = await fetch(`${BASE}/painel`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      pacienteNoPainel.status !== 200,
      'sessão de paciente abrir o painel da clínica',
      `status ${pacienteNoPainel.status}`,
    )

    const pacienteNaRotaStaff = await fetch(`${BASE}/api/documentos/${docB.id}`, {
      headers: { cookie: cookieA },
      redirect: 'manual',
    })
    deveFalhar(
      pacienteNaRotaStaff.status !== 200,
      'sessão de paciente usar a rota de download DO STAFF',
      `status ${pacienteNaRotaStaff.status}`,
    )

    // ── C. Sessão ───────────────────────────────────────────────────────────
    bloco('C. Sessão — token forjado, revogado, expirado, conta desativada')

    const forjado = gerarTokenDeSessao().token
    const comForjado = await fetch(`${BASE}/meu`, {
      headers: { cookie: `${COOKIE_PORTAL}=${forjado}` },
      redirect: 'manual',
    })
    deveFalhar(
      comForjado.status !== 200,
      'token aleatório bem formado (não está no banco)',
      `status ${comForjado.status}`,
    )

    for (const lixo of ['', 'abc', '../../etc/passwd', 'null', '{}']) {
      const r = await fetch(`${BASE}/meu`, {
        headers: { cookie: `${COOKIE_PORTAL}=${encodeURIComponent(lixo)}` },
        redirect: 'manual',
      })
      deveFalhar(r.status !== 200, `cookie com valor ${JSON.stringify(lixo)}`, `status ${r.status}`)
    }

    // Sessão revogada
    const revogada = await entrarNoPortalHttp(A.email, A.senha)
    await db
      .update(pacienteSessao)
      .set({ revogadaEm: new Date() })
      .where(eq(pacienteSessao.tokenHash, hashDoTokenDeSessao(revogada.cookie!.split('=')[1]!)))
    const comRevogada = await fetch(`${BASE}/meu`, {
      headers: { cookie: revogada.cookie! },
      redirect: 'manual',
    })
    deveFalhar(comRevogada.status !== 200, 'sessão revogada', `status ${comRevogada.status}`)

    // Sessão expirada
    const { token: tokenVelho, hash: hashVelho } = gerarTokenDeSessao()
    await db.insert(pacienteSessao).values({
      contaId: A.contaId,
      tokenHash: hashVelho,
      criadoEm: new Date(Date.now() - 48 * 3_600_000),
      expiraEm: new Date(Date.now() - 24 * 3_600_000),
    })
    const comExpirada = await fetch(`${BASE}/meu`, {
      headers: { cookie: `${COOKIE_PORTAL}=${tokenVelho}` },
      redirect: 'manual',
    })
    deveFalhar(comExpirada.status !== 200, 'sessão expirada', `status ${comExpirada.status}`)

    // Conta desativada com sessão ainda válida
    const sessaoAtivaB = await entrarNoPortalHttp(B.email, B.senha)
    await db.update(pacienteConta).set({ ativo: false }).where(eq(pacienteConta.id, B.contaId))
    const comContaInativa = await fetch(`${BASE}/meu`, {
      headers: { cookie: sessaoAtivaB.cookie! },
      redirect: 'manual',
    })
    deveFalhar(
      comContaInativa.status !== 200,
      'sessão válida de conta DESATIVADA (revogação vale na hora)',
      `status ${comContaInativa.status}`,
    )
    await db.update(pacienteConta).set({ ativo: true }).where(eq(pacienteConta.id, B.contaId))

    // ── D. Convite ──────────────────────────────────────────────────────────
    bloco('D. Convite — reuso e expiração no banco')

    const conviteUsado = gerarConvite()
    await db
      .update(pacienteConta)
      .set({
        senhaHash: null,
        senhaDefinidaEm: null,
        tokenConviteHash: conviteUsado.hash,
        tokenConviteExpiraEm: conviteUsado.expiraEm,
      })
      .where(eq(pacienteConta.id, B.contaId))

    // A trigger exige que definir senha consuma o convite.
    let recusouConviteSobrevivente = false
    try {
      await db
        .update(pacienteConta)
        .set({ senhaHash: await gerarHashSenha(SENHA_B), senhaDefinidaEm: new Date() })
        .where(eq(pacienteConta.id, B.contaId))
    } catch {
      recusouConviteSobrevivente = true
    }
    deveFalhar(
      recusouConviteSobrevivente,
      'definir senha DEIXANDO o convite válido (trigger 0013)',
    )

    // Do jeito certo, funciona.
    await db
      .update(pacienteConta)
      .set({
        senhaHash: await gerarHashSenha(SENHA_B),
        senhaDefinidaEm: new Date(),
        tokenConviteHash: null,
        tokenConviteExpiraEm: null,
      })
      .where(eq(pacienteConta.id, B.contaId))
    const [depois] = await db
      .select({ hash: pacienteConta.tokenConviteHash })
      .from(pacienteConta)
      .where(eq(pacienteConta.id, B.contaId))
    deveFuncionar(depois?.hash === null, 'convite consumido junto com a senha')

    // ── E. Sessão não estica o próprio prazo ────────────────────────────────
    bloco('E. Sessão — imutabilidade dos campos que sustentam o prazo')

    const [algumaSessao] = await db
      .select({ id: pacienteSessao.id, contaId: pacienteSessao.contaId })
      .from(pacienteSessao)
      .where(eq(pacienteSessao.contaId, A.contaId))
      .limit(1)

    for (const [campo, valores] of [
      ['expira_em', "expira_em = now() + interval '30 days'"],
      ['conta_id', `conta_id = '${B.contaId}'`],
      ['token_hash', `token_hash = '${'a'.repeat(64)}'`],
    ] as const) {
      let recusou = false
      try {
        await db.execute(
          // biome-ignore lint: SQL literal montado a partir de constantes do teste.
          `update paciente_sessao set ${valores} where id = '${algumaSessao!.id}'` as never,
        )
      } catch {
        recusou = true
      }
      deveFalhar(recusou, `alterar ${campo} de uma sessão existente`)
    }

    // ── F. Enumeração ───────────────────────────────────────────────────────
    bloco('F. Enumeração — a resposta não diz se a conta existe')

    const { entrarNoPortal } = await import('./acoes')
    // Chamando a action direto: é a mesma função que a tela chama.
    const inexistente = await entrarNoPortal({
      email: `nao-existe-${randomUUID()}@local`,
      senha: 'qualquer coisa 123',
    })
    const senhaErrada = await entrarNoPortal({ email: A.email, senha: 'senha errada 123' })

    deveFuncionar(
      !inexistente.ok && !senhaErrada.ok && inexistente.mensagem === senhaErrada.mensagem,
      'mensagem idêntica para conta inexistente e senha errada',
      `"${inexistente.mensagem}"`,
    )
    deveFalhar(
      !/não (existe|cadastrad)|inexistente|inativ/i.test(inexistente.mensagem),
      'a mensagem revelar que a conta não existe',
    )

    // ── G. Força bruta ──────────────────────────────────────────────────────
    bloco('G. Força bruta — bloqueio depois de tentativas repetidas')

    let bloqueou = false
    let tentativas = 0
    for (let i = 0; i < 8 && !bloqueou; i++) {
      tentativas++
      const r = await entrarNoPortal({ email: A.email, senha: `errada ${i} vezes` })
      if (!r.ok && /muitas tentativas/i.test(r.mensagem)) bloqueou = true
    }
    deveFuncionar(bloqueou, `bloqueio disparou depois de ${tentativas} tentativas`)

    // E a senha CORRETA também é barrada enquanto o bloqueio vale — se não fosse,
    // o bloqueio não atrasaria quem está adivinhando.
    const durante = await entrarNoPortal({ email: A.email, senha: A.senha })
    deveFalhar(
      !durante.ok,
      'entrar com a senha certa durante o bloqueio',
      `"${durante.mensagem}"`,
    )

    // ── Resultado ───────────────────────────────────────────────────────────
    console.log(
      `\n${falhas === 0 ? '\x1b[32m' : '\x1b[31m'}═══ ${passaram} verificações, ${falhas} falha(s) ═══\x1b[0m\n`,
    )
    if (falhas > 0) process.exitCode = 1
  } finally {
    await limpar(criados, [orcB.id])
  }
}

async function criarOrcamentoEnviado(
  pacienteId: string,
  profissionalId: string,
  usuarioId: string,
): Promise<{ id: string }> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query("set local session_replication_role = 'replica'")
    const plano = await c.query(
      `insert into plano_tratamento (paciente_id, profissional_id, status, titulo)
       values ($1, $2, 'ativo', 'revisão') returning id`,
      [pacienteId, profissionalId],
    )
    const orc = await c.query(
      `insert into orcamento (paciente_id, plano_id, status, validade_ate, valor_bruto, desconto, valor_total, enviado_em, criado_por_id)
       values ($1, $2, 'enviado', current_date + 30, '100.00', '0.00', '100.00', now(), $3) returning id`,
      [pacienteId, plano.rows[0].id, usuarioId],
    )
    await c.query(
      `insert into orcamento_item (orcamento_id, descricao, quantidade, valor_unitario, ordem)
       values ($1, 'Procedimento de revisão', 1, '100.00', 1)`,
      [orc.rows[0].id],
    )
    await c.query('commit')
    return { id: orc.rows[0].id }
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

async function criarDocumento(pacienteId: string, usuarioId: string): Promise<{ id: string }> {
  const [d] = await db
    .insert(documento)
    .values({
      pacienteId,
      tipo: 'atestado',
      nome: 'Atestado de revisão.pdf',
      storageKey: `pacientes/${pacienteId}/2026/${randomUUID()}.pdf`,
      mimeType: 'application/pdf',
      tamanhoBytes: 100,
      sha256: 'a'.repeat(64),
      criadoPorId: usuarioId,
    })
    .returning({ id: documento.id })
  return { id: d!.id }
}

async function limpar(
  criados: { usuarios: string[]; pacientes: string[] },
  _orcamentos: string[],
): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query("set local session_replication_role = 'replica'")
    await c.query(
      'delete from paciente_sessao where conta_id in (select id from paciente_conta where paciente_id = any($1))',
      [criados.pacientes],
    )
    await c.query('delete from paciente_conta where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from documento where paciente_id = any($1)', [criados.pacientes])
    await c.query(
      'delete from orcamento_item where orcamento_id in (select id from orcamento where paciente_id = any($1))',
      [criados.pacientes],
    )
    await c.query('delete from orcamento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from plano_tratamento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from agendamento where paciente_id = any($1)', [criados.pacientes])
    await c.query('delete from audit_log where paciente_id = any($1)', [criados.pacientes])
    await c.query("delete from audit_log where ator_email like 'rev-p%@local'")
    await c.query("delete from audit_log where ator_email like 'nao-existe-%@local'")
    await c.query('delete from paciente where id = any($1)', [criados.pacientes])
    await c.query('delete from profissional where usuario_id = any($1)', [criados.usuarios])
    await c.query('delete from usuario where id = any($1)', [criados.usuarios])
    await c.query('commit')
    console.log('Dados da revisão removidos.')
  } catch (e) {
    await c.query('rollback')
    console.error('Falha ao limpar:', e)
  } finally {
    c.release()
  }
}

main()
  .then(async () => {
    await pool.end()
    process.exit(process.exitCode ?? 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
