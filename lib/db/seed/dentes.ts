import { catalogoDentes } from '@/lib/domain/dentes'
import type { Db } from '@/lib/db'
import { dente } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

/**
 * Popula os 52 dentes FDI a partir de `lib/domain/dentes.ts` — uma única fonte
 * para o banco e para a validação de faces, para não divergirem.
 *
 * Idempotente. Insere primeiro os permanentes: os decíduos referenciam o sucessor
 * permanente por FK, então a ordem importa.
 */
export async function seedDentes(db: Db): Promise<number> {
  const catalogo = catalogoDentes()
  const permanentes = catalogo.filter((d) => d.denticao === 'permanente')
  const deciduos = catalogo.filter((d) => d.denticao === 'deciduo')

  for (const lote of [permanentes, deciduos]) {
    await db
      .insert(dente)
      .values(
        lote.map((d) => ({
          fdi: d.fdi,
          denticao: d.denticao,
          arcada: d.arcada,
          lado: d.lado,
          quadrante: d.quadrante,
          tipo: d.tipo,
          facesValidas: [...d.facesValidas],
          sucessorFdi: d.sucessorFdi,
          nome: d.nome,
        })),
      )
      .onConflictDoUpdate({
        target: dente.fdi,
        set: {
          facesValidas: sql`excluded.faces_validas`,
          nome: sql`excluded.nome`,
          sucessorFdi: sql`excluded.sucessor_fdi`,
        },
      })
  }

  return catalogo.length
}
