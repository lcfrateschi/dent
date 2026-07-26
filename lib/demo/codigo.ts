import { gerarCodigoTotp, segundosRestantes } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import { usuario } from '@/lib/db/schema'
import { like } from 'drizzle-orm'

/**
 * Imprime o código de 6 dígitos dos usuários de DEMONSTRAÇÃO.
 *
 *   npm run demo:codigo
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

  const restam = segundosRestantes()
  console.log(`\nCódigos válidos por ${restam}s (a janela é de 30s):\n`)
  for (const l of linhas) {
    if (!l.segredo) {
      console.log(`  ${l.perfil.padEnd(11)} ${l.email.padEnd(26)} MFA não configurado`)
      continue
    }
    console.log(`  ${l.perfil.padEnd(11)} ${l.email.padEnd(26)} ${gerarCodigoTotp(l.segredo)}`)
  }
  console.log('')
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
