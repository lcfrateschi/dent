import { gerarHashSenha } from '@/lib/auth/senha'
import { gerarCodigoTotp, gerarSegredoTotp } from '@/lib/auth/totp'
import type { Ator } from '@/lib/authz/sessao'
import { db, pool } from '@/lib/db'
import {
  agendamento,
  auditLog,
  cadeira,
  paciente,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { desativarCadeiraComAtor, salvarCadeiraComAtor } from './clinica'
import {
  criarUsuarioComAtor,
  desativarUsuarioComAtor,
  resetarMfaComAtor,
  trocarPropriaSenhaComAtor,
} from './usuarios'
import {
  salvarCarteirinhaComAtor,
  salvarConvenioComAtor,
  salvarPrecoComAtor,
} from '@/lib/convenios/cadastro'
import { tabelaNegociada } from '@/lib/convenios/consultas'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { and, eq } from 'drizzle-orm'

/**
 * Verificação dos cadastros administrativos: núcleo + telas, por HTTP.
 *
 *   npm run admin:verificar    (com o app rodando)
 *
 * Cobre o que teste unitário não alcança e o `db:verificar` não vê: o caminho
 * completo de um usuário criado pelo admin até ele conseguir usar o sistema, e o
 * que as telas mostram (e o que **não** mostram).
 *
 * Três verificações aqui são de segurança e valem mais que as outras juntas:
 *
 *   • a senha temporária NÃO vai para o `audit_log`
 *   • o segredo do autenticador NÃO aparece no HTML de /usuarios
 *   • perfil sem permissão NÃO abre /usuarios nem /configuracoes
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const MARCA = `ADM-${Date.now()}`
const SENHA_ADMIN = 'Verificacao-Admin-2026!'

let falhas = 0

function passo(n: number, texto: string): void {
  console.log(`\n\x1b[36m${n}.\x1b[0m ${texto}`)
}

function conferir(condicao: boolean, texto: string): void {
  if (condicao) {
    console.log(`   \x1b[32m✓\x1b[0m ${texto}`)
  } else {
    console.error(`   \x1b[31m✗ ${texto}\x1b[0m`)
    falhas++
  }
}

/** Dedupe por nome, mantendo o último — ver o comentário em estoque/verificar-telas. */
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

async function entrar(
  email: string,
  senha: string,
  segredo: string | null,
): Promise<{ cookie: string; erro: string | null }> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntar(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email,
      senha,
      codigo: segredo ? gerarCodigoTotp(segredo) : '',
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })
  const destino = r2.headers.get('location') ?? ''
  return {
    cookie: juntar(c1.split('; '), r2.headers.getSetCookie()),
    erro: destino.includes('error=') ? destino : null,
  }
}

/**
 * O SERVIDOR está com o segundo fator desligado?
 *
 * Pergunta ao app, não ao próprio processo. `process.env` daqui é o do script, e
 * os dois podem divergir — foi o que aconteceu na primeira tentativa: rodei o
 * script com `MFA_DESABILITADO=false` enquanto o servidor continuava com `true`,
 * e ele reprovou uma trava que estava desligada do outro lado. Quem decide é
 * quem aplica a regra, e o sinal observável é o aviso no login.
 */
async function servidorSemMfa(): Promise<boolean> {
  const html = await (await fetch(`${BASE}/entrar`)).text()
  return html.includes('duas etapas desligada')
}

/** Para onde o sistema manda esta sessão quando ela pede uma tela qualquer. */
async function destinoDe(cookie: string, caminho = '/pacientes'): Promise<string> {
  const r = await fetch(`${BASE}${caminho}`, { headers: { cookie }, redirect: 'manual' })
  if (r.status === 200) return caminho
  return r.headers.get('location') ?? `status ${r.status}`
}

async function main(): Promise<void> {
  console.log('\n═══ Cadastros administrativos: núcleo e telas ═══')

  const hoje = await hojeDaClinica()
  const segredoAdmin = gerarSegredoTotp()
  const emailAdmin = `adm-${Date.now()}@local`

  const [uAdmin] = await db
    .insert(usuario)
    .values({
      nome: `${MARCA} Administradora`,
      email: emailAdmin,
      senhaHash: await gerarHashSenha(SENHA_ADMIN),
      perfil: 'admin',
      mfaSecret: segredoAdmin,
      mfaAtivo: true,
    })
    .returning({ id: usuario.id })

  const ator: Ator = {
    usuarioId: uAdmin!.id,
    nome: `${MARCA} Administradora`,
    email: emailAdmin,
    perfil: 'admin',
    profissionalId: null,
  }

  const criados = { usuarios: [uAdmin!.id], convenios: [] as string[], pacientes: [] as string[], cadeiras: [] as string[] }

  try {
    // ── 1. Cadastro de usuário e senha temporária ──────────────────────────
    passo(1, 'Admin cadastra uma recepcionista; a senha nasce temporária')
    const nova = await criarUsuarioComAtor(ator, {
      nome: `${MARCA} Recepcionista`,
      email: `rec-${Date.now()}@local`,
      perfil: 'recepcao',
    })
    conferir(nova.ok, nova.ok ? nova.mensagem : nova.mensagem)
    if (!nova.ok || !nova.senhaTemporaria || !nova.id) throw new Error('usuário não criado')
    criados.usuarios.push(nova.id)
    const senhaTemporaria = nova.senhaTemporaria
    const [rec] = await db.select({ email: usuario.email, temporaria: usuario.senhaTemporaria }).from(usuario).where(eq(usuario.id, nova.id))
    conferir(rec?.temporaria === true, 'a senha está marcada como temporária no banco')

    // ── 2. A senha temporária não vai para a auditoria ─────────────────────
    passo(2, 'A senha temporária NÃO aparece na trilha de auditoria')
    const trilha = await db
      .select({ detalhes: auditLog.detalhes })
      .from(auditLog)
      .where(eq(auditLog.entidadeId, nova.id))
    const trilhaTexto = JSON.stringify(trilha)
    conferir(trilha.length > 0, `${trilha.length} evento(s) registrado(s) para o novo usuário`)
    conferir(
      !trilhaTexto.includes(senhaTemporaria),
      'a senha não está em audit_log.detalhes — o que se audita é que um acesso foi criado',
    )
    const [hashGuardado] = await db
      .select({ hash: usuario.senhaHash })
      .from(usuario)
      .where(eq(usuario.id, nova.id))
    conferir(
      !hashGuardado?.hash.includes(senhaTemporaria),
      'e a coluna guarda hash, não a senha',
    )

    // ── 3. MFA primeiro, senha depois ─────────────────────────────────────
    passo(3, 'Primeiro acesso: presa em /configurar-mfa, mesmo com senha temporária pendente')
    const login1 = await entrar(rec!.email, senhaTemporaria, null)
    conferir(login1.erro === null, `login com a senha temporária foi aceito${login1.erro ?? ''}`)

    if (await servidorSemMfa()) {
      /**
       * Ambiente com `MFA_DESABILITADO=true`: não há porta de MFA para provar.
       * O caso é PULADO em voz alta, com o motivo — um verde silencioso aqui
       * afirmaria que a trava existe num ambiente onde ela está desligada, que é
       * exatamente o tipo de relatório que engana quem o lê.
       */
      console.log(
        '   \x1b[33m⊘ pulado\x1b[0m a guarda de MFA está DESLIGADA neste ambiente ' +
          '(MFA_DESABILITADO=true) — rode com MFA_DESABILITADO=false para provar esta trava',
      )
    } else {
      const destino1 = await destinoDe(login1.cookie)
      conferir(
        destino1.includes('/configurar-mfa'),
        `a sessão vai para ${destino1} — segundo fator antes de qualquer coisa`,
      )
    }

    // Simula a conclusão do cadastro do autenticador (a tela faz isto por action).
    const segredoRec = gerarSegredoTotp()
    await db
      .update(usuario)
      .set({ mfaSecret: segredoRec, mfaAtivo: true })
      .where(eq(usuario.id, nova.id))

    passo(4, 'Com MFA configurado, agora é presa em /trocar-senha')
    const login2 = await entrar(rec!.email, senhaTemporaria, segredoRec)
    conferir(login2.erro === null, 'login com senha temporária + código do autenticador')
    const destino2 = await destinoDe(login2.cookie)
    conferir(
      destino2.includes('/trocar-senha'),
      `a sessão vai para ${destino2} — senha ditada por terceiro não vira definitiva`,
    )
    const telaTroca = await fetch(`${BASE}/trocar-senha`, { headers: { cookie: login2.cookie } })
    conferir(telaTroca.status === 200, `/trocar-senha responde ${telaTroca.status}`)
    const htmlTroca = await telaTroca.text()
    conferir(
      htmlTroca.includes('Senha que você recebeu'),
      'e pede a senha ATUAL — sem isso, sessão esquecida no balcão tomaria a conta',
    )

    // ── 5. Trocada a senha, o sistema libera ──────────────────────────────
    passo(5, 'Depois de trocar, a recepcionista circula normalmente')
    const atorRec: Ator = {
      usuarioId: nova.id,
      nome: 'rec',
      email: rec!.email,
      perfil: 'recepcao',
      profissionalId: null,
    }
    const fraca = await trocarPropriaSenhaComAtor(atorRec, senhaTemporaria, '123456')
    conferir(!fraca.ok, `senha fraca é recusada: "${fraca.ok ? '' : fraca.mensagem}"`)

    const errada = await trocarPropriaSenhaComAtor(atorRec, 'senha-que-nao-e-a-atual', 'Cadeira-Verde-Sorriso-88')
    conferir(!errada.ok, 'sem a senha atual correta, a troca é recusada')

    const trocou = await trocarPropriaSenhaComAtor(
      atorRec,
      senhaTemporaria,
      'Cadeira-Verde-Sorriso-88',
    )
    conferir(trocou.ok, trocou.mensagem)

    const login3 = await entrar(rec!.email, 'Cadeira-Verde-Sorriso-88', segredoRec)
    const destino3 = await destinoDe(login3.cookie)
    conferir(destino3 === '/pacientes', `com senha própria, /pacientes abre (${destino3})`)

    const antiga = await entrar(rec!.email, senhaTemporaria, segredoRec)
    conferir(antiga.erro !== null, 'e a senha temporária deixou de funcionar')

    // ── 6. RBAC das telas de administração ────────────────────────────────
    passo(6, 'Recepção NÃO abre as telas de administração')
    for (const caminho of ['/usuarios', '/configuracoes']) {
      const destino = await destinoDe(login3.cookie, caminho)
      conferir(
        destino.includes('/sem-permissao') || destino.startsWith('status 40'),
        `recepção em ${caminho} → ${destino}`,
      )
    }

    // ── 7. A tela de usuários e o que ela não mostra ──────────────────────
    passo(7, 'A tela de usuários não expõe o segredo do autenticador')
    const loginAdmin = await entrar(emailAdmin, SENHA_ADMIN, segredoAdmin)
    conferir(loginAdmin.erro === null, 'admin entrou')
    const telaUsuarios = await fetch(`${BASE}/usuarios`, { headers: { cookie: loginAdmin.cookie } })
    const htmlUsuarios = await telaUsuarios.text()
    conferir(telaUsuarios.status === 200, `/usuarios responde ${telaUsuarios.status}`)
    conferir(htmlUsuarios.includes(`${MARCA} Recepcionista`), 'a recepcionista aparece na lista')
    conferir(
      !htmlUsuarios.includes(segredoRec) && !htmlUsuarios.includes(segredoAdmin),
      'nenhum segredo TOTP no HTML — quem o visse geraria códigos válidos em nome do outro',
    )
    conferir(
      !htmlUsuarios.includes('Cadeira-Verde-Sorriso-88'),
      'nenhuma senha no HTML',
    )
    conferir(
      htmlUsuarios.includes('configurada'),
      'a tela diz SE o MFA está configurado, que é a informação útil',
    )

    // ── 8. Não se pode ficar sem administrador ─────────────────────────────
    passo(8, 'A clínica não pode ficar sem administrador')
    const admins = await db
      .select({ id: usuario.id })
      .from(usuario)
      .where(and(eq(usuario.perfil, 'admin'), eq(usuario.ativo, true)))
    // Desativa todos os outros admins para chegar ao caso real do último.
    for (const a of admins) {
      if (a.id !== ator.usuarioId) {
        await db.update(usuario).set({ ativo: false }).where(eq(usuario.id, a.id))
      }
    }
    const ultimo = await desativarUsuarioComAtor(
      { ...ator, usuarioId: 'outro-qualquer' },
      ator.usuarioId,
    )
    conferir(!ultimo.ok, `recusado: "${ultimo.ok ? '' : ultimo.mensagem}"`)

    const euMesmo = await desativarUsuarioComAtor(ator, ator.usuarioId)
    conferir(!euMesmo.ok, 'e desativar a si mesmo também é recusado')
    // Reativa os outros para não deixar o banco num estado estranho.
    for (const a of admins) {
      if (a.id !== ator.usuarioId) {
        await db.update(usuario).set({ ativo: true }).where(eq(usuario.id, a.id))
      }
    }

    // ── 9. Dentista exige CRO ─────────────────────────────────────────────
    passo(9, 'Perfil dentista sem CRO é recusado')
    const semCro = await criarUsuarioComAtor(ator, {
      nome: `${MARCA} Dr. Sem CRO`,
      email: `semcro-${Date.now()}@local`,
      perfil: 'dentista',
    })
    conferir(!semCro.ok, `recusado: "${semCro.ok ? '' : semCro.mensagem}"`)

    const comCro = await criarUsuarioComAtor(ator, {
      nome: `${MARCA} Dra. Com CRO`,
      email: `comcro-${Date.now()}@local`,
      perfil: 'dentista',
      cro: `V${Date.now() % 100000}`,
      ufCro: 'sp',
      comissaoPct: '45',
    })
    conferir(comCro.ok, comCro.mensagem)
    if (comCro.ok && comCro.id) {
      criados.usuarios.push(comCro.id)
      const [prof] = await db
        .select({ ufCro: profissional.ufCro, comissao: profissional.comissaoPct })
        .from(profissional)
        .where(eq(profissional.usuarioId, comCro.id))
      conferir(
        prof?.ufCro === 'SP',
        `a UF do CRO foi gravada em maiúscula (${prof?.ufCro}) — a folha de conferência é digitada no portal da operadora, que recusa "sp"`,
      )
      conferir(prof?.comissao === '45.00', `comissão gravada como ${prof?.comissao}`)
    }

    // ── 10. Reset de MFA não revela segredo ───────────────────────────────
    passo(10, 'Reiniciar o autenticador apaga o segredo, não o mostra')
    const reset = await resetarMfaComAtor(ator, nova.id)
    conferir(reset.ok, reset.mensagem)
    const [depoisReset] = await db
      .select({ secret: usuario.mfaSecret, ativo: usuario.mfaAtivo })
      .from(usuario)
      .where(eq(usuario.id, nova.id))
    conferir(
      depoisReset?.secret === null && depoisReset?.ativo === false,
      'segredo apagado e MFA desmarcado — a pessoa reconfigura no próximo acesso',
    )
    conferir(
      !JSON.stringify(reset).includes(segredoRec),
      'e o resultado da operação não carrega o segredo antigo',
    )

    // ── 11. Tabela negociada: reajuste fecha a vigência anterior ──────────
    passo(11, 'Reajuste fecha a vigência anterior no dia anterior')
    const op = await salvarConvenioComAtor(ator, {
      nome: `${MARCA} Operadora`,
      registroAns: '412345',
      prazoPagamentoDias: 30,
    })
    conferir(op.ok, op.mensagem)
    if (!op.ok || !op.id) throw new Error('operadora não criada')
    criados.convenios.push(op.id)

    const [proc] = await db
      .select({ id: procedimento.id, nome: procedimento.nome })
      .from(procedimento)
      .where(eq(procedimento.codigo, 'DENT-001'))
      .limit(1)

    const p1 = await salvarPrecoComAtor(ator, {
      convenioId: op.id,
      procedimentoId: proc!.id,
      valor: '100.00',
      coberturaPct: '70',
      vigenciaInicio: '2025-01-01',
    })
    conferir(p1.ok, p1.mensagem)

    const p2 = await salvarPrecoComAtor(ator, {
      convenioId: op.id,
      procedimentoId: proc!.id,
      valor: '120.00',
      coberturaPct: '70',
      vigenciaInicio: '2026-03-01',
    })
    conferir(p2.ok && p2.mensagem.includes('2026-02-28'), p2.ok ? p2.mensagem : p2.mensagem)

    const precos = await tabelaNegociada(op.id, hoje)
    const fechada = precos.find((x) => x.vigenciaInicio === '2025-01-01')
    const aberta = precos.find((x) => x.vigenciaInicio === '2026-03-01')
    conferir(fechada?.vigenciaFim === '2026-02-28', `a anterior fechou em ${fechada?.vigenciaFim}`)
    conferir(aberta?.vigenciaFim === null, 'a nova ficou em aberto')
    conferir(
      precos.filter((x) => x.vigenteHoje).length === 1,
      'e exatamente UM preço vale hoje — dois tornariam indefinido o valor a faturar',
    )

    const sobreposto = await salvarPrecoComAtor(ator, {
      convenioId: op.id,
      procedimentoId: proc!.id,
      valor: '130.00',
      vigenciaInicio: '2025-06-01',
    })
    conferir(!sobreposto.ok, `sobreposição recusada: "${sobreposto.ok ? '' : sobreposto.mensagem}"`)

    // ── 12. Carteirinha: uma ativa por operadora ──────────────────────────
    passo(12, 'Uma carteirinha ativa por paciente e operadora')
    const [pac] = await db
      .insert(paciente)
      .values({ nome: `${MARCA} Paciente`, dataNascimento: '1988-08-08' })
      .returning({ id: paciente.id })
    criados.pacientes.push(pac!.id)

    const c1 = await salvarCarteirinhaComAtor(ator, {
      pacienteId: pac!.id,
      convenioId: op.id,
      numeroCarteirinha: 'CART-A',
      adesaoEm: '2025-01-01',
    })
    conferir(c1.ok, c1.mensagem)

    const c2 = await salvarCarteirinhaComAtor(ator, {
      pacienteId: pac!.id,
      convenioId: op.id,
      numeroCarteirinha: 'CART-B',
      adesaoEm: '2026-01-01',
    })
    conferir(!c2.ok, `segunda ativa recusada: "${c2.ok ? '' : c2.mensagem}"`)

    const dependenteSemTitular = await salvarCarteirinhaComAtor(ator, {
      pacienteId: pac!.id,
      convenioId: op.id,
      numeroCarteirinha: 'CART-C',
      ehTitular: false,
    })
    conferir(!dependenteSemTitular.ok, 'dependente sem nome do titular é recusado')

    // ── 13. Cadeira com agendamento futuro ────────────────────────────────
    passo(13, 'Cadeira com agendamento futuro não é desativada')
    const novaCadeira = await salvarCadeiraComAtor(ator, { nome: `${MARCA} Cadeira`, ordem: 9 })
    conferir(novaCadeira.ok, novaCadeira.mensagem)
    const [cad] = await db
      .select({ id: cadeira.id })
      .from(cadeira)
      .where(eq(cadeira.nome, `${MARCA} Cadeira`))
      .limit(1)
    criados.cadeiras.push(cad!.id)

    const [profQualquer] = await db.select({ id: profissional.id }).from(profissional).limit(1)
    await db.insert(agendamento).values({
      pacienteId: pac!.id,
      profissionalId: profQualquer!.id,
      cadeiraId: cad!.id,
      inicio: new Date(Date.now() + 4 * 86_400_000),
      fim: new Date(Date.now() + 4 * 86_400_000 + 3_600_000),
    })

    const comAgenda = await desativarCadeiraComAtor(ator, cad!.id)
    conferir(!comAgenda.ok, `recusado: "${comAgenda.ok ? '' : comAgenda.mensagem}"`)

    // ── 14. A tela de ajustes lista o que falta ───────────────────────────
    passo(14, 'A tela de ajustes começa pelo que falta configurar')
    const telaAjustes = await fetch(`${BASE}/configuracoes`, { headers: { cookie: loginAdmin.cookie } })
    const htmlAjustes = await telaAjustes.text()
    conferir(telaAjustes.status === 200, `/configuracoes responde ${telaAjustes.status}`)
    conferir(
      htmlAjustes.includes('Comissão sobre valor'),
      'e mostra as decisões fechadas como leitura, não como campo editável',
    )
    conferir(
      !htmlAjustes.includes('<select id="base-comissao"'),
      'não existe seletor de base de comissão — mudá-la reabriria a apuração de meses fechados',
    )

    const telaCadastro = await fetch(`${BASE}/convenios/cadastro`, {
      headers: { cookie: loginAdmin.cookie },
    })
    const htmlCadastro = await telaCadastro.text()
    conferir(telaCadastro.status === 200, `/convenios/cadastro responde ${telaCadastro.status}`)
    conferir(htmlCadastro.includes(`${MARCA} Operadora`), 'a operadora nova aparece na lista')

    const telaTabela = await fetch(`${BASE}/convenios/cadastro/${op.id}`, {
      headers: { cookie: loginAdmin.cookie },
    })
    const htmlTabela = await telaTabela.text()
    conferir(
      htmlTabela.includes('Histórico'),
      'a tabela negociada mostra o histórico junto — o valor faturado é o da data da execução',
    )
  } finally {
    await limpar(criados)
  }
}

async function limpar(criados: {
  usuarios: string[]
  convenios: string[]
  pacientes: string[]
  cadeiras: string[]
}): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query("set local session_replication_role = 'replica'")
    for (const id of criados.pacientes) {
      await c.query('delete from agendamento where paciente_id = $1', [id])
      await c.query('delete from paciente_convenio where paciente_id = $1', [id])
      await c.query('delete from audit_log where paciente_id = $1', [id])
      await c.query('delete from paciente where id = $1', [id])
    }
    for (const id of criados.cadeiras) {
      await c.query('delete from agendamento where cadeira_id = $1', [id])
      await c.query('delete from cadeira where id = $1', [id])
    }
    for (const id of criados.convenios) {
      await c.query('delete from preco_convenio where convenio_id = $1', [id])
      await c.query('delete from paciente_convenio where convenio_id = $1', [id])
      await c.query('delete from convenio where id = $1', [id])
    }
    for (const id of criados.usuarios) {
      await c.query('delete from audit_log where ator_id = $1 or entidade_id = $1::text', [id])
      await c.query('delete from profissional where usuario_id = $1', [id])
      await c.query('delete from usuario where id = $1', [id])
    }
    await c.query('commit')
    console.log('\nDados da verificação removidos.')
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
    console.log(
      falhas === 0
        ? '\n\x1b[32mCadastros administrativos conferidos.\x1b[0m'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error(e)
    await pool.end()
    process.exit(1)
  })
