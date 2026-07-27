import { assinatura, planoAssinatura } from '@/lib/db/schema'
import type { Executor } from '@/lib/tenant/executar'
import { eq, sql } from 'drizzle-orm'

/**
 * Garante que a clínica do contexto tenha contrato.
 *
 * ── Por que isto existe fora de `criar.ts` ──────────────────────────────────
 * `clinica:criar` (o onboarding) já cria a assinatura. Mas **`db:seed` e
 * `demo:preparar` também criam clínica**, e nasciam sem contrato — o que só apareceu
 * ao recriar o banco do zero: a `drizzle/0027` dá contrato às clínicas que **já
 * existiam** no momento em que ela roda, e num banco novo não existia nenhuma.
 *
 * Quem contou foi o caso 19 de `docker/verificar-assinatura.sql` ("toda clínica tem
 * assinatura"), com 2 clínicas sem. Ele existe justamente porque a decisão do
 * projeto é **destravar quando não há contrato**: falhar fechado congelaria uma
 * clínica por erro de contabilidade nossa, com o paciente na cadeira. O preço dessa
 * escolha é que clínica sem contrato fica invisível — nada quebra, ela só não é
 * cobrada. A verificação é o que substitui o congelamento, e por isso ela não pode
 * ficar vermelha "por enquanto": vermelha o tempo todo é o mesmo que desligada.
 *
 * Idempotente: `assinatura_uma_por_clinica_uk` garante uma por clínica, e aqui a
 * existência é conferida antes.
 */
export async function garantirAssinatura(
  tx: Executor,
  plano = 'essencial',
): Promise<'criada' | 'ja_existia'> {
  const [existente] = await tx
    .select({ id: assinatura.id })
    .from(assinatura)
    // `app_clinica_id()` e não um parâmetro: o tenant vem do contexto da transação,
    // como em todo o resto. Sem contexto isto estoura em vez de achar "alguma".
    .where(eq(assinatura.clinicaId, sql`app_clinica_id()`))
    .limit(1)
  if (existente) return 'ja_existia'

  const [linha] = await tx
    .select({ id: planoAssinatura.id })
    .from(planoAssinatura)
    .where(eq(planoAssinatura.codigo, plano))
    .limit(1)
  if (!linha) {
    throw new Error(
      `Plano "${plano}" não existe em plano_assinatura. A drizzle/0027 semeia o catálogo comercial.`,
    )
  }

  await tx.insert(assinatura).values({ planoId: linha.id, situacao: 'ativa' })
  return 'criada'
}
