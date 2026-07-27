import { gerarHashSenha } from '@/lib/auth/senha'
import type { Executor } from '@/lib/tenant/executar'
import { usuario } from '@/lib/db/schema'
import { count } from 'drizzle-orm'

/**
 * Primeiro administrador, para não haver o problema do ovo e da galinha:
 * sem usuário não dá para entrar, e sem entrar não dá para criar usuário.
 *
 * REGRAS:
 *  - só roda se a tabela `usuario` estiver VAZIA;
 *  - **nunca em produção** — em produção o primeiro usuário é criado por
 *    um comando explícito do operador, com senha escolhida por ele;
 *  - MFA fica desativado, e o middleware obriga a configurá-lo no primeiro
 *    acesso, antes de qualquer outra tela.
 */

const EMAIL = 'admin@local'

export interface ResultadoUsuarioInicial {
  readonly criado: boolean
  readonly email?: string
  readonly senha?: string
  readonly motivo?: string
}

export async function seedUsuarioInicial(db: Executor): Promise<ResultadoUsuarioInicial> {
  if (process.env.NODE_ENV === 'production') {
    return { criado: false, motivo: 'ambiente de produção' }
  }

  const [linha] = await db.select({ total: count() }).from(usuario)
  if ((linha?.total ?? 0) > 0) {
    return { criado: false, motivo: 'já existem usuários' }
  }

  // Senha fixa e conhecida: é ambiente de desenvolvimento e ela precisa estar
  // no README. Passa na política (16 caracteres, variada, sem sequência).
  const senha = 'trocar-esta-senha-agora'

  await db.insert(usuario).values({
    nome: 'Administrador',
    email: EMAIL,
    senhaHash: await gerarHashSenha(senha),
    perfil: 'admin',
    mfaAtivo: false,
  })

  return { criado: true, email: EMAIL, senha }
}
