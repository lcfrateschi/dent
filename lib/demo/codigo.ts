import { gerarCodigoTotp, segundosRestantes, uriOtpauth } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import { usuario } from '@/lib/db/schema'
import { like } from 'drizzle-orm'
import QRCode from 'qrcode'

/**
 * Imprime o código de 6 dígitos dos usuários de DEMONSTRAÇÃO.
 *
 *   npm run demo:codigo            # o código de 6 dígitos de cada perfil
 *   npm run demo:codigo -- --qr    # + segredo e QR no terminal, para o celular
 *
 * Serve para testar o sistema sem um celular à mão. É um atalho legítimo num
 * ambiente de teste e seria um furo grave em produção — daí as duas travas:
 *
 *   1. **Recusa `NODE_ENV=production`.** Sem exceção.
 *   2. **Só lê usuários `@demo.local`.** O filtro está na consulta, não num `if`
 *      depois: nenhuma execução deste script chega perto do segredo de um usuário
 *      real, mesmo que alguém passe um argumento inesperado.
 *
 * Em produção, o segredo nasce no `/configurar-mfa` do próprio usuário e ninguém
 * — nem o administrador — consegue lê-lo pela aplicação.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('demo:codigo não roda em produção: ele imprime segundo fator.')
  }

  const linhas = await db
    .select({ nome: usuario.nome, email: usuario.email, segredo: usuario.mfaSecret, perfil: usuario.perfil })
    .from(usuario)
    .where(like(usuario.email, '%@demo.local'))

  if (linhas.length === 0) {
    console.log('\nNenhum usuário de demonstração. Rode: npm run demo:preparar\n')
    return
  }

  const comQr = process.argv.includes('--qr')
  const restam = segundosRestantes()

  console.log(`\nCódigos válidos por ${restam}s (a janela é de 30s):\n`)
  for (const l of linhas) {
    if (!l.segredo) {
      console.log(`  ${l.perfil.padEnd(11)} ${l.email.padEnd(26)} MFA não configurado`)
      continue
    }
    console.log(`  ${l.perfil.padEnd(11)} ${l.email.padEnd(26)} ${gerarCodigoTotp(l.segredo)}`)
  }

  if (restam <= 5) {
    // Digitar leva mais de 5 segundos. Avisar é melhor que a pessoa concluir que
    // a senha está errada — o login devolve a MESMA mensagem para tudo, de
    // propósito, e não diria que o problema foi o relógio.
    console.log(`\n  ⚠ este código expira em ${restam}s. Rode de novo e use o próximo.`)
  }

  if (!comQr) {
    console.log('\nPara cadastrar no celular (segredo + QR):  npm run demo:codigo -- --qr\n')
    return
  }

  for (const l of linhas) {
    if (!l.segredo) continue
    const uri = uriOtpauth({ segredoBase32: l.segredo, email: l.email })
    console.log(`\n${'─'.repeat(62)}\n  ${l.perfil.toUpperCase()} — ${l.email}`)
    console.log(`  segredo: ${l.segredo}`)
    console.log(await QRCode.toString(uri, { type: 'terminal', small: true }))
  }
  console.log(
    'Aponte a câmera do autenticador para o QR, ou digite o segredo à mão\n' +
      '(Google Authenticator, Authy, 1Password, Microsoft Authenticator).\n',
  )
}

main()
  .then(async () => {
    await pool.end()
  })
  .catch(async (e) => {
    console.error('\n✗', e instanceof Error ? e.message : e)
    await pool.end()
    process.exit(1)
  })
