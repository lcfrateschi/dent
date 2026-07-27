import { db, pool } from '@/lib/db'
import { usuario } from '@/lib/db/schema'
import { idDaClinicaDaDemo } from '@/lib/demo/clinicaDaDemo'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { eq } from 'drizzle-orm'
import { cifrarSegredo, decifrarSegredo, ehTextoClaro } from './mfaSegredo'
import { gerarCodigoTotp, segundosRestantes } from './totp'

/**
 * Prova, por HTTP e com o segundo fator LIGADO, que a cifra do segredo TOTP funciona.
 *
 *   MFA_DESABILITADO=false docker compose up -d --no-deps app
 *   docker compose exec -T -e DATABASE_URL=<dono> app npx tsx lib/auth/verificar-cifra-mfa.ts
 *
 * ── Por que este script existe, e por que ele começa se recusando a rodar ───
 * O teste de unidade prova que `cifrar→decifrar` devolve o mesmo segredo. Não prova
 * que o LOGIN funciona: entre os dois há a leitura do banco, o AAD com o id do
 * usuário, e a recifragem preguiçosa.
 *
 * E há uma armadilha específica que tornaria tudo isto teatro: no ambiente de
 * desenvolvimento `MFA_DESABILITADO=true` faz o campo do código ser **ignorado**.
 * Com essa chave ligada, o login funciona com qualquer código — inclusive com o
 * segredo ilegível, inclusive sem segredo. Um "login verde" ali não mede nada.
 *
 * Por isso o passo 1 é uma **contraprova**: tenta entrar com um código deliberadamente
 * errado e EXIGE que falhe. Se passar, o script aborta dizendo que a verificação
 * seria vazia. Sem esse passo, este arquivo seria a sétima ocorrência do padrão que
 * já apareceu seis vezes neste projeto — o caso que passa pelo motivo errado.
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const EMAIL = 'admin@demo.local'
const SENHA = 'Facilident-Admin-2026'

let falhas = 0
function conferir(ok: boolean, texto: string): void {
  console.log(ok ? `   \x1b[32m✓\x1b[0m ${texto}` : `   \x1b[31m✗ ${texto}\x1b[0m`)
  if (!ok) falhas++
}

function juntarCookies(...listas: string[][]): string {
  const mapa = new Map<string, string>()
  for (const lista of listas) {
    for (const bruto of lista) {
      const par = bruto.split(';')[0]!
      mapa.set(par.slice(0, par.indexOf('=')), par)
    }
  }
  return [...mapa.values()].join('; ')
}

/** `true` quando o login foi aceito. Não lança: a falha é resultado, não erro. */
async function tentarEntrar(codigo: string): Promise<boolean> {
  const r1 = await fetch(`${BASE}/api/auth/csrf`)
  const c1 = juntarCookies(r1.headers.getSetCookie())
  const { csrfToken } = (await r1.json()) as { csrfToken: string }

  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c1 },
    body: new URLSearchParams({
      email: EMAIL,
      senha: SENHA,
      codigo,
      csrfToken,
      callbackUrl: BASE,
      json: 'true',
    }),
    redirect: 'manual',
  })

  return juntarCookies(c1.split('; '), r2.headers.getSetCookie()).includes('authjs.session-token')
}

async function segredoGravado(id: string): Promise<string> {
  const [l] = await db.select({ s: usuario.mfaSecret }).from(usuario).where(eq(usuario.id, id))
  if (!l?.s) throw new Error(`${EMAIL} não tem segredo de MFA. Rode demo:preparar.`)
  return l.s
}

async function main(): Promise<void> {
  console.log('\n═══ Cifra do segredo de MFA, por HTTP e com segundo fator ligado ═══\n')

  const clinica = await idDaClinicaDaDemo()
  if (!clinica) throw new Error('Clínica de demonstração ausente. Rode: npm run demo:preparar')

  await comContextoDeClinica(clinica, async () => {
    const [linha] = await db
      .select({ id: usuario.id })
      .from(usuario)
      .where(eq(usuario.email, EMAIL))
    if (!linha) throw new Error(`${EMAIL} não existe. Rode: npm run demo:preparar`)
    const id = linha.id

    // ── 1. A verificação vale algo? ─────────────────────────────────────────
    console.log('\x1b[36m1.\x1b[0m Contraprova: o segundo fator está de fato sendo exigido')
    const comCodigoErrado = await tentarEntrar('000000')
    conferir(
      !comCodigoErrado,
      comCodigoErrado
        ? 'ENTROU com código errado — MFA_DESABILITADO=true no servidor. TUDO ABAIXO SERIA VAZIO.'
        : 'login com código errado foi recusado',
    )
    if (comCodigoErrado) {
      console.log(
        '\n   Suba o app com o segundo fator ligado e rode de novo:\n' +
          '     MFA_DESABILITADO=false docker compose up -d --no-deps app\n',
      )
      return
    }

    // ── 2. Como o segredo está hoje ─────────────────────────────────────────
    console.log('\n\x1b[36m2.\x1b[0m Estado do segredo no banco')
    const antes = await segredoGravado(id)
    const eraTextoClaro = ehTextoClaro(antes)
    console.log(`   ${eraTextoClaro ? 'texto claro (legado)' : `cifrado (${antes.slice(0, 3)}…)`}`)
    const claroAntes = decifrarSegredo(antes, id).segredo
    conferir(/^[A-Z2-7]+$/.test(claroAntes), 'decifra para um segredo base32 plausível')

    // ── 3. Login de verdade ─────────────────────────────────────────────────
    console.log('\n\x1b[36m3.\x1b[0m Login com código derivado do segredo GRAVADO')
    if (segundosRestantes() <= 5) {
      // Digitar não é o problema; a janela de 30s virando entre gerar e postar é. O
      // login devolve a mesma mensagem para código expirado e senha errada, então
      // sem esta espera um vermelho aqui seria indistinguível de bug.
      await new Promise((r) => setTimeout(r, 6000))
    }
    conferir(await tentarEntrar(gerarCodigoTotp(claroAntes)), 'entrou')

    // ── 4. A migração preguiçosa aconteceu? ─────────────────────────────────
    console.log('\n\x1b[36m4.\x1b[0m Recifragem preguiçosa no login')
    const depois = await segredoGravado(id)
    conferir(!ehTextoClaro(depois), `o valor gravado agora é ${depois.slice(0, 3)}…`)
    conferir(
      decifrarSegredo(depois, id).segredo === claroAntes,
      'e decifra para o MESMO segredo — o autenticador do usuário continua valendo',
    )
    if (eraTextoClaro) {
      conferir(depois !== antes, 'o texto claro não está mais no banco')
    }

    // ── 5. O caminho cifrado, ponta a ponta ─────────────────────────────────
    console.log('\n\x1b[36m5.\x1b[0m Login com código derivado do segredo CIFRADO')
    // Este é o passo que o teste de unidade não alcança: o segredo agora está
    // cifrado no banco, e o login tem de decifrá-lo para verificar o código.
    if (segundosRestantes() <= 5) await new Promise((r) => setTimeout(r, 6000))
    conferir(await tentarEntrar(gerarCodigoTotp(decifrarSegredo(depois, id).segredo)), 'entrou')

    // ── 6. Contraprova do AAD: valor de outro usuário não serve ─────────────
    console.log('\n\x1b[36m6.\x1b[0m Contraprova: segredo cifrado de OUTRO usuário não abre esta conta')
    /**
     * O ataque: quem consegue um `UPDATE` copia para a linha do administrador o
     * próprio valor cifrado, de que já tem o autenticador no celular. Sem o AAD com o
     * id do usuário isso funciona, porque o texto cifrado não sabe de quem é.
     *
     * O `try/finally` restaura o valor original mesmo se algo estourar no meio —
     * deixar a conta de administrador com segredo alheio seria pior que não testar.
     */
    const original = depois
    const alheio = cifrarSegredo(claroAntes, '00000000-0000-4000-8000-0000000000aa')
    try {
      await db.update(usuario).set({ mfaSecret: alheio }).where(eq(usuario.id, id))
      if (segundosRestantes() <= 5) await new Promise((r) => setTimeout(r, 6000))
      const entrou = await tentarEntrar(gerarCodigoTotp(claroAntes))
      conferir(!entrou, entrou ? 'ENTROU — o AAD não está amarrando o valor à linha' : 'recusado')
    } finally {
      await db.update(usuario).set({ mfaSecret: original }).where(eq(usuario.id, id))
    }
    const restaurado = await segredoGravado(id)
    conferir(restaurado === original, 'o segredo original foi restaurado')

    // ── 7. E ainda entra, depois de tudo ────────────────────────────────────
    console.log('\n\x1b[36m7.\x1b[0m Depois da contraprova, a conta continua funcionando')
    // Sem este passo, o `finally` acima poderia ter restaurado um valor errado e
    // ninguém saberia até alguém tentar entrar de verdade.
    if (segundosRestantes() <= 5) await new Promise((r) => setTimeout(r, 6000))
    conferir(await tentarEntrar(gerarCodigoTotp(claroAntes)), 'entrou')
  })
}

main()
  .then(async () => {
    await pool.end()
    console.log(
      falhas === 0
        ? '\n\x1b[32m═══ Cifra do MFA verificada ═══\x1b[0m\n'
        : `\n\x1b[31m${falhas} falha(s).\x1b[0m\n`,
    )
    process.exit(falhas > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('\n✗', e instanceof Error ? e.message : e)
    await pool.end()
    process.exit(1)
  })
