import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { profissional } from './acesso'
import { agendamento } from './agenda'
import { severidadeAlertaEnum } from './enums'
import { paciente } from './pacientes'

/**
 * Questionário de saúde. VERSIONADA: refazer não sobrescreve, insere versão nova.
 * Comparar versões ao longo do tempo é clinicamente relevante.
 */
export const anamnese = pgTable(
  'anamnese',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'restrict' }),
    profissionalId: uuid('profissional_id').references(() => profissional.id, {
      onDelete: 'set null',
    }),
    versao: integer('versao').notNull(),
    /** Respostas do questionário. JSONB porque o formulário evolui sem migration. */
    respostas: jsonb('respostas').notNull(),
    /** Versão do formulário que gerou estas respostas — necessária para renderizar o histórico. */
    versaoFormulario: varchar('versao_formulario', { length: 20 }).notNull(),
    preenchidaEm: timestamp('preenchida_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('anamnese_paciente_versao_uk').on(t.pacienteId, t.versao),
    check('anamnese_versao_positiva', sql`${t.versao} >= 1`),
  ],
)

/**
 * Condição que precisa aparecer em TODA tela do paciente: alergia, anticoagulante,
 * diabetes, gravidez. Normalmente derivada da anamnese, mas editável à mão.
 */
export const alertaClinico = pgTable(
  'alerta_clinico',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'cascade' }),
    tipo: text('tipo').notNull(),
    descricao: text('descricao').notNull(),
    severidade: severidadeAlertaEnum('severidade').notNull().default('atencao'),
    /** Anamnese que originou o alerta, quando automático. */
    origemAnamneseId: uuid('origem_anamnese_id').references(() => anamnese.id, {
      onDelete: 'set null',
    }),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('alerta_paciente_ativo_idx').on(t.pacienteId).where(sql`${t.ativo}`)],
)

/**
 * Registro clínico de um atendimento. **APPEND-ONLY.**
 *
 * Não existe UPDATE nem DELETE — garantido por trigger no banco
 * (drizzle/0001_constraints.sql), não por disciplina no código.
 * Corrigir = inserir nova evolução com `retifica_id` apontando para a anterior.
 * A original permanece visível. Exigência do CFO; guarda mínima de 20 anos.
 */
export const evolucao = pgTable(
  'evolucao',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'restrict' }),
    profissionalId: uuid('profissional_id')
      .notNull()
      .references(() => profissional.id, { onDelete: 'restrict' }),
    agendamentoId: uuid('agendamento_id').references(() => agendamento.id, {
      onDelete: 'set null',
    }),
    texto: text('texto').notNull(),
    /** Assinatura do profissional. Sem isso a evolução é rascunho e não vale como prontuário. */
    assinadoEm: timestamp('assinado_em', { withTimezone: true }),
    /** SHA-256 de (texto + profissional + timestamp) — detecta adulteração fora da aplicação. */
    assinaturaHash: varchar('assinatura_hash', { length: 64 }),
    /**
     * Aponta para a evolução que esta retifica. Encadeamento, não substituição:
     * a retificada continua legível no prontuário.
     */
    retificaId: uuid('retifica_id').references((): AnyPgColumn => evolucao.id, {
      onDelete: 'restrict',
    }),
    motivoRetificacao: text('motivo_retificacao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('evolucao_paciente_idx').on(t.pacienteId, t.criadoEm),
    uniqueIndex('evolucao_retifica_uk').on(t.retificaId).where(sql`${t.retificaId} is not null`),
    check('evolucao_texto_nao_vazio', sql`length(btrim(${t.texto})) > 0`),
    check(
      'evolucao_retificacao_justificada',
      sql`${t.retificaId} is null or ${t.motivoRetificacao} is not null`,
    ),
    check(
      'evolucao_assinatura_completa',
      sql`(${t.assinadoEm} is null) = (${t.assinaturaHash} is null)`,
    ),
  ],
)
