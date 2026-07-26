import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  type AnyPgColumn,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { arcadaEnum, denticaoEnum, faceDenteEnum, ladoEnum, tipoDenteEnum } from './enums'

/**
 * Dados de referência dos 52 dentes em notação FDI. Populado por seed, nunca pela aplicação.
 *
 * Permanentes: 11–18, 21–28, 31–38, 41–48 (32)
 * Decíduos:    51–55, 61–65, 71–75, 81–85 (20)
 *
 * A chave é o próprio código FDI. Nunca renumerar para 1–32 — ver CLAUDE.md.
 */
export const dente = pgTable(
  'dente',
  {
    fdi: smallint('fdi').primaryKey(),
    denticao: denticaoEnum('denticao').notNull(),
    arcada: arcadaEnum('arcada').notNull(),
    lado: ladoEnum('lado').notNull(),
    quadrante: smallint('quadrante').notNull(),
    tipo: tipoDenteEnum('tipo').notNull(),
    /** Faces anatomicamente válidas para este dente. Fonte da validação em lib/domain/faces.ts. */
    facesValidas: faceDenteEnum('faces_validas').array().notNull(),
    /** Para decíduos: o permanente que o sucede. Null nos permanentes. */
    sucessorFdi: smallint('sucessor_fdi').references((): AnyPgColumn => dente.fdi),
    nome: text('nome').notNull(),
  },
  (t) => [
    check('dente_quadrante_valido', sql`${t.quadrante} between 1 and 8`),
    check(
      'dente_fdi_valido',
      sql`(${t.fdi} between 11 and 48 or ${t.fdi} between 51 and 85) and (${t.fdi} % 10) between 1 and 8`,
    ),
  ],
)

/**
 * Catálogo de procedimentos. É um *tipo*, não um evento — o evento é `item_plano`/`execucao`.
 * `valor_particular` é o preço de tabela da clínica; preço de convênio vive em `preco_convenio`.
 */
export const procedimento = pgTable(
  'procedimento',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Código TUSS/ANS. Opcional: procedimento só-particular pode não ter. */
    codigoTuss: varchar('codigo_tuss', { length: 20 }),
    /** Código interno da clínica, sempre presente e único. */
    codigo: varchar('codigo', { length: 30 }).notNull().unique(),
    nome: text('nome').notNull(),
    descricao: text('descricao'),
    especialidade: text('especialidade'),
    valorParticular: numeric('valor_particular', { precision: 10, scale: 2 }).notNull(),
    /** Se o procedimento é por dente (restauração) ou geral (profilaxia, documentação). */
    requerDente: boolean('requer_dente').notNull().default(false),
    /** Se exige indicar faces específicas (restauração sim, extração não). */
    requerFace: boolean('requer_face').notNull().default(false),
    /** Duração típica em minutos — usada para pré-preencher a agenda. */
    duracaoMinutos: smallint('duracao_minutos').notNull().default(30),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('procedimento_tuss_uk').on(t.codigoTuss).where(sql`${t.codigoTuss} is not null`),
    check('procedimento_valor_nao_negativo', sql`${t.valorParticular} >= 0`),
    // Não faz sentido exigir face sem exigir dente.
    check('procedimento_face_implica_dente', sql`not ${t.requerFace} or ${t.requerDente}`),
  ],
)
