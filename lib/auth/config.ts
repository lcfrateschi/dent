import { db } from '@/lib/db'
import { profissional, usuario } from '@/lib/db/schema'
import { comContextoDeClinica } from '@/lib/tenant/contexto'
import { clinicaDoLoginDeStaff } from '@/lib/tenant/resolver'
import { eq, sql } from 'drizzle-orm'
import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { configBase } from './base'
import { mfaDesabilitado } from './mfa'
import { cifrarSegredo, decifrarSegredo } from './mfaSegredo'
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

        /**
         * ── Resolver a clínica ANTES de procurar o usuário ──────────────────
         *
         * Sob `FORCE ROW LEVEL SECURITY`, a consulta abaixo só devolve linha se
         * `app.clinica_id` estiver definido — e neste ponto ninguém sabe qual é a
         * clínica, porque descobrir isso é o que a consulta faz. Sem este passo o
         * login devolveria "credencial inválida" para todo mundo, inclusive para a
         * senha certa, e o sintoma não apontaria para a RLS.
         *
         * `clinica_do_login_de_staff` é `SECURITY DEFINER` e devolve só um uuid —
         * não autoriza nada. A verificação de senha e de TOTP continua exatamente
         * onde estava, agora dentro do envelope da clínica devolvida.
         */
        const clinicaId = await clinicaDoLoginDeStaff(email)

        /**
         * E-mail que não existe em clínica nenhuma.
         *
         * Trata igual a senha errada — mesma resposta, e o mesmo tempo de CPU do
         * hash de isca. **A assimetria que sobra é uma ida ao banco** (o e-mail
         * existente faz duas consultas, o inexistente faz uma), na casa de menos de
         * um milissegundo contra os ~100 ms do scrypt que os dois caminhos pagam.
         * Não é medição perfeita, e está escrito aqui para quem for medir de novo
         * não precisar redescobrir onde olhar.
         */
        if (!clinicaId) {
          await verificarSenha(senha, HASH_ISCA)
          return null
        }

        return await comContextoDeClinica(clinicaId, () => autorizarNaClinica(email, senha, codigo))
      },
    }),
  ],
})

/**
 * A autorização propriamente dita, já dentro do contexto da clínica.
 *
 * Separada em função para o `comContextoDeClinica` ter um `fn` claro. E o `await`
 * de cada consulta acontece **dentro** dela, o que não é detalhe: o construtor de
 * consulta do Drizzle é preguiçoso, e um `await` que escapasse para fora do
 * contexto sairia sem tenant. Isso já custou um caso vermelho em
 * `lib/tenant/verificar-contexto.ts`.
 */
async function autorizarNaClinica(email: string, senha: string, codigo: string) {
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
      clinicaId: usuario.clinicaId,
      profissionalId: profissional.id,
    })
    .from(usuario)
    .leftJoin(profissional, eq(profissional.usuarioId, usuario.id))
    .where(eq(sql`lower(${usuario.email})`, email))
    .limit(1)

  /**
   * Chegar aqui sem linha ficou RARO, mas não impossível — e o `return null` tem
   * de continuar existindo. `clinica_do_login_de_staff` já disse que o e-mail
   * existe, então "não achou" agora significa uma de duas coisas:
   *
   *   • corrida: o usuário foi apagado entre as duas consultas;
   *   • **a política de RLS escondeu a linha** — que é o que aconteceria se o
   *     `clinica_id` do usuário divergisse do contexto. Não deveria acontecer, e
   *     se acontecer o certo é recusar o login, não investigar aqui.
   *
   * O hash de isca continua para nivelar o tempo, pelo mesmo motivo de antes.
   */
  if (!linha) {
    await verificarSenha(senha, HASH_ISCA)
    return null
  }

  if (!linha.ativo) return null
  if (!(await verificarSenha(senha, linha.senhaHash))) return null

  /**
   * MFA já configurado: o código é obrigatório.
   *
   * A exceção é `MFA_DESABILITADO=true`, que só existe em desenvolvimento —
   * em produção `exigirSegredoDeProducao()` já derrubou o boot. Note que o
   * código não é COMPARADO com nada: não há valor mágico aceito pela
   * verificação TOTP, porque um valor mágico sobreviveria à condição de
   * ambiente falhar. Aqui o campo é simplesmente ignorado.
   */
  /**
   * `recifrar` sai daqui carregado quando o segredo lido estava em texto claro (ou
   * numa versão antiga da cifra) — a migração preguiçosa acontece no `UPDATE` de
   * `ultimoLoginEm`, mais abaixo, para não custar uma segunda ida ao banco.
   */
  let recifrar: string | undefined

  if (linha.mfaAtivo && !mfaDesabilitado()) {
    if (!linha.mfaSecret) return null

    let segredo: string
    try {
      const lido = decifrarSegredo(linha.mfaSecret, linha.id)
      segredo = lido.segredo
      if (lido.precisaRecifrar) recifrar = cifrarSegredo(lido.segredo, linha.id)
    } catch (e) {
      /**
       * Não decifrou: chave trocada, chave perdida, ou a linha foi alterada.
       *
       * Devolve `null` — a mesma resposta de senha errada e de código expirado — em
       * vez de propagar o erro, e a razão é a mesma que já governa este arquivo:
       * **o login não diz a quem tenta o que existe do outro lado**. Uma tela de erro
       * só nesta conta contaria que ela é diferente das outras.
       *
       * O problema não fica invisível: vai para o log do servidor com o id do
       * usuário. O que **não** vai é o valor cifrado — texto cifrado em log é
       * material para ataque offline no dia em que a chave vazar.
       *
       * Se isto aparecer para todos os usuários, é a chave; para um, é a linha. Nos
       * dois casos o caminho é reiniciar o MFA do usuário, que apaga o segredo.
       */
      console.error(
        `[auth] segredo de MFA ilegível para o usuário ${linha.id}:`,
        e instanceof Error ? e.message : e,
      )
      return null
    }

    if (!verificarCodigoTotp(segredo, codigo)) return null
  }

  await db
    .update(usuario)
    .set({ ultimoLoginEm: new Date(), ...(recifrar ? { mfaSecret: recifrar } : {}) })
    .where(eq(usuario.id, linha.id))

  return {
    id: linha.id,
    name: linha.nome,
    email: linha.email,
    perfil: linha.perfil,
    profissionalId: linha.profissionalId,
    mfaAtivo: linha.mfaAtivo,
    senhaTemporaria: linha.senhaTemporaria,
    clinicaId: linha.clinicaId,
  }
}

/**
 * Hash descartável com os mesmos parâmetros dos reais. Serve só para consumir
 * tempo de CPU quando o e-mail não existe, nivelando a resposta.
 * A senha original é irrelevante e não abre nada.
 */
const HASH_ISCA =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
