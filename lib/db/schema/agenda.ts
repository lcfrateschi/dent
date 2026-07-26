import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { profissional, usuario } from './acesso'
import {
  canalConfirmacaoEnum,
  origemAgendamentoEnum,
  statusAgendamentoEnum,
} from './enums'
import { paciente } from './pacientes'

/** Cadeira/consultório. Recurso físico que limita atendimentos simultâneos. */
export const cadeira = pgTable('cadeira', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: text('nome').notNull().unique(),
  ordem: smallint('ordem').notNull().default(0),
  ativo: boolean('ativo').notNull().default(true),
})

/**
 * Reserva de profissional + cadeira + intervalo para um paciente.
 *
 * A garantia de não-sobreposição é uma EXCLUSION CONSTRAINT em SQL manual
 * (drizzle/0001_constraints.sql) — o ORM não expressa EXCLUDE. Há duas:
 * uma por profissional e uma por cadeira, ambas ignorando cancelados/faltas.
 */
export const agendamento = pgTable(
  'agendamento',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'restrict' }),
    profissionalId: uuid('profissional_id')
      .notNull()
      .references(() => profissional.id, { onDelete: 'restrict' }),
    cadeiraId: uuid('cadeira_id').references(() => cadeira.id, { onDelete: 'set null' }),
    inicio: timestamp('inicio', { withTimezone: true }).notNull(),
    fim: timestamp('fim', { withTimezone: true }).notNull(),
    status: statusAgendamentoEnum('status').notNull().default('agendado'),
    origem: origemAgendamentoEnum('origem').notNull().default('recepcao'),
    motivo: text('motivo'),
    observacao: text('observacao'),

    confirmadoEm: timestamp('confirmado_em', { withTimezone: true }),
    confirmadoVia: canalConfirmacaoEnum('confirmado_via'),
    /** Preenchido quando o paciente chega — distinto de confirmado. Ver GLOSSARIO. */
    chegouEm: timestamp('chegou_em', { withTimezone: true }),
    iniciadoEm: timestamp('iniciado_em', { withTimezone: true }),
    concluidoEm: timestamp('concluido_em', { withTimezone: true }),
    /** Obrigatório quando status = 'cancelado'. Validado em lib/domain/agendamento.ts. */
    motivoCancelamento: text('motivo_cancelamento'),
    canceladoEm: timestamp('cancelado_em', { withTimezone: true }),

    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agendamento_profissional_periodo_idx').on(t.profissionalId, t.inicio),
    index('agendamento_paciente_idx').on(t.pacienteId, t.inicio),
    index('agendamento_dia_idx').on(t.inicio),
    check('agendamento_intervalo_valido', sql`${t.fim} > ${t.inicio}`),
    check(
      'agendamento_cancelado_tem_motivo',
      sql`${t.status} <> 'cancelado' or ${t.motivoCancelamento} is not null`,
    ),
  ],
)

/**
 * Intervalo indisponível sem paciente: almoço, férias, manutenção, feriado.
 * `profissional_id` e `cadeira_id` nulos = bloqueio de toda a clínica.
 */
export const bloqueioAgenda = pgTable(
  'bloqueio_agenda',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profissionalId: uuid('profissional_id').references(() => profissional.id, {
      onDelete: 'cascade',
    }),
    cadeiraId: uuid('cadeira_id').references(() => cadeira.id, { onDelete: 'cascade' }),
    inicio: timestamp('inicio', { withTimezone: true }).notNull(),
    fim: timestamp('fim', { withTimezone: true }).notNull(),
    motivo: text('motivo').notNull(),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bloqueio_periodo_idx').on(t.inicio, t.fim),
    check('bloqueio_intervalo_valido', sql`${t.fim} > ${t.inicio}`),
  ],
)
