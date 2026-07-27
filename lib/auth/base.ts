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
 * Os callbacks ficam aqui porque o middleware precisa ler `perfil`, `mfaAtivo` e
 * `senhaTemporaria` do token para decidir o redirecionamento.
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
      /** Senha ditada pelo admin no cadastro: tem de ser trocada antes de usar o sistema. */
      senhaTemporaria: boolean
      /**
       * A clínica deste usuário. **Vem da credencial, nunca da URL.**
       *
       * Opcional no tipo por um motivo só: token emitido ANTES da Fase 17 não tem
       * o campo. Quem lê tem de tratar a ausência como "sem sessão" — ver
       * `atorAtual()` e o `logadoStaff` do middleware. Um token antigo não pode
       * virar "clínica qualquer".
       */
      clinicaId?: string
    }
  }

  interface User {
    perfil: Perfil
    profissionalId: string | null
    mfaAtivo: boolean
    senhaTemporaria: boolean
    /**
     * Opcional no tipo porque o `Session['user']` do Auth.js é a INTERSEÇÃO deste
     * `User` com o dele: declarar aqui como obrigatório tornava obrigatório lá, e
     * apagava justamente a possibilidade que precisa ser representada — a de um
     * token antigo sem tenant. O `authorize()` sempre preenche; quem lê sempre
     * confere.
     */
    clinicaId?: string
  }
}

// A augmentação do JWT é em `@auth/core/jwt`, não em `next-auth/jwt`:
// o segundo é só um reexport e o TypeScript não resolve a interface por ele.
declare module '@auth/core/jwt' {
  interface JWT {
    perfil: Perfil
    profissionalId: string | null
    mfaAtivo: boolean
    senhaTemporaria: boolean
    /** Ausente em token emitido antes da Fase 17 — tratado como sessão inválida. */
    clinicaId?: string
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
        token.senhaTemporaria = user.senhaTemporaria
        // O tenant é gravado no token no LOGIN e não é relido depois. Mudar a
        // clínica de um usuário existente é operação que não existe (seria mudar
        // de empregador), e reler a cada requisição custaria uma consulta por
        // requisição para um valor que não muda.
        token.clinicaId = user.clinicaId
      }
      // Depois de configurar o MFA ou de trocar a senha, o token é atualizado
      // sem novo login — senão a pessoa ficaria presa na própria tela que
      // acabou de concluir.
      if (trigger === 'update' && session && typeof session === 'object') {
        const s = session as { mfaAtivo?: boolean; senhaTemporaria?: boolean }
        if (typeof s.mfaAtivo === 'boolean') token.mfaAtivo = s.mfaAtivo
        if (typeof s.senhaTemporaria === 'boolean') token.senhaTemporaria = s.senhaTemporaria
      }
      return token
    },
    session({ session, token }) {
      session.user.id = token.sub ?? ''
      session.user.perfil = token.perfil
      session.user.profissionalId = token.profissionalId
      session.user.mfaAtivo = token.mfaAtivo
      session.user.senhaTemporaria = token.senhaTemporaria === true
      session.user.clinicaId = token.clinicaId
      return session
    },
  },
} satisfies NextAuthConfig
