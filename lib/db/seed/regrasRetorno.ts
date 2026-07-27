import { procedimento, regraRetorno } from '@/lib/db/schema'
import type { Executor } from '@/lib/tenant/executar'
import { and, eq, inArray, sql } from 'drizzle-orm'

/**
 * Regras de retorno de partida — o motor do recall.
 *
 * ── São valores de PARTIDA, como os mínimos de estoque ─────────────────────
 * Estão na ordem de grandeza de um consultório geral: profilaxia a cada seis meses,
 * controle de restauração em doze, manutenção de orto mensal. **O intervalo certo é
 * decisão clínica de cada dentista**, e a tela de configuração existe para isso. O
 * seed dá um ponto de partida que já funciona em vez de uma tabela vazia, que
 * deixaria a fila de retorno silenciosa e pareceria uma funcionalidade quebrada.
 *
 * ── Por que só alguns procedimentos ────────────────────────────────────────
 * Retorno programado não é para tudo. Extração não pede recall de rotina — pede
 * acompanhamento pontual, que é outro assunto. Regra demais gera fila que ninguém
 * consegue trabalhar, e fila que ninguém trabalha é pior que fila nenhuma: ela
 * ensina a equipe a ignorar o alerta.
 */
const PADROES: readonly {
  readonly codigo: string
  readonly meses: number
  readonly tipo: 'exame' | 'profilaxia' | 'periodontal' | 'ortodontia' | 'controle'
}[] = [
  { codigo: 'PREV-001', meses: 6, tipo: 'profilaxia' },
  { codigo: 'PREV-003', meses: 24, tipo: 'controle' },
  { codigo: 'PERIO-001', meses: 6, tipo: 'periodontal' },
  { codigo: 'PERIO-002', meses: 3, tipo: 'periodontal' },
  { codigo: 'ORTO-002', meses: 1, tipo: 'ortodontia' },
  { codigo: 'CONS-001', meses: 12, tipo: 'exame' },
]

export interface ResultadoRegras {
  readonly criadas: number
  /** Códigos que não existem no catálogo desta clínica. Visível, nunca silencioso. */
  readonly ausentes: readonly string[]
}

/**
 * Semeia as regras da clínica do CONTEXTO.
 *
 * O `where` por `clinica_id` não é redundante com a RLS: este seed roda por script,
 * e script roda como **dono das tabelas**, que ignora política. Sem o filtro, o
 * `select` traria o catálogo de todas as clínicas e a regra nasceria apontando para
 * o procedimento de outra — que o FK composto recusaria, com uma mensagem que não
 * fala de tenant. Aconteceu duas vezes neste projeto (uma delas em
 * `seedMateriais`, no mesmo formato).
 */
export async function seedRegrasRetorno(db: Executor): Promise<ResultadoRegras> {
  const daClinica = sql`app_clinica_id()`
  const codigos = PADROES.map((p) => p.codigo)

  const doCatalogo = await db
    .select({ id: procedimento.id, codigo: procedimento.codigo })
    .from(procedimento)
    .where(and(eq(procedimento.clinicaId, daClinica), inArray(procedimento.codigo, codigos)))

  const porCodigo = new Map(doCatalogo.map((p) => [p.codigo, p.id]))
  const ausentes = codigos.filter((c) => !porCodigo.has(c))

  const linhas = PADROES.filter((p) => porCodigo.has(p.codigo)).map((p) => ({
    procedimentoId: porCodigo.get(p.codigo)!,
    meses: p.meses,
    tipo: p.tipo,
  }))
  if (linhas.length === 0) return { criadas: 0, ausentes }

  await db
    .insert(regraRetorno)
    .values(linhas)
    // Idempotente, e **sem sobrescrever `meses`**: se a clínica ajustou o intervalo,
    // rodar o seed de novo não pode desfazer o ajuste. Mesma decisão de
    // `quantidade_minima` em `seedMateriais`.
    .onConflictDoNothing({ target: [regraRetorno.clinicaId, regraRetorno.procedimentoId] })

  return { criadas: linhas.length, ausentes }
}
