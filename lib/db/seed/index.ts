import { db, pool } from '@/lib/db'
import { cadeira, clinica } from '@/lib/db/schema'
import { garantirAssinatura } from '@/lib/onboarding/assinaturaPadrao'
import { comClinica, type Executor } from '@/lib/tenant/executar'
import { asc, sql } from 'drizzle-orm'
import { seedDentes } from './dentes'
import { seedMateriais } from './materiais'
import { seedProcedimentos } from './procedimentos'
import { seedRegrasRetorno } from './regrasRetorno'
import { seedUsuarioInicial } from './usuarioInicial'

/**
 * Dados de referência. Idempotente — pode rodar quantas vezes quiser.
 * NÃO cria paciente, usuário nem convênio: seed não inventa gente.
 *
 *   npm run db:seed
 */
/**
 * A clínica de desenvolvimento. Devolve o id — dele sai o contexto de tenant de
 * todo o resto do seed.
 *
 * Antes era um upsert de `id: 1`. Agora `clinica` é o tenant e o id é uuid
 * gerado, então "idempotente" mudou de sentido: não é mais "insere de novo a
 * mesma linha", é **"se já existe alguma clínica, use a primeira"**. Sem isso um
 * segundo `db:seed` criaria uma clínica nova a cada execução e o comando que
 * existe para ser repetível passaria a poluir o banco.
 */
async function seedClinica(): Promise<{ id: string; criada: boolean }> {
  const [existente] = await db.select({ id: clinica.id }).from(clinica).orderBy(asc(clinica.id)).limit(1)
  if (existente) return { id: existente.id, criada: false }

  const inseridas = await db
    .insert(clinica)
    .values({ razaoSocial: 'Consultório Odontológico (configurar)' })
    .returning({ id: clinica.id })
  const nova = inseridas[0]
  if (!nova) throw new Error('INSERT em clinica não devolveu id — RLS bloqueando a escrita?')
  return { id: nova.id, criada: true }
}

async function seedCadeiras(tx: Executor): Promise<number> {
  const cadeiras = [
    { nome: 'Consultório 1', ordem: 1 },
    { nome: 'Consultório 2', ordem: 2 },
  ]
  await tx
    .insert(cadeira)
    .values(cadeiras)
    // O alvo do conflito mudou junto com o índice: o nome da cadeira é único POR
    // CLÍNICA, não global. Com `target: cadeira.nome` o Postgres recusaria — não
    // existe mais índice único só em `nome` para casar com o ON CONFLICT.
    .onConflictDoUpdate({
      target: [cadeira.clinicaId, cadeira.nome],
      set: { ordem: sql`excluded.ordem` },
    })
  return cadeiras.length
}

async function main(): Promise<void> {
  console.log('Populando dados de referência…\n')

  const clinicaDoSeed = await seedClinica()
  console.log(
    `  clinica       → ${clinicaDoSeed.criada ? 'criada' : 'já existia'} (${clinicaDoSeed.id}) — configurar nos ajustes`,
  )

  // `dente` é referência GLOBAL: os 52 dentes da notação FDI são padrão
  // internacional e não pertencem a clínica nenhuma. Fica fora do envelope.
  const dentes = await seedDentes(db)
  console.log(`  dente         → ${dentes} dentes FDI (32 permanentes + 20 decíduos)`)

  // Daqui para baixo é dado DA CLÍNICA. O envelope define `app.clinica_id`, e é
  // dele que sai o `clinica_id` de cada linha, via DEFAULT — nenhum destes seeds
  // precisou aprender o que é tenant.
  await comClinica(clinicaDoSeed.id, async (tx) => {
  // Contrato da clínica. Sem isto ela nasce sem assinatura e fica invisível para a
  // cobrança — ver o comentário de `garantirAssinatura`.
  const contrato = await garantirAssinatura(tx)
  console.log(`  assinatura    → ${contrato === 'criada' ? 'plano essencial criado' : 'já existia'}`)

  const procedimentos = await seedProcedimentos(tx)
  console.log(
    `  procedimento  → ${procedimentos} procedimentos (36 com código TUSS oficial; 13 pendentes de decisão da clínica — ver dados/README.md)`,
  )

  const estoque = await seedMateriais(tx)
  console.log(
    `  material      → ${estoque.materiais} materiais + ${estoque.vinculos} vínculos de ficha técnica (sem saldo: estoque inicial é contagem física)`,
  )
  if (estoque.procedimentosAusentes.length > 0) {
    // Silêncio aqui seria baixa que nunca é proposta na tela de execução.
    console.log(
      `    ⚠ ficha técnica ignorada por referência inexistente: ${estoque.procedimentosAusentes.join(', ')}`,
    )
  }

  const regras = await seedRegrasRetorno(tx)
  console.log(
    `  regra_retorno → ${regras.criadas} regra(s) de retorno programado (valores de partida — o intervalo é decisão clínica)`,
  )
  if (regras.ausentes.length > 0) {
    // Silêncio aqui seria fila de retorno que nunca dispara para aquele procedimento.
    console.log(`    ⚠ código ausente no catálogo: ${regras.ausentes.join(', ')}`)
  }

  const cadeiras = await seedCadeiras(tx)
  console.log(`  cadeira       → ${cadeiras} cadeiras`)

  const admin = await seedUsuarioInicial(tx)
  if (admin.criado) {
    console.log('\n' + '─'.repeat(64))
    console.log('  PRIMEIRO ACESSO (só desenvolvimento)')
    console.log(`    e-mail: ${admin.email}`)
    console.log(`    senha:  ${admin.senha}`)
    console.log('    Deixe o campo de código em branco no primeiro login.')
    console.log('    A verificação em duas etapas será exigida logo em seguida.')
    console.log('─'.repeat(64))
  } else {
    console.log(`  usuario       → nenhum criado (${admin.motivo})`)
  }
  })

  console.log('\nPronto.')
}

main()
  .catch((e) => {
    console.error('\nFalha no seed:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
