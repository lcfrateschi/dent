import { pool } from '@/lib/db'
import { criarClinica, mudarSituacao } from './criar'

/**
 * Prova que o onboarding entrega uma clínica **usável**, não linhas no banco.
 *
 *   docker compose exec -T -e DATABASE_URL=<dono> app npm run clinica:verificar
 *
 * ── Por que o teste é por HTTP ──────────────────────────────────────────────
 * Porque "criou a clínica" e "a clínica funciona" são afirmações diferentes, e a
 * primeira é fácil de provar sem provar a segunda. Contar linhas no banco não diz
 * se o admin novo consegue entrar: falta a resolução de tenant pela credencial
 * (`clinica_do_login_de_staff`), o contexto por requisição, o middleware, a RLS.
 * Cada uma dessas peças pode estar errada com o banco perfeito.
 *
 * ── A limpeza, e por que ela é parcial ──────────────────────────────────────
 * No fim, a assinatura da clínica de teste é CANCELADA e o resumo diz o id. A
 * clínica **não é apagada**, e não é esquecimento: `clinica_id` é
 * `ON DELETE RESTRICT` de propósito, porque apagar clínica com prontuário dentro
 * não é operação de sistema (guarda de 20 anos, CFO). Escrever aqui um `DELETE`
 * em cascata seria construir exatamente a ferramenta que o schema recusa — e ela
 * ficaria no repositório, pronta para ser usada errado uma vez.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'

let falhas = 0

function conferir(ok: boolean, texto: string): void {
  console.log(ok ? `   \x1b[32m✓\x1b[0m ${texto}` : `   \x1b[31m✗ ${texto}\x1b[0m`)
  if (!ok) falhas++
}

function titulo(t: string): void {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

/** Dedupe de cookie por nome: o Auth.js manda `authjs.csrf-token` duas vezes. */
function juntar(...listas: string[][]): string {
  const porNome = new Map<string, string>()
  for (const lista of listas) {
    for (const bruto of lista) {
      const par = bruto.split(';')[0] ?? ''
      if (par) porNome.set(par.slice(0, par.indexOf('=')), par)
    }
  }
  return [...porNome.values()].join('; ')
}

async function entrar(email: string, senha: string): Promise<{ cookie: string; erro: string | null }> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntar(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    // `codigo` vazio: o admin recém-criado tem `mfa_ativo = false` e ainda vai
    // configurar o autenticador. É o primeiro acesso, e é o fluxo desenhado.
    body: new URLSearchParams({ email, senha, codigo: '', csrfToken, callbackUrl: BASE, json: 'true' }),
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
 * Pergunta ao app, não ao `process.env` deste script — os dois divergem, e isso já
 * fez um agente reprovar uma trava que estava desligada do outro lado. Quem decide
 * é quem aplica a regra; o sinal observável é o aviso na tela de login.
 */
async function servidorSemMfa(): Promise<boolean> {
  const html = await (await fetch(`${BASE}/entrar`)).text()
  return html.includes('duas etapas desligada')
}

async function destinoDe(cookie: string, caminho: string): Promise<string> {
  const r = await fetch(`${BASE}${caminho}`, { headers: { cookie }, redirect: 'manual' })
  if (r.status === 200) return caminho
  return r.headers.get('location') ?? `status ${r.status}`
}

/**
 * CNPJ novo a cada execução, com dígitos verificadores calculados.
 *
 * Um CNPJ fixo aqui foi erro na primeira versão: a execução seguinte encontrava a
 * clínica da anterior, `criada` vinha `false`, e o caso 1 reprovava sem nada estar
 * errado — um teste que só passa uma vez ensina a ignorá-lo. E não dá para apagar
 * a clínica depois (`ON DELETE RESTRICT`, de propósito), então a saída é não
 * reusar o CNPJ.
 */
function cnpjSintetico(marca: string): string {
  const base = ('1144' + marca.padStart(6, '0') + '0001').slice(0, 12)
  const digito = (nums: string, pesoInicial: number): number => {
    let peso = pesoInicial
    let soma = 0
    for (const c of nums) {
      soma += Number(c) * peso
      peso = peso === 2 ? 9 : peso - 1
    }
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  const d1 = digito(base, 5)
  const d2 = digito(base + d1, 6)
  return `${base}${d1}${d2}`
}

async function main(): Promise<void> {
  console.log('\n═══ Onboarding: a clínica nova é usável? ═══')

  const marca = Date.now().toString().slice(-6)
  const cnpj = cnpjSintetico(marca)
  const email = `onb-${marca}@teste.local`

  titulo('1. Criar a clínica')
  const r = await criarClinica({
    razaoSocial: `Clínica Onboarding ${marca} Ltda`,
    cnpj,
    plano: 'profissional',
    adminNome: 'Dra. Onboarding de Teste',
    adminEmail: email,
  })
  if (!r.ok) {
    console.error(`   \x1b[31m✗ ${r.mensagem}\x1b[0m`)
    falhas++
    return
  }
  conferir(r.criada, `criada: ${r.clinicaId}`)
  const senha = r.senhaTemporaria
  if (!senha) {
    conferir(false, 'senha temporária não veio — sem ela não há como provar o login')
    return
  }

  titulo('2. Idempotência: rodar de novo não duplica nem gera senha nova')
  const r2 = await criarClinica({
    razaoSocial: `Clínica Onboarding ${marca} Ltda`,
    cnpj,
    plano: 'profissional',
    adminNome: 'Dra. Onboarding de Teste',
    adminEmail: email,
  })
  conferir(r2.ok && !r2.criada, 'reconheceu a clínica existente')
  conferir(r2.ok && r2.clinicaId === r.clinicaId, 'devolveu o MESMO id')
  conferir(
    r2.ok && r2.senhaTemporaria === undefined,
    'NÃO gerou senha nova — senão a que o cliente já recebeu deixaria de valer',
  )

  titulo('3. O admin novo ENTRA por HTTP')
  const sessao = await entrar(email, senha)
  conferir(sessao.erro === null, `login aceito${sessao.erro ? ` (${sessao.erro})` : ''}`)

  const destino = await destinoDe(sessao.cookie, '/pacientes')

  /**
   * ── Qual é a primeira tela, e por que a pergunta depende do ambiente ────────
   *
   * O admin nasce com `mfa_ativo = false` e `senha_temporaria = true`, então há
   * DUAS travas de primeiro acesso e a ordem fechada do projeto é **MFA primeiro,
   * senha depois**. Eu escrevi este caso exigindo `/configurar-mfa` e ele reprovou
   * com `/trocar-senha` — e o sistema estava certo: o serviço de desenvolvimento
   * roda com `MFA_DESABILITADO=true`, então a trava do MFA não se aplica e sobra a
   * da senha.
   *
   * A correção não é aceitar as duas e seguir a vida: isso deixaria de detectar o
   * MFA parar de ser exigido em produção. O caso **pergunta ao servidor** qual é o
   * ambiente e cobra o destino exato de cada um.
   *
   * O que ele nunca aceita, nos dois ambientes: `/pacientes` (entrou direto no
   * prontuário com senha que circulou por telefone) e `/entrar` (a sessão não valeu).
   */
  const semMfa = await servidorSemMfa()
  const esperado = semMfa ? '/trocar-senha' : '/configurar-mfa'
  conferir(
    destino === esperado,
    `a primeira tela é ${esperado}, não o prontuário` +
      `${semMfa ? ' (servidor com MFA desligado — só a trava da senha se aplica)' : ''}` +
      ` (obtido: ${destino})`,
  )
  conferir(destino !== '/pacientes', 'NÃO cai direto no prontuário com senha temporária')
  conferir(destino !== '/entrar', 'a sessão vale de verdade (não voltou para o login)')

  titulo('4. A clínica nova está isolada e com contrato ativo')
  const status = await fetch(`${BASE}${esperado}`, { headers: { cookie: sessao.cookie } })
  conferir(status.status === 200, `${esperado} responde 200 (obtido ${status.status})`)

  titulo('5. Suspender bloqueia escrita pela TELA, não só no psql')
  const sus = await mudarSituacao(r.clinicaId, 'suspensa', 'verificação automatizada')
  conferir(sus.ok, sus.mensagem)
  const semMotivo = await mudarSituacao(r.clinicaId, 'suspensa', '   ')
  conferir(!semMotivo.ok, `suspender sem motivo é recusado: "${semMotivo.mensagem.slice(0, 60)}…"`)

  titulo('6. Mesmo suspensa, a sessão continua LENDO')
  const aindaLe = await destinoDe(sessao.cookie, esperado)
  conferir(
    aindaLe === esperado,
    `a clínica suspensa não perde o acesso de leitura (obtido: ${aindaLe})`,
  )

  await mudarSituacao(r.clinicaId, 'cancelada', 'fim da verificação automatizada')
  console.log(
    `\n   Clínica de teste ${r.clinicaId} deixada com assinatura CANCELADA.` +
      '\n   Não é apagada de propósito: clinica_id é ON DELETE RESTRICT, e prontuário' +
      '\n   tem guarda de 20 anos. Apagar clínica não é operação de sistema.',
  )
}

main()
  .catch((e) => {
    console.error('\nFalha:', e instanceof Error ? e.message : e)
    falhas++
  })
  .finally(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32m═══ Onboarding verificado ═══\x1b[0m'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
