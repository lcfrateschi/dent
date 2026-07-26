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
import { evolucao } from './clinico'
import { etapaDocumentoEnum, tipoDocumentoEnum } from './enums'
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
    /** Momento clínico, para o antes/depois. Nulo em documento sem imagem. */
    etapa: etapaDocumentoEnum('etapa'),
    /** Evolução que este anexo documenta, quando foi anexado no atendimento. */
    evolucaoId: uuid('evolucao_id').references(() => evolucao.id, { onDelete: 'set null' }),
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
     *
     * Remover é de mão única (trigger em `drizzle/0011`): a correção de um envio
     * errado é remover com motivo e enviar de novo, não desfazer. Esconder e
     * reexibir um documento clínico sem rastro é exatamente o que a guarda legal
     * existe para impedir. O arquivo continua no storage; o que muda é que a rota
     * de download passa a recusá-lo.
     */
    removidoEm: timestamp('removido_em', { withTimezone: true }),
    motivoRemocao: text('motivo_remocao'),
    /** Quem removeu. Motivo sem autor não responde "quem decidiu isso?". */
    removidoPorId: uuid('removido_por_id').references(() => usuario.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('documento_paciente_idx').on(t.pacienteId, t.criadoEm),
    index('documento_tipo_idx').on(t.pacienteId, t.tipo),
    // A galeria do dente: radiografias daquele dente em ordem de exame.
    index('documento_dente_idx')
      .on(t.pacienteId, t.denteFdi, t.dataExame)
      .where(sql`${t.denteFdi} is not null and ${t.removidoEm} is null`),
    index('documento_evolucao_idx').on(t.evolucaoId),
    check('documento_tamanho_positivo', sql`${t.tamanhoBytes} > 0`),
    check(
      'documento_remocao_justificada',
      sql`${t.removidoEm} is null or ${t.motivoRemocao} is not null`,
    ),
    check('documento_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('documento_nome_nao_vazio', sql`length(btrim(${t.nome})) > 0`),
    check('documento_mime_nao_vazio', sql`length(btrim(${t.mimeType})) > 0`),
  ],
)
