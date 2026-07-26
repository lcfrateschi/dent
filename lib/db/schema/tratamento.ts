import { sql } from 'drizzle-orm'
import {
  check,
  index,
  uniqueIndex,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { profissional } from './acesso'
import { agendamento } from './agenda'
import { convenio } from './convenios'
import { coberturaEnum, faceDenteEnum, statusItemPlanoEnum, statusPlanoEnum } from './enums'
import { paciente } from './pacientes'
import { dente, procedimento } from './referencia'

/**
 * O que se pretende fazer para um paciente. Vivo — muda conforme o tratamento avança.
 * Distinto do orçamento, que é um documento congelado dele. Ver GLOSSARIO.
 */
export const planoTratamento = pgTable(
  'plano_tratamento',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'restrict' }),
    profissionalId: uuid('profissional_id')
      .notNull()
      .references(() => profissional.id, { onDelete: 'restrict' }),
    titulo: text('titulo').notNull(),
    diagnostico: text('diagnostico'),
    observacao: text('observacao'),
    status: statusPlanoEnum('status').notNull().default('rascunho'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
    concluidoEm: timestamp('concluido_em', { withTimezone: true }),
  },
  (t) => [
    index('plano_paciente_idx').on(t.pacienteId, t.criadoEm),
    /*
     * Um plano ATIVO por paciente. O odontograma cria item no plano ativo; com
     * dois, o item cairia num plano imprevisível e o orçamento sairia incompleto.
     */
    uniqueIndex('plano_um_ativo_por_paciente')
      .on(t.pacienteId)
      .where(sql`${t.status} = 'ativo'`),
  ],
)

/**
 * Uma linha do plano: procedimento + dente + faces + valor + cobertura.
 * **É a unidade que tem status e que vira dinheiro.** Nunca colapsar com `procedimento`
 * (catálogo) nem com `execucao` (o evento).
 *
 * A coerência entre `procedimento.requer_dente`/`requer_face` e o que está preenchido aqui
 * é validada em lib/domain/itemPlano.ts — o banco não vê a outra tabela num CHECK.
 */
export const itemPlano = pgTable(
  'item_plano',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planoId: uuid('plano_id')
      .notNull()
      .references(() => planoTratamento.id, { onDelete: 'cascade' }),
    procedimentoId: uuid('procedimento_id')
      .notNull()
      .references(() => procedimento.id, { onDelete: 'restrict' }),
    /** Null para procedimentos gerais (profilaxia, documentação ortodôntica). */
    denteFdi: smallint('dente_fdi').references(() => dente.fdi, { onDelete: 'restrict' }),
    /** Faces atingidas. Validade anatômica checada em lib/domain/faces.ts. */
    faces: faceDenteEnum('faces').array(),

    cobertura: coberturaEnum('cobertura').notNull().default('particular'),
    /** Preenchido só quando cobertura = 'convenio'. */
    convenioId: uuid('convenio_id').references(() => convenio.id, { onDelete: 'restrict' }),
    /**
     * GANCHO DA FASE 13 (TISS). Sem FK porque `guia_tiss` ainda não existe —
     * a Fase 13 adiciona a tabela e a constraint, sem refatorar este modelo.
     * Ver CLAUDE.md, decisão 4.
     */
    guiaTissId: uuid('guia_tiss_id'),

    /** Valor acordado para esta linha. Congelado na aprovação, não recalculado. */
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    /** Parte que o paciente paga quando é convênio com coparticipação. */
    valorCoparticipacao: numeric('valor_coparticipacao', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),

    status: statusItemPlanoEnum('status').notNull().default('proposto'),
    ordem: smallint('ordem').notNull().default(0),
    observacao: text('observacao'),
    aprovadoEm: timestamp('aprovado_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('item_plano_plano_idx').on(t.planoId, t.ordem),
    index('item_plano_status_idx').on(t.status),
    index('item_plano_dente_idx').on(t.denteFdi),
    index('item_plano_guia_idx').on(t.guiaTissId).where(sql`${t.guiaTissId} is not null`),
    check('item_plano_valor_nao_negativo', sql`${t.valor} >= 0`),
    check('item_plano_copart_nao_negativa', sql`${t.valorCoparticipacao} >= 0`),
    // Cobertura e convênio precisam concordar, nas duas direções.
    check(
      'item_plano_convenio_coerente',
      sql`(${t.cobertura} = 'convenio') = (${t.convenioId} is not null)`,
    ),
    // Face sem dente é incoerente.
    check(
      'item_plano_face_exige_dente',
      sql`${t.faces} is null or cardinality(${t.faces}) = 0 or ${t.denteFdi} is not null`,
    ),
  ],
)

/** Registro de que um item de plano foi de fato realizado. */
export const execucao = pgTable(
  'execucao',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemPlanoId: uuid('item_plano_id')
      .notNull()
      .references(() => itemPlano.id, { onDelete: 'restrict' }),
    profissionalId: uuid('profissional_id')
      .notNull()
      .references(() => profissional.id, { onDelete: 'restrict' }),
    agendamentoId: uuid('agendamento_id').references(() => agendamento.id, {
      onDelete: 'set null',
    }),
    executadoEm: timestamp('executado_em', { withTimezone: true }).notNull(),
    observacao: text('observacao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('execucao_item_idx').on(t.itemPlanoId),
    index('execucao_profissional_periodo_idx').on(t.profissionalId, t.executadoEm),
  ],
)
