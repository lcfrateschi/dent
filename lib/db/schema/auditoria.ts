import { sql } from 'drizzle-orm'
import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/**
 * Trilha de auditoria. Dado de saúde é dado sensível na LGPD: **leitura também é evento
 * auditável**, não só escrita. Ver CLAUDE.md, decisão 6.
 *
 * Sem FK para `usuario`/`paciente` de propósito: o log tem que sobreviver à remoção do ator.
 * Append-only, garantido por trigger em drizzle/0001_constraints.sql.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** 'staff' | 'paciente' | 'sistema' — os dois realms de autenticação mais o automático. */
    atorTipo: varchar('ator_tipo', { length: 20 }).notNull(),
    atorId: uuid('ator_id'),
    atorEmail: text('ator_email'),
    acao: varchar('acao', { length: 30 }).notNull(),
    entidade: varchar('entidade', { length: 60 }).notNull(),
    entidadeId: text('entidade_id'),
    /**
     * Denormalizado de propósito: a pergunta "quem acessou o prontuário deste paciente?"
     * tem que ser respondível com um índice, sem join em 12 tabelas.
     */
    pacienteId: uuid('paciente_id'),
    ip: varchar('ip', { length: 45 }),
    userAgent: text('user_agent'),
    /** Contexto extra. NUNCA gravar dado clínico aqui — o log não é cópia do prontuário. */
    detalhes: jsonb('detalhes'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_paciente_idx').on(t.pacienteId, t.criadoEm),
    index('audit_ator_idx').on(t.atorId, t.criadoEm),
    index('audit_acao_idx').on(t.acao, t.criadoEm),
    index('audit_entidade_idx').on(t.entidade, t.entidadeId),
    check('audit_ator_tipo_valido', sql`${t.atorTipo} in ('staff', 'paciente', 'sistema')`),
  ],
)
