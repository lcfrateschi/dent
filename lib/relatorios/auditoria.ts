import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { auditLog, clinica, paciente, usuario } from '@/lib/db/schema'
import { addDias } from '@/lib/domain/datas'
import { FUSO_PADRAO, inicioDoDia } from '@/lib/domain/fuso'
import type { Periodo } from '@/lib/domain/periodo'
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'

/** Fuso da clínica — a mesma leitura que os outros relatórios fazem. */
async function fusoDaClinica(): Promise<string> {
  const [c] = await db.select({ fuso: clinica.fusoHorario }).from(clinica).limit(1)
  return c?.fuso ?? FUSO_PADRAO
}

/**
 * Leitura da trilha de auditoria.
 *
 * A trilha existe desde a Fase 1 e até agora ninguém podia **ver**. Isso importa
 * mais do que parece: um log que ninguém consulta não protege paciente nenhum —
 * ele só ocupa disco e dá a sensação de conformidade. A pergunta que esta tela
 * responde é a da LGPD: *quem acessou o prontuário deste paciente?*
 *
 * Duas coisas que a consulta NÃO faz:
 *
 * - **Não junta com `usuario` por FK**, porque não existe FK: o log sobrevive à
 *   remoção do usuário de propósito. O nome vem por `left join` e pode ser nulo —
 *   e nesse caso o `ator_email` gravado na linha é o que resta, o que já é o
 *   suficiente para identificar quem foi.
 * - **Não mostra `detalhes` cru na listagem.** O campo é metadado por contrato,
 *   mas é jsonb livre; jogá-lo na tela convidaria a gravar dado clínico ali.
 */

export interface LinhaAuditoria {
  readonly id: number
  readonly criadoEm: Date
  readonly atorTipo: string
  readonly atorEmail: string | null
  readonly atorNome: string | null
  readonly acao: string
  readonly entidade: string
  readonly entidadeId: string | null
  readonly pacienteId: string | null
  readonly pacienteNome: string | null
  readonly ip: string | null
}

export interface FiltroAuditoria {
  readonly pacienteId?: string
  readonly atorId?: string
  readonly acao?: string
  readonly entidade?: string
}

const POR_PAGINA = 100

export async function consultarAuditoria(
  ator: Ator,
  periodo: Periodo,
  filtro: FiltroAuditoria = {},
  pagina = 0,
): Promise<{ readonly linhas: readonly LinhaAuditoria[]; readonly total: number }> {
  const fuso = await fusoDaClinica()

  const inicio = inicioDoDia(periodo.de, fuso)
  const fim = inicioDoDia(addDias(periodo.ate, 1), fuso)

  const condicoes = [gte(auditLog.criadoEm, inicio), lt(auditLog.criadoEm, fim)]
  if (filtro.pacienteId) condicoes.push(eq(auditLog.pacienteId, filtro.pacienteId))
  if (filtro.atorId) condicoes.push(eq(auditLog.atorId, filtro.atorId))
  if (filtro.acao) condicoes.push(eq(auditLog.acao, filtro.acao))
  if (filtro.entidade) condicoes.push(eq(auditLog.entidade, filtro.entidade))

  const onde = and(...condicoes)

  const [linhas, [contagem]] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        criadoEm: auditLog.criadoEm,
        atorTipo: auditLog.atorTipo,
        atorEmail: auditLog.atorEmail,
        atorNome: usuario.nome,
        acao: auditLog.acao,
        entidade: auditLog.entidade,
        entidadeId: auditLog.entidadeId,
        pacienteId: auditLog.pacienteId,
        pacienteNome: paciente.nome,
        ip: auditLog.ip,
      })
      .from(auditLog)
      .leftJoin(usuario, eq(usuario.id, auditLog.atorId))
      .leftJoin(paciente, eq(paciente.id, auditLog.pacienteId))
      .where(onde)
      .orderBy(desc(auditLog.criadoEm))
      .limit(POR_PAGINA)
      .offset(pagina * POR_PAGINA),

    db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(onde),
  ])

  // Consultar a auditoria é ele mesmo um evento auditável. Sem isto, o único
  // acesso que a trilha não registraria seria o acesso à própria trilha.
  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'auditoria',
    pacienteId: filtro.pacienteId ?? null,
    detalhes: { de: periodo.de, ate: periodo.ate, filtro, resultados: contagem?.n ?? 0 },
  })

  return { linhas, total: contagem?.n ?? 0 }
}

/** Resumo por ação, para dar contexto antes da lista. */
export async function resumoDeAuditoria(periodo: Periodo) {
  const fuso = await fusoDaClinica()
  const inicio = inicioDoDia(periodo.de, fuso)
  const fim = inicioDoDia(addDias(periodo.ate, 1), fuso)

  return db
    .select({
      acao: auditLog.acao,
      n: sql<number>`count(*)::int`,
    })
    .from(auditLog)
    .where(and(gte(auditLog.criadoEm, inicio), lt(auditLog.criadoEm, fim)))
    .groupBy(auditLog.acao)
    .orderBy(sql`count(*) desc`)
}

/** Quem mais acessou prontuário no período. */
export async function atoresMaisAtivos(periodo: Periodo, limite = 10) {
  const fuso = await fusoDaClinica()
  const inicio = inicioDoDia(periodo.de, fuso)
  const fim = inicioDoDia(addDias(periodo.ate, 1), fuso)

  return db
    .select({
      atorId: auditLog.atorId,
      atorEmail: auditLog.atorEmail,
      atorNome: usuario.nome,
      eventos: sql<number>`count(*)::int`,
      pacientes: sql<number>`count(distinct ${auditLog.pacienteId})::int`,
    })
    .from(auditLog)
    .leftJoin(usuario, eq(usuario.id, auditLog.atorId))
    .where(
      and(
        gte(auditLog.criadoEm, inicio),
        lt(auditLog.criadoEm, fim),
        // Só eventos ligados a paciente: é a pergunta da LGPD.
        isNotNull(auditLog.pacienteId),
      ),
    )
    .groupBy(auditLog.atorId, auditLog.atorEmail, usuario.nome)
    .orderBy(sql`count(*) desc`)
    .limit(limite)
}
