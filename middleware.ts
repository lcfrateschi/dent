import { configBase } from '@/lib/auth/base'
import NextAuth from 'next-auth'
import { NextResponse } from 'next/server'

// Importa a config BASE, não a completa: o middleware roda em Edge e a config
// completa arrastaria `pg` e `node:crypto`, que não existem lá.
const { auth } = NextAuth(configBase)

/**
 * Guarda de rotas dos DOIS realms.
 *
 * Três responsabilidades, todas de segurança:
 *
 * 1. **Rota de staff exige sessão de staff.** A checagem de permissão fina fica
 *    nas server actions (`exigirPermissao`) — o middleware só barra quem não tem
 *    sessão nenhuma. Middleware não é o lugar de autorização de recurso: ele não
 *    conhece o objeto sendo acessado.
 *
 * 2. **MFA não configurado fica preso em /configurar-mfa**, e senha temporária
 *    fica presa em /trocar-senha. Sem a primeira, um usuário novo navegaria pelo
 *    sistema inteiro sem segundo fator e a exigência de MFA seria decorativa.
 *    Sem a segunda, a senha que o admin ditou por telefone viraria definitiva.
 *
 * 3. **Os realms não se cruzam.** Rota do portal (`/meu/...`) nunca é liberada por
 *    sessão de staff, e rota de staff nunca é liberada por cookie do portal.
 *
 * ── Sobre o portal e o Edge ─────────────────────────────────────────────────
 * A sessão do portal é um token opaco conferido **no banco**, e o middleware roda
 * em Edge, sem `pg`. Então aqui a checagem é só a **presença** do cookie — e essa
 * limitação é o motivo de cada página e action do portal chamar `exigirSessao()`,
 * que consulta o banco de verdade.
 *
 * Isso é deliberado e vale dizer em voz alta: **o middleware não autentica o
 * portal**. Ele evita uma ida à tela para quem claramente não tem cookie. Quem
 * autentica é `lib/portal/sessao.ts`. Tratar a presença do cookie como prova de
 * autenticação seria aceitar qualquer string como sessão.
 */

// `/api/whatsapp` é público porque a Meta chama de fora — não existe sessão.
// A autenticação dele é o HMAC do cabeçalho X-Hub-Signature-256, verificado na
// própria rota (lib/mensageria/assinatura.ts). Sem assinatura válida, 403.
const PUBLICAS = ['/entrar', '/api/auth', '/api/whatsapp', '/design']

/**
 * Rotas do portal do paciente.
 *
 * São DOIS prefixos: as telas em `/meu` e as rotas de API em `/api/meu`. Faltava o
 * segundo, e o efeito foi o oposto de um vazamento — a rota de download do portal
 * caía na guarda do staff e redirecionava para `/entrar`, então o paciente não
 * conseguia baixar nem o próprio atestado. Encontrado por
 * `npm run portal:seguranca`.
 */
const PREFIXOS_PORTAL = ['/meu', '/api/meu']

/** Telas do portal abertas a quem ainda não tem sessão. */
const PORTAL_PUBLICAS = ['/meu/entrar', '/meu/convite']

const COOKIE_PORTAL = 'facilident_portal'

export default auth((req) => {
  const { pathname } = req.nextUrl
  const logadoStaff = !!req.auth?.user
  const mfaAtivo = req.auth?.user?.mfaAtivo === true
  const senhaTemporaria = req.auth?.user?.senhaTemporaria === true
  const temCookiePortal = req.cookies.has(COOKIE_PORTAL)

  // ── Portal do paciente ───────────────────────────────────────────────────
  if (PREFIXOS_PORTAL.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (PORTAL_PUBLICAS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
      return NextResponse.next()
    }
    // Sessão de STAFF não abre o portal. Um dentista logado que digitar /meu não
    // entra como paciente nenhum — não existe "paciente atual" numa sessão de
    // staff, e adivinhar um seria o próprio IDOR.
    if (!temCookiePortal) {
      // Rota de API responde 401, não redirecionamento: quem chama é `fetch`, e
      // um 307 para HTML faria o cliente tratar página de login como resposta.
      if (pathname.startsWith('/api/')) {
        return new NextResponse('Unauthorized', { status: 401 })
      }
      const destino = new URL('/meu/entrar', req.url)
      destino.searchParams.set('proximo', pathname)
      return NextResponse.redirect(destino)
    }
    return NextResponse.next()
  }

  // ── Staff ────────────────────────────────────────────────────────────────
  if (pathname === '/') return NextResponse.next()
  if (PUBLICAS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // Quem já está logado não precisa ver a tela de login de novo.
    if (pathname === '/entrar' && logadoStaff) {
      return NextResponse.redirect(new URL(mfaAtivo ? '/pacientes' : '/configurar-mfa', req.url))
    }
    return NextResponse.next()
  }

  if (!logadoStaff) {
    // Cookie do portal NÃO serve para rota de staff. O paciente que tentar
    // /pacientes vai para o login do staff, onde não tem credencial.
    const destino = new URL('/entrar', req.url)
    // Volta para onde a pessoa queria ir depois de entrar.
    destino.searchParams.set('proximo', pathname)
    return NextResponse.redirect(destino)
  }

  if (!mfaAtivo && pathname !== '/configurar-mfa') {
    return NextResponse.redirect(new URL('/configurar-mfa', req.url))
  }

  /**
   * Senha ditada pelo admin tem de ser trocada antes de qualquer outra coisa.
   *
   * A ordem importa: **MFA primeiro, senha depois**. Trocar a senha protegido
   * por segundo fator é melhor do que trocá-la com só a senha temporária — que é
   * justamente a credencial que passou pelo telefone de outra pessoa.
   */
  if (senhaTemporaria && pathname !== '/trocar-senha' && pathname !== '/configurar-mfa') {
    return NextResponse.redirect(new URL('/trocar-senha', req.url))
  }

  return NextResponse.next()
})

export const config = {
  // Exclui estáticos e o ícone; tudo mais passa pela guarda.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
}
