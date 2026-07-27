import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

/**
 * Descobrir de que clínica é quem está chegando — **antes** de haver contexto.
 *
 * ── O problema do ovo e da galinha ──────────────────────────────────────────
 * Toda consulta do sistema exige `app.clinica_id` no contexto. Mas as consultas
 * que **descobrem** a clínica não podem exigi-lo, porque é justamente o que elas
 * vão responder:
 *
 *   • login de staff — acha o usuário pelo e-mail; o tenant é derivado da
 *     credencial, então só é conhecido depois desta leitura;
 *   • sessão do portal — acha a sessão pelo hash do token do cookie;
 *   • webhook do WhatsApp — chega sem cookie nenhum; a única pista é o
 *     `phone_number_id` do número que recebeu a mensagem.
 *
 * Com `FORCE ROW LEVEL SECURITY` e a role de aplicação, essas três leituras
 * devolveriam zero linhas, e o sistema simplesmente não teria login. Não é um
 * detalhe de implementação: é o que separa uma RLS que parece pronta de uma que
 * sobe.
 *
 * ── A solução, e por que ela é estreita ────────────────────────────────────
 * Três funções `SECURITY DEFINER` no banco (`drizzle/0023` e `drizzle/0024`) que
 * rodam como o dono das tabelas — portanto acima da política — e devolvem **um
 * uuid e nada mais**. A superfície exposta é um identificador de clínica; não
 * passa por aqui `senha_hash`, não passa `mfa_secret`, não passa nome de paciente.
 *
 * O que deliberadamente NÃO foi feito: reescrever o login como função no banco.
 * Seria reimplementar em PL/pgSQL a verificação de senha, o TOTP e o cuidado com
 * tempo de resposta que `lib/auth/config.ts` já tem — e aí sim a função
 * `SECURITY DEFINER` precisaria ler as colunas de segredo.
 *
 * ── Resolver ≠ autorizar ───────────────────────────────────────────────────
 * Nenhuma função deste módulo autoriza coisa alguma. `clinicaDoLoginDeStaff`
 * responde "existe um usuário com este e-mail e ele é da clínica X" — não "esta
 * senha está certa". Quem valida credencial continua sendo quem já validava,
 * agora dentro do envelope da clínica devolvida. Confundir as duas coisas seria
 * transformar "sei de que clínica você é" em "pode entrar".
 */

/**
 * A clínica de um e-mail de staff, ou `null` se o e-mail não existe.
 *
 * `null` para e-mail inexistente é o caminho normal, não erro: é o que acontece
 * quando alguém erra o e-mail — e também quando alguém está testando uma lista de
 * e-mails. Quem chama tem de tratar os dois casos **do mesmo jeito visível**, sob
 * pena de o login passar a responder "este e-mail não existe aqui" para quem
 * pergunta. Ver o tratamento em `lib/auth/config.ts`.
 *
 * A função no banco não tem `LIMIT`: `usuario.email` é único GLOBAL (é essa
 * decisão que torna o tenant derivável da credencial), e se um dia a unicidade
 * for afrouxada isto estoura com "more than one row" em vez de escolher uma
 * clínica arbitrária e mandar a pessoa para o prontuário errado.
 */
export async function clinicaDoLoginDeStaff(email: string): Promise<string | null> {
  return uuidDaFuncao(sql`select clinica_do_login_de_staff(${email}) as id`)
}

/**
 * A clínica de uma sessão do portal, pelo hash do token.
 *
 * Recebe o **hash**, nunca o token. O token do cookie não deve circular por
 * função nenhuma além da que o transforma em hash: o banco guarda só o hash
 * justamente para que um vazamento de log ou de dump não entregue sessões vivas.
 *
 * Não valida expiração, revogação de conta nem paciente arquivado — isso continua
 * em `lib/portal/sessao.ts`, dentro do envelope, onde já estava e onde tem teste.
 * Aqui é só descobrir de quem é a sessão.
 */
export async function clinicaDaSessaoDoPortal(tokenHash: string): Promise<string | null> {
  return uuidDaFuncao(sql`select clinica_da_sessao_do_portal(${tokenHash}) as id`)
}

/**
 * A clínica dona de um número de WhatsApp (`phone_number_id` da Meta).
 *
 * É a única pista de tenant que o webhook tem. O `phone_number_id` chega em
 * `entry[].changes[].value.metadata` de todo evento — tanto de mensagem recebida
 * quanto de atualização de status.
 *
 * `null` quer dizer "nenhuma clínica declarou este número". Isso NÃO é motivo para
 * responder erro à Meta: ver o comentário no `route.ts` do webhook — quem responde
 * erro é reentregue, com backoff crescente, e um número não cadastrado
 * reentregaria para sempre.
 */
export async function clinicaDoNumeroDeWhatsapp(
  phoneNumberId: string,
): Promise<string | null> {
  return uuidDaFuncao(sql`select clinica_do_numero_de_whatsapp(${phoneNumberId}) as id`)
}

/**
 * Executa a consulta e devolve o uuid, ou `null`.
 *
 * O `db.execute` aqui roda **sem contexto de clínica**, e é o único lugar do
 * sistema onde isso é intencional. Funciona porque as três funções são
 * `SECURITY DEFINER`: a política não se aplica a elas. Qualquer outra consulta
 * neste estado estoura em `app_clinica_id()`, que é o que se quer.
 */
async function uuidDaFuncao(consulta: ReturnType<typeof sql>): Promise<string | null> {
  const r = await db.execute<{ id: string | null }>(consulta)
  // `db.execute` do node-postgres devolve o resultado do `pg`, com `.rows`.
  const linhas = (r as unknown as { rows: ReadonlyArray<{ id: string | null }> }).rows
  return linhas[0]?.id ?? null
}
