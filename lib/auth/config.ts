import { db } from '@/lib/db'
import { profissional, usuario } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { configBase } from './base'
import { exigirSegredoDeProducao } from './segredo'
import { verificarSenha } from './senha'
import { verificarCodigoTotp } from './totp'

/**
 * Config completa — roda em **Node**, não em Edge (usa `pg` e `node:crypto`).
 * O middleware usa `base.ts`, que é a parte segura para Edge.
 *
 * ── MFA em etapa ÚNICA ──────────────────────────────────────────────────────
 * O formulário pede e-mail, senha e código do autenticador de uma vez. O fluxo
 * de duas etapas (validar senha → guardar estado pendente → validar código)
 * exige um cookie intermediário que é justamente onde bugs de autenticação
 * moram. Uma etapa é menos código e menos superfície.
 *
 * Quem ainda não configurou MFA entra sem código e é levado para
 * `/configurar-mfa`. O middleware não o deixa sair de lá.
 *
 * ── Mensagem de erro sempre igual ───────────────────────────────────────────
 * Credencial inválida, usuário inexistente, usuário inativo e código errado
 * devolvem a MESMA resposta. Diferenciar diria a quem ataca se o e-mail existe.
 */

// Falha no boot, não na primeira tentativa de login.
exigirSegredoDeProducao()

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...configBase,
  providers: [
    Credentials({
      credentials: {
        email: {},
        senha: {},
        codigo: {},
      },
      async authorize(cred) {
        const email = String(cred?.email ?? '')
          .trim()
          .toLowerCase()
        const senha = String(cred?.senha ?? '')
        const codigo = String(cred?.codigo ?? '')

        if (!email || !senha) return null

        const [linha] = await db
          .select({
            id: usuario.id,
            nome: usuario.nome,
            email: usuario.email,
            senhaHash: usuario.senhaHash,
            perfil: usuario.perfil,
            mfaAtivo: usuario.mfaAtivo,
            mfaSecret: usuario.mfaSecret,
            senhaTemporaria: usuario.senhaTemporaria,
            ativo: usuario.ativo,
            profissionalId: profissional.id,
          })
          .from(usuario)
          .leftJoin(profissional, eq(profissional.usuarioId, usuario.id))
          .where(eq(sql`lower(${usuario.email})`, email))
          .limit(1)

        // Usuário inexistente: gasta o mesmo tempo de um hash real, para o
        // tempo de resposta não revelar quais e-mails existem.
        if (!linha) {
          await verificarSenha(senha, HASH_ISCA)
          return null
        }

        if (!linha.ativo) return null
        if (!(await verificarSenha(senha, linha.senhaHash))) return null

        // MFA já configurado: o código é obrigatório.
        if (linha.mfaAtivo) {
          if (!linha.mfaSecret) return null
          if (!verificarCodigoTotp(linha.mfaSecret, codigo)) return null
        }

        await db
          .update(usuario)
          .set({ ultimoLoginEm: new Date() })
          .where(eq(usuario.id, linha.id))

        return {
          id: linha.id,
          name: linha.nome,
          email: linha.email,
          perfil: linha.perfil,
          profissionalId: linha.profissionalId,
          mfaAtivo: linha.mfaAtivo,
          senhaTemporaria: linha.senhaTemporaria,
        }
      },
    }),
  ],
})

/**
 * Hash descartável com os mesmos parâmetros dos reais. Serve só para consumir
 * tempo de CPU quando o e-mail não existe, nivelando a resposta.
 * A senha original é irrelevante e não abre nada.
 */
const HASH_ISCA =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
