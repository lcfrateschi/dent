import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { profissional, usuario } from './acesso'
import { tipoDocumentoEnum } from './enums'
import { paciente } from './pacientes'
import { dente } from './referencia'

/**
 * Anexo do prontuário: radiografia, foto clínica, atestado, receita, PDF de orçamento.
 *
 * `storage_key` aponta para bucket PRIVADO. A aplicação só entrega URL assinada de vida
 * curta — nunca link público. Todo download passa por `audit_log` com ação 'exportacao'.
 */
export const documento = pgTable(
  'documento',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'restrict' }),
    tipo: tipoDocumentoEnum('tipo').notNull(),
    nome: text('nome').notNull(),
    descricao: text('descricao'),
    /** Dente retratado, quando aplicável (radiografia periapical). */
    denteFdi: smallint('dente_fdi').references(() => dente.fdi, { onDelete: 'set null' }),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    tamanhoBytes: bigint('tamanho_bytes', { mode: 'number' }).notNull(),
    /** Integridade do arquivo: detecta troca ou corrupção no storage. */
    sha256: varchar('sha256', { length: 64 }).notNull(),
    /** Data clínica do exame, que pode ser anterior ao upload. */
    dataExame: timestamp('data_exame', { withTimezone: true }),
    profissionalId: uuid('profissional_id').references(() => profissional.id, {
      onDelete: 'set null',
    }),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Exclusão é lógica. Prontuário tem guarda mínima de 20 anos (CFO) —
     * nada de DELETE físico antes disso.
     */
    removidoEm: timestamp('removido_em', { withTimezone: true }),
    motivoRemocao: text('motivo_remocao'),
  },
  (t) => [
    index('documento_paciente_idx').on(t.pacienteId, t.criadoEm),
    index('documento_tipo_idx').on(t.pacienteId, t.tipo),
    check('documento_tamanho_positivo', sql`${t.tamanhoBytes} > 0`),
    check(
      'documento_remocao_justificada',
      sql`${t.removidoEm} is null or ${t.motivoRemocao} is not null`,
    ),
  ],
)
