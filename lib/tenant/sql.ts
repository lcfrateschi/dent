import { clinica } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'

/**
 * Como se lê a linha da própria clínica.
 *
 * ── O que estava errado antes ───────────────────────────────────────────────
 * Dez lugares faziam `.from(clinica).limit(1)` — **sem filtro nenhum**. Era
 * correto quando existia uma clínica só, e em multi-tenant devolve "alguma"
 * clínica, sem erro e sem log. O efeito de cada um era diferente e nenhum parecia
 * bug: fuso de outra clínica decidindo o que está vencido, base de comissão de
 * outra clínica na folha, horário de funcionamento de outra clínica na grade, e o
 * pior — **cabeçalho de outra clínica no atestado do paciente**.
 *
 * ── Por que `app_clinica_id()` e não um parâmetro ──────────────────────────
 * A correção óbvia seria `where(eq(clinica.id, clinicaId))`, com o id vindo de
 * parâmetro. Três coisas melhoram ao deixar o banco resolver:
 *
 * 1. **Não há parâmetro para errar.** Assinatura sem `clinicaId` é assinatura que
 *    não aceita a clínica errada — a mesma razão de `lib/portal/consultas.ts` não
 *    aceitar `pacienteId`.
 * 2. **Falha alto.** Sem contexto, `app_clinica_id()` estoura com uma mensagem que
 *    diz o que fazer. A versão com parâmetro, se o chamador passasse `undefined`,
 *    devolveria zero linhas — e todas essas dez leituras têm um `?? PADRÃO` na
 *    frente, então o sistema seguiria com fuso de São Paulo e horário comercial
 *    inventado, sem uma linha de log.
 * 3. **Uma verdade só.** `hoje_na_clinica()` no banco usa a mesma função, e é ela
 *    que a trigger de validade de lote consulta. Fuso resolvido no TS e fuso
 *    resolvido no SQL seriam duas implementações da mesma regra, livres para
 *    divergir.
 */
export const DA_CLINICA_ATUAL = eq(clinica.id, sql`app_clinica_id()`)

/**
 * "Hoje" no fuso da clínica, resolvido pelo BANCO.
 *
 * `hoje_na_clinica()` é a mesma função que a trigger de `movimento_estoque`
 * consulta para recusar lote vencido (`drizzle/0022`, passo 7). Usar a função em
 * vez de recalcular em TypeScript é o que garante que a tela e a trigger
 * concordem sobre que dia é hoje — e "que dia é hoje" é a regra que decide se um
 * lote pode ir na boca do paciente.
 *
 * `to_char` e não `::text`: a segunda forma obedece ao `DateStyle` do servidor, que
 * é configuração e pode não ser ISO. Um `31-07-2026` chegando onde o código espera
 * `2026-07-31` daria comparação de string silenciosamente errada — e o que ela
 * decide é o que está vencido.
 */
export const HOJE_NA_CLINICA = sql<string>`to_char(hoje_na_clinica(), 'YYYY-MM-DD')`
