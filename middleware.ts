import { configBase } from '@/lib/auth/base'
import NextAuth from 'next-auth'
import { NextResponse } from 'next/server'

// Importa a config BASE, não a completa: o middleware roda em Edge e a config
// completa arrastaria `pg` e `node:crypto`, que não existem lá.
const { auth } = NextAuth(configBase)

/**
 * Guarda de rotas.
 *
 * Duas responsabilidades, ambas de segurança:
 *
 * 1. **Rota de staff exige sessão.** A checagem de permissão fina fica nas
 *    server actions (`exigirPermissao`) — o middleware só barra quem não tem
 *    sessão nenhuma. Middleware não é o lugar de autorização de recurso: ele
 *    não conhece o objeto sendo acessado.
 *
 * 2. **MFA não configurado fica preso em /configurar-mfa.** Sem isto, um
 *    usuário novo navegaria pelo sistema inteiro sem segundo fator, e a
 *    exigência de MFA seria decorativa.
 */

// `/api/whatsapp` é público porque a Meta chama de fora — não existe sessão.
// A autenticação dele é o HMAC do cabeçalho X-Hub-Signature-256, verificado na
// própria rota (lib/mensageria/assinatura.ts). Sem assinatura válida, 403.
const PUBLICAS = ['/entrar', '/api/auth', '/api/whatsapp', '/design']

export default auth((req) => {
  const { pathname } = req.nextUrl
  const logado = !!req.auth?.user
  const mfaAtivo = req.auth?.user?.mfaAtivo === true

  if (pathname === '/') return NextResponse.next()
  if (PUBLICAS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // Quem já está logado não precisa ver a tela de login de novo.
    if (pathname === '/entrar' && logado) {
      return NextResponse.redirect(new URL(mfaAtivo ? '/pacientes' : '/configurar-mfa', req.url))
    }
    return NextResponse.next()
  }

  if (!logado) {
    const destino = new URL('/entrar', req.url)
    // Volta para onde a pessoa queria ir depois de entrar.
    destino.searchParams.set('proximo', pathname)
    return NextResponse.redirect(destino)
  }

  if (!mfaAtivo && pathname !== '/configurar-mfa') {
    return NextResponse.redirect(new URL('/configurar-mfa', req.url))
  }

  return NextResponse.next()
})

export const config = {
  // Exclui estáticos e o ícone; tudo mais passa pela guarda.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
}
