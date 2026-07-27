import { registrarDoPaciente } from '@/lib/auditoria/registrar'
import { gerarTokenDeSessao, hashDoTokenDeSessao } from '@/lib/auth/convite'
import { db } from '@/lib/db'
import { paciente, pacienteConta, pacienteSessao } from '@/lib/db/schema'
import { definirClinicaDoContexto } from '@/lib/tenant/contexto'
import { clinicaDaSessaoDoPortal } from '@/lib/tenant/resolver'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { cookies, headers } from 'next/headers'

/**
 * Sessão do portal do paciente.
 *
 * ── O que separa este realm do staff ────────────────────────────────────────
 *
 * 1. **Cookie com outro nome.** `facilident_portal` não é `authjs.session-token`. Não há
 *    como um cookie de staff ser lido como sessão de paciente ou vice-versa,
 *    porque nem o nome nem o formato coincidem.
 * 2. **Outro mecanismo.** O staff usa Auth.js com JWT; o portal usa token opaco no
 *    banco. Não é gosto: é para que um erro de configuração de um lado não possa
 *    abrir o outro. Não existe segredo compartilhado entre os dois.
 * 3. **Outro tipo de retorno.** `SessaoPortal` não é `Ator`. Uma função que
 *    espera `Ator` não compila se receber sessão de paciente — o compilador passa
 *    a ser a primeira barreira contra misturar os realms.
 *
 * ── Por que token no banco e não JWT ────────────────────────────────────────
 * Para poder **revogar**. Paciente que perde o celular, clínica que precisa cortar
 * acesso: apagar a linha encerra na hora. JWT vale até expirar e não volta atrás.
 * O custo é uma consulta por requisição, e para um portal de consultório isso não
 * é custo — é o que compra a revogação.
 */

/** Nome do cookie. Diferente do staff de propósito — ver o comentário do módulo. */
export const COOKIE_PORTAL = 'facilident_portal'

/**
 * Duração da sessão.
 *
 * 12 horas, e não os 30 dias de um app de consumo. O portal mostra prontuário e
 * não tem segundo fator; a sessão curta é parte do que compensa isso. O paciente
 * entra, olha a consulta, e amanhã entra de novo.
 */
export const HORAS_DE_SESSAO = 12

/**
 * Identidade do paciente autenticado.
 *
 * Tipo próprio, incompatível com `Ator`. É a barreira de compilação contra passar
 * sessão de paciente para função de staff — e a razão de `pacienteId` ser o único
 * jeito de saber de quem é o dado no portal.
 */
export interface SessaoPortal {
  readonly sessaoId: string
  readonly contaId: string
  /**
   * **A única origem de verdade sobre de quem é o dado no portal.**
   *
   * Toda consulta de `lib/portal/` filtra por este valor, e nenhuma aceita
   * `pacienteId` por parâmetro. É a defesa contra IDOR: não existe caminho em que
   * um id vindo da URL decida o que é lido.
   */
  readonly pacienteId: string
  readonly nome: string
  readonly email: string
  /**
   * A clínica deste paciente.
   *
   * Vem da linha da CONTA, achada pelo hash do token do cookie — o mesmo caminho
   * que já responde "de quem é este dado". Não vem de parâmetro nem de subdomínio:
   * o paciente não escolhe a clínica em que está sendo lido, do mesmo jeito que não
   * escolhe o próprio `pacienteId`.
   */
  readonly clinicaId: string
}

async function origem(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers()
    const encaminhado = h.get('x-forwarded-for')
    const ip = encaminhado?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null
    return { ip: ip && ip.length <= 45 ? ip : null, userAgent: h.get('user-agent') }
  } catch {
    return { ip: null, userAgent: null }
  }
}

/**
 * Abre uma sessão e grava o cookie.
 *
 * Chamada só depois de a senha ter sido conferida. O token em claro existe apenas
 * aqui e no cookie; o banco recebe o hash.
 */
export async function abrirSessao(conta: {
  contaId: string
  pacienteId: string
}): Promise<void> {
  const { token, hash } = gerarTokenDeSessao()
  const agora = new Date()
  const expiraEm = new Date(agora.getTime() + HORAS_DE_SESSAO * 3_600_000)
  const { ip, userAgent } = await origem()

  const [criada] = await db
    .insert(pacienteSessao)
    .values({ contaId: conta.contaId, tokenHash: hash, expiraEm, ip, userAgent })
    .returning({ id: pacienteSessao.id })

  await db
    .update(pacienteConta)
    .set({ ultimoLoginEm: agora, bloqueadoAte: null })
    .where(eq(pacienteConta.id, conta.contaId))

  const jar = await cookies()
  jar.set(COOKIE_PORTAL, token, {
    httpOnly: true,
    // `secure` só fora de desenvolvimento: em `localhost` sem HTTPS o navegador
    // descartaria o cookie e o portal não funcionaria no ambiente de trabalho.
    secure: process.env.NODE_ENV === 'production',
    // `strict` e não `lax`: o portal não tem fluxo que dependa de vir de outro
    // site, e `strict` fecha CSRF por navegação de terceiros.
    sameSite: 'strict',
    path: '/',
    expires: expiraEm,
  })

  await registrarDoPaciente({
    acao: 'login',
    entidade: 'paciente_sessao',
    entidadeId: criada?.id ?? null,
    pacienteId: conta.pacienteId,
    detalhes: { realm: 'portal' },
  })
}

/**
 * Lê a sessão do cookie, ou `null`.
 *
 * Cada leitura confere no banco: expiração, revogação e conta ativa. Uma sessão
 * revogada para de funcionar na requisição seguinte, não no fim do prazo.
 */
export async function sessaoAtual(): Promise<SessaoPortal | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE_PORTAL)?.value
  if (!token) return null

  const hash = hashDoTokenDeSessao(token)

  /**
   * ── Resolver a clínica ANTES de ler a sessão ────────────────────────────────
   *
   * Mesmo ovo e mesma galinha do login do staff: sob `FORCE ROW LEVEL SECURITY`, a
   * consulta abaixo só devolve linha com `app.clinica_id` definido, e é ela que
   * descobre de quem é a sessão. Sem este passo, **todo paciente do portal ficaria
   * de fora** — e o sintoma seria "minha sessão expira na hora", não "a RLS".
   *
   * `clinica_da_sessao_do_portal` recebe o hash e devolve só um uuid. Ela ignora
   * expiração, conta desativada e paciente arquivado de propósito: essas três
   * verificações continuam abaixo, onde já estavam e onde têm teste. Mover
   * validação de sessão para dentro de uma função `SECURITY DEFINER` seria tirá-la
   * do lugar onde ela é lida e revisada.
   *
   * `definirClinicaDoContexto` (e não `comContextoDeClinica`) porque o tenant tem
   * de valer para **o resto da requisição**, não só para esta consulta: as
   * consultas de `lib/portal/consultas.ts` vêm depois e acertam a clínica sem
   * mencioná-la.
   */
  const clinicaDaSessao = await clinicaDaSessaoDoPortal(hash)
  if (!clinicaDaSessao) return null
  definirClinicaDoContexto(clinicaDaSessao)

  const [linha] = await db
    .select({
      sessaoId: pacienteSessao.id,
      contaId: pacienteConta.id,
      pacienteId: pacienteConta.pacienteId,
      nome: paciente.nome,
      nomeSocial: paciente.nomeSocial,
      email: pacienteConta.email,
      clinicaId: pacienteConta.clinicaId,
      expiraEm: pacienteSessao.expiraEm,
      contaAtiva: pacienteConta.ativo,
      statusPaciente: paciente.status,
    })
    .from(pacienteSessao)
    .innerJoin(pacienteConta, eq(pacienteConta.id, pacienteSessao.contaId))
    .innerJoin(paciente, eq(paciente.id, pacienteConta.pacienteId))
    .where(
      and(eq(pacienteSessao.tokenHash, hash), isNull(pacienteSessao.revogadaEm)),
    )

  if (!linha) return null
  if (linha.expiraEm.getTime() <= Date.now()) return null
  // Conta desativada ou paciente arquivado derrubam a sessão sem esperar o prazo.
  if (!linha.contaAtiva) return null
  if (linha.statusPaciente === 'arquivado') return null

  // `ultimo_uso_em` responde "de onde essa conta foi acessada", que é a pergunta
  // que aparece depois de uma suspeita. Sem `await` na leitura crítica? Não: um
  // UPDATE por requisição é aceitável e perder o rastro não é.
  await db
    .update(pacienteSessao)
    .set({ ultimoUsoEm: new Date() })
    .where(eq(pacienteSessao.id, linha.sessaoId))

  /**
   * Contraprova barata, e ela não é decoração.
   *
   * `clinica_da_sessao_do_portal` leu o tenant da `paciente_sessao`; a consulta
   * acima leu o tenant da `paciente_conta`, já sob a política. Se os dois
   * discordassem, alguma coisa estaria muito errada — sessão apontando para conta
   * de outra clínica é exatamente a forma que um vazamento entre clientes tomaria
   * neste caminho. Recusar é a única resposta defensável, e a linha de log existe
   * porque isto nunca deve acontecer em silêncio.
   */
  if (linha.clinicaId !== clinicaDaSessao) {
    console.error(
      '[portal] sessão e conta discordam da clínica — sessão recusada',
      { sessaoId: linha.sessaoId },
    )
    return null
  }

  return {
    sessaoId: linha.sessaoId,
    contaId: linha.contaId,
    pacienteId: linha.pacienteId,
    nome: linha.nomeSocial ?? linha.nome,
    email: linha.email,
    clinicaId: linha.clinicaId,
  }
}

/**
 * Exige sessão de paciente.
 *
 * Lança em vez de redirecionar, para poder ser usada em server action. As páginas
 * usam `exigirSessaoPagina`.
 */
export class SemSessaoPortal extends Error {
  constructor() {
    super('Sessão do portal ausente ou expirada.')
    this.name = 'SemSessaoPortal'
  }
}

export async function exigirSessao(): Promise<SessaoPortal> {
  const s = await sessaoAtual()
  if (!s) throw new SemSessaoPortal()
  return s
}

/** Encerra a sessão atual (o paciente clicou em sair). */
export async function encerrarSessao(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(COOKIE_PORTAL)?.value

  /**
   * `sairDoPortal()` (`lib/portal/acoes.ts`) chama esta função **sem** passar por
   * `exigirSessao()` antes — não há contexto de clínica nesta requisição.
   *
   * Sob RLS isso deixaria o `UPDATE` casar **zero linhas**, em silêncio: o cookie
   * seria apagado, a pessoa veria a tela de login, e a sessão continuaria **válida
   * no banco**. Quem tivesse capturado o token seguiria dentro depois de o paciente
   * clicar em "sair" — o oposto do que o botão promete. Nada nem ninguém acusaria
   * o erro, porque `UPDATE` que não casa linha não é exceção.
   *
   * Por isso o tenant é resolvido aqui também, a partir do próprio hash.
   */
  const hash = token ? hashDoTokenDeSessao(token) : null
  if (hash) {
    const clinicaDaSessao = await clinicaDaSessaoDoPortal(hash)
    if (clinicaDaSessao) definirClinicaDoContexto(clinicaDaSessao)
  }

  if (token && hash) {
    const [encerrada] = await db
      .update(pacienteSessao)
      .set({ revogadaEm: new Date() })
      .where(and(eq(pacienteSessao.tokenHash, hash), isNull(pacienteSessao.revogadaEm)))
      .returning({ id: pacienteSessao.id, contaId: pacienteSessao.contaId })

    if (encerrada) {
      const [conta] = await db
        .select({ pacienteId: pacienteConta.pacienteId })
        .from(pacienteConta)
        .where(eq(pacienteConta.id, encerrada.contaId))

      if (conta) {
        await registrarDoPaciente({
          acao: 'logout',
          entidade: 'paciente_sessao',
          entidadeId: encerrada.id,
          pacienteId: conta.pacienteId,
          detalhes: { realm: 'portal' },
        })
      }
    }
  }

  jar.delete(COOKIE_PORTAL)
}

/**
 * Revoga todas as sessões de uma conta.
 *
 * Usada pela clínica ao cortar acesso e pelo próprio paciente ao trocar a senha —
 * trocar senha sem derrubar as sessões abertas deixaria quem já estava dentro
 * continuar dentro, que é justamente o cenário do celular perdido.
 */
export async function revogarSessoes(
  contaId: string,
  revogadaPorUsuarioId: string | null = null,
): Promise<number> {
  const linhas = await db
    .update(pacienteSessao)
    .set({ revogadaEm: new Date(), revogadaPorUsuarioId })
    .where(and(eq(pacienteSessao.contaId, contaId), isNull(pacienteSessao.revogadaEm)))
    .returning({ id: pacienteSessao.id })
  return linhas.length
}

/**
 * Apaga sessões vencidas.
 *
 * Credencial vencida não é prontuário: pode ser apagada de verdade. O que fica é o
 * `audit_log` do acesso, que é o registro que interessa. Sem esta limpeza a tabela
 * cresce para sempre com linhas que não servem para nada.
 */
export async function limparSessoesVencidas(agora: Date = new Date()): Promise<number> {
  const linhas = await db
    .delete(pacienteSessao)
    .where(sql`${pacienteSessao.expiraEm} < ${agora.toISOString()}::timestamptz`)
    .returning({ id: pacienteSessao.id })
  return linhas.length
}

/** Sessões abertas de uma conta, para a clínica e para o próprio paciente verem. */
export async function sessoesAbertas(contaId: string) {
  return db
    .select({
      id: pacienteSessao.id,
      criadoEm: pacienteSessao.criadoEm,
      ultimoUsoEm: pacienteSessao.ultimoUsoEm,
      expiraEm: pacienteSessao.expiraEm,
      ip: pacienteSessao.ip,
      userAgent: pacienteSessao.userAgent,
    })
    .from(pacienteSessao)
    .where(and(eq(pacienteSessao.contaId, contaId), isNull(pacienteSessao.revogadaEm)))
    .orderBy(sql`${pacienteSessao.ultimoUsoEm} desc`)
}
