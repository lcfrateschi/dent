import type { Perfil } from '@/lib/authz/politicas'
import type { NextAuthConfig } from 'next-auth'

/**
 * Configuração compartilhada, **segura para o runtime Edge**.
 *
 * O middleware do Next roda em Edge, onde não existem `node:crypto` nem `pg`.
 * Se ele importasse a config completa, arrastaria junto o scrypt, o TOTP e o
 * driver do Postgres, e o build quebraria com `UnhandledSchemeError`.
 *
 * Por isso a divisão do Auth.js v5:
 *   - este arquivo: sessão, páginas e callbacks. Sem provider, sem banco.
 *   - `middleware.ts`: usa só isto.
 *   - `config.ts`: adiciona o provider Credentials, que consulta o banco e
 *     verifica senha e TOTP. Roda em Node.
 *
 * Os callbacks ficam aqui porque o middleware precisa ler `perfil` e
 * `mfaAtivo` do token para decidir o redirecionamento.
 */

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      name?: string | null
      email?: string | null
      perfil: Perfil
      profissionalId: string | null
      mfaAtivo: boolean
    }
  }

  interface User {
    perfil: Perfil
    profissionalId: string | null
    mfaAtivo: boolean
  }
}

// A augmentação do JWT é em `@auth/core/jwt`, não em `next-auth/jwt`:
// o segundo é só um reexport e o TypeScript não resolve a interface por ele.
declare module '@auth/core/jwt' {
  interface JWT {
    perfil: Perfil
    profissionalId: string | null
    mfaAtivo: boolean
  }
}

export const configBase = {
  session: {
    strategy: 'jwt',
    // 8 horas: cobre um turno. Prontuário aberto não fica logado a noite toda.
    maxAge: 8 * 60 * 60,
  },
  pages: {
    signIn: '/entrar',
    error: '/entrar',
  },
  trustHost: true,
  // Preenchido em `config.ts`, que roda em Node e pode falar com o banco.
  providers: [],
  callbacks: {
    jwt({ token, user, trigger, session }) {
      if (user) {
        token.perfil = user.perfil
        token.profissionalId = user.profissionalId
        token.mfaAtivo = user.mfaAtivo
      }
      // Depois de configurar o MFA, o token é atualizado sem novo login.
      if (trigger === 'update' && session && typeof session === 'object') {
        const s = session as { mfaAtivo?: boolean }
        if (typeof s.mfaAtivo === 'boolean') token.mfaAtivo = s.mfaAtivo
      }
      return token
    },
    session({ session, token }) {
      session.user.id = token.sub ?? ''
      session.user.perfil = token.perfil
      session.user.profissionalId = token.profissionalId
      session.user.mfaAtivo = token.mfaAtivo
      return session
    },
  },
} satisfies NextAuthConfig
