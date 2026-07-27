import { db } from '@/lib/db'
import { clinica } from '@/lib/db/schema'
import { armazemDeClinica, clinicaDoContexto, gravarClinicaDoContexto } from '@/lib/tenant/armazem'
import { asc } from 'drizzle-orm'

/**
 * Qual clínica está falando nesta requisição.
 *
 * ── Por que `AsyncLocalStorage` e não parâmetro ─────────────────────────────
 * Passar `clinicaId` como parâmetro seria a versão disciplinar do isolamento: a
 * função aceitaria qualquer clínica e o acerto dependeria de o chamador mandar a
 * certa. É exatamente o desenho que `lib/portal/consultas.ts` rejeita para
 * `pacienteId` — **nenhuma função de lá aceita o id do paciente**, porque um id
 * que vem de fora é um id que a URL pode escolher. Aqui vale o mesmo: o tenant
 * não é argumento, é ambiente.
 *
 * ── Por que `enterWith` e não `run` ────────────────────────────────────────
 * O App Router não tem um lugar onde envelopar "a requisição": o middleware roda
 * em Edge (outro runtime, sem acesso a isto), e cada page, layout, server action
 * e route handler é um ponto de entrada próprio. Não existe `app.use()`.
 *
 * O que existe, e já está em todo ponto de entrada, é a leitura da sessão —
 * `exigirAtor()` no staff, `exigirSessao()` no portal. Elas rodam ANTES de
 * qualquer acesso a dado, porque é isso que elas são. Então é ali que o tenant
 * entra no contexto, com `enterWith`: o valor passa a valer para todo o resto
 * daquele fluxo assíncrono, sem precisar embrulhar o restante do handler numa
 * closure.
 *
 * `enterWith` tem má fama por poder "vazar" para irmãos quando chamado na raiz de
 * um contexto compartilhado. Numa requisição do Next isso não acontece: cada
 * requisição já nasce no seu próprio contexto assíncrono, e o que a chamada afeta
 * é a continuação daquela requisição.
 *
 * ── Por que o tenant NÃO é resolvido dentro do acesso ao banco ──────────────
 * Seria tentador: `db` pediria a sessão sozinho e ninguém precisaria lembrar de
 * nada. Só que ler a sessão do portal **é uma consulta ao banco**
 * (`paciente_sessao` → `paciente_conta`), então resolver o tenant dentro do
 * caminho da conexão entraria em recursão: consulta → precisa de tenant → lê
 * sessão → consulta → … O tenant tem de ser resolvido por quem autentica, uma vez,
 * antes.
 */

/**
 * Põe a clínica no contexto e a deixa valendo para o resto deste fluxo.
 *
 * Chamada por quem autenticou — `lib/authz/sessao.ts` (staff) e
 * `lib/portal/sessao.ts` (paciente). Não chame de outro lugar: definir o tenant
 * sem ter verificado credencial é o mesmo que não verificar credencial.
 */
export function definirClinicaDoContexto(clinicaId: string): void {
  gravarClinicaDoContexto(clinicaId)
}

/**
 * Roda `fn` com a clínica no contexto. Para script e laço, onde há um `fn` claro.
 *
 * ── A armadilha que esta assinatura fecha ───────────────────────────────────
 * A versão ingênua era `fn: () => T` devolvendo `armazemDeClinica.run(…, fn)`. Ela
 * parece certa e **está errada com o Drizzle**, porque o construtor de consulta é
 * preguiçoso: `db.insert(…)` não executa nada, devolve um objeto que executa
 * quando alguém faz `await`. Com `run` devolvendo esse objeto, o `await` acontecia
 * no chamador — **fora** do contexto — e a consulta saía sem tenant. Custou um
 * caso vermelho em `verificar-contexto.ts` para aparecer, e num caminho de escrita
 * teria custado uma linha na clínica errada.
 *
 * O `await fn()` DENTRO da função assíncrona é o que resolve: quem espera é código
 * que roda dentro do `run`, então a continuação herda o contexto.
 */
export async function comContextoDeClinica<T>(
  clinicaId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return armazemDeClinica.run({ clinicaId }, async () => await fn())
}

/**
 * A clínica do contexto, ou `null` quando não há.
 *
 * `null` é resposta legítima e acontece antes de autenticar: a tela de login, o
 * webhook do WhatsApp e a coleta de rotas do `next build` não têm sessão. Quem
 * precisa do tenant de verdade não deve consultar isto e decidir sozinho o que
 * fazer com o `null` — deve deixar o **banco** cobrar, via `app_clinica_id()`,
 * que estoura com mensagem dizendo o que fazer.
 */
export { clinicaDoContexto }

/**
 * ⚠️ ANDAIME — a primeira clínica do banco.
 *
 * Existe para os pontos que ainda não recebem o tenant da sessão: o
 * `salvarClinicaComAtor` (que edita "a" clínica) e os scripts. É correto enquanto
 * existe UMA clínica e passa a ser bug no dia em que existirem duas — por isso
 * `lib/db/index.ts` tem a trava que faz o app **parar** nesse dia, em vez de
 * continuar funcionando misturando dado de dois clientes.
 *
 * `orderBy(asc(id))` em vez de `limit(1)` sem ordem: sem ordenação o Postgres
 * devolve "alguma" linha e o resultado muda entre execuções — instabilidade que
 * ninguém consegue reproduzir.
 */
export async function clinicaAtual(): Promise<string> {
  const doContexto = clinicaDoContexto()
  if (doContexto) return doContexto

  const [linha] = await db
    .select({ id: clinica.id })
    .from(clinica)
    .orderBy(asc(clinica.id))
    .limit(1)
  if (!linha) {
    throw new Error(
      'Nenhuma clínica cadastrada. Rode o onboarding antes de usar o sistema.',
    )
  }
  return linha.id
}
