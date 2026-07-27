import { decifrarSegredo } from '@/lib/auth/mfaSegredo'
import { gerarCodigoTotp, segundosRestantes, uriOtpauth } from '@/lib/auth/totp'
import { db, pool } from '@/lib/db'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { idDaClinicaDaDemo } from './clinicaDaDemo'
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

  /**
   * O contexto vem da clínica da demonstração, resolvida sem tenant (ver
   * `clinicaDaDemo.ts`). Duas consequências, ambas boas:
   *
   *   • funciona em banco com mais de uma clínica, onde antes a conexão nem era
   *     entregue;
   *   • o filtro `@demo.local` deixa de ser a ÚNICA barreira. Agora, além do
   *     domínio, a consulta só alcança a clínica da demonstração — e no dia em que
   *     a RLS estiver de pé isso passa a ser garantia do banco, não da cláusula
   *     `where`. Para um script que imprime segundo fator, cinto e suspensório é o
   *     mínimo.
   */
  const clinicaDemo = await idDaClinicaDaDemo()
  if (!clinicaDemo) {
    console.log('\nNenhum usuário de demonstração. Rode: npm run demo:preparar\n')
    return
  }

  const linhas = await comContextoDeClinica(clinicaDemo, () =>
    db
      .select({
        // O `id` entra porque ele é o dado associado autenticado da cifra: o segredo
        // de um usuário não decifra com o id de outro (ver `lib/auth/mfaSegredo.ts`).
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        segredo: usuario.mfaSecret,
        perfil: usuario.perfil,
      })
      .from(usuario)
      .where(like(usuario.email, '%@demo.local')),
  )

  if (linhas.length === 0) {
    console.log('\nNenhum usuário de demonstração. Rode: npm run demo:preparar\n')
    return
  }

  /**
   * Decifra antes de gerar. O segredo está cifrado em repouso desde que
   * `lib/auth/mfaSegredo.ts` existe, e texto claro legado continua aceito — é a
   * migração preguiçosa. Este script **não** recifra: ele é ferramenta de leitura, e
   * quem recifra é o login (`lib/auth/config.ts`), que já grava naquela linha.
   *
   * Um segredo que não decifra aqui vira aviso na linha do usuário, não exceção que
   * derruba o script: com quatro perfis, um segredo ilegível não deve esconder os
   * códigos dos outros três.
   */
  const comSegredo = linhas.map((l) => {
    if (!l.segredo) return { ...l, claro: null, erro: null }
    try {
      return { ...l, claro: decifrarSegredo(l.segredo, l.id).segredo, erro: null }
    } catch (e) {
      return { ...l, claro: null, erro: e instanceof Error ? e.message : String(e) }
    }
  })

  const comQr = process.argv.includes('--qr')
  const restam = segundosRestantes()

  console.log(`\nCódigos válidos por ${restam}s (a janela é de 30s):\n`)
  for (const l of comSegredo) {
    const rotulo = `  ${l.perfil.padEnd(11)} ${l.email.padEnd(26)}`
    if (!l.segredo) {
      console.log(`${rotulo} MFA não configurado`)
      continue
    }
    if (!l.claro) {
      console.log(`${rotulo} \x1b[31mSEGREDO ILEGÍVEL\x1b[0m — ${l.erro}`)
      continue
    }
    console.log(`${rotulo} ${gerarCodigoTotp(l.claro)}`)
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

  for (const l of comSegredo) {
    if (!l.claro) continue
    // O QR e o segredo impressos são o valor EM CLARO — é o que o autenticador do
    // celular precisa. Por isso as duas travas do topo (recusa produção, só
    // `@demo.local`) continuam sendo o que protege este script; cifrar em repouso não
    // muda nada aqui.
    const uri = uriOtpauth({ segredoBase32: l.claro, email: l.email })
    console.log(`\n${'─'.repeat(62)}\n  ${l.perfil.toUpperCase()} — ${l.email}`)
    console.log(`  segredo: ${l.claro}`)
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
