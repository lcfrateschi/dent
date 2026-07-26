import { db, pool } from '@/lib/db'
import { cadeira, clinica } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'
import { seedDentes } from './dentes'
import { seedProcedimentos } from './procedimentos'

/**
 * Dados de referência. Idempotente — pode rodar quantas vezes quiser.
 * NÃO cria paciente, usuário nem convênio: seed não inventa gente.
 *
 *   npm run db:seed
 */
async function seedClinica(): Promise<void> {
  await db
    .insert(clinica)
    .values({ id: 1, razaoSocial: 'Consultório Odontológico (configurar)' })
    .onConflictDoNothing({ target: clinica.id })
}

async function seedCadeiras(): Promise<number> {
  const cadeiras = [
    { nome: 'Consultório 1', ordem: 1 },
    { nome: 'Consultório 2', ordem: 2 },
  ]
  await db
    .insert(cadeira)
    .values(cadeiras)
    .onConflictDoUpdate({ target: cadeira.nome, set: { ordem: sql`excluded.ordem` } })
  return cadeiras.length
}

async function main(): Promise<void> {
  console.log('Populando dados de referência…\n')

  await seedClinica()
  console.log('  clinica       → 1 linha (singleton, configurar nos ajustes)')

  const dentes = await seedDentes(db)
  console.log(`  dente         → ${dentes} dentes FDI (32 permanentes + 20 decíduos)`)

  const procedimentos = await seedProcedimentos(db)
  console.log(`  procedimento  → ${procedimentos} procedimentos (codigo_tuss pendente, ver Fase 13)`)

  const cadeiras = await seedCadeiras()
  console.log(`  cadeira       → ${cadeiras} cadeiras`)

  console.log('\nPronto.')
}

main()
  .catch((e) => {
    console.error('\nFalha no seed:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
