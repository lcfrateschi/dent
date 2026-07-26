import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { paciente } from './pacientes'
import { procedimento } from './referencia'

/**
 * Operadora de plano odontológico.
 * O módulo TISS completo é a Fase 13; estas tabelas existem desde a Fase 1 para que
 * o modelo financeiro nasça sabendo que convênio existe. Ver CLAUDE.md, decisão 4.
 */
export const convenio = pgTable('convenio', {
  id: uuid('id').primaryKey().defaultRandom(),
  nome: text('nome').notNull().unique(),
  registroAns: varchar('registro_ans', { length: 20 }),
  cnpj: varchar('cnpj', { length: 14 }),
  /** Prazo contratual de pagamento, em dias, contado do envio da guia. */
  prazoPagamentoDias: smallint('prazo_pagamento_dias').notNull().default(30),
  /** Dia do mês em que a clínica fecha o lote de guias. */
  diaFechamento: smallint('dia_fechamento'),
  contatoNome: text('contato_nome'),
  contatoTelefone: varchar('contato_telefone', { length: 20 }),
  observacoes: text('observacoes'),
  ativo: boolean('ativo').notNull().default(true),
  criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
})

/** Tabela de preços negociada: quanto o convênio paga por cada procedimento. */
export const precoConvenio = pgTable(
  'preco_convenio',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    convenioId: uuid('convenio_id')
      .notNull()
      .references(() => convenio.id, { onDelete: 'cascade' }),
    procedimentoId: uuid('procedimento_id')
      .notNull()
      .references(() => procedimento.id, { onDelete: 'restrict' }),
    /** Valor que o convênio paga à clínica. */
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    /** Percentual coberto. O restante é coparticipação do paciente. */
    coberturaPct: numeric('cobertura_pct', { precision: 5, scale: 2 }).notNull().default('100'),
    /** Carência em dias a partir da adesão, se houver. */
    carenciaDias: smallint('carencia_dias').notNull().default(0),
    vigenciaInicio: date('vigencia_inicio').notNull(),
    vigenciaFim: date('vigencia_fim'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Um preço vigente por par convênio+procedimento a cada início de vigência.
    uniqueIndex('preco_convenio_uk').on(t.convenioId, t.procedimentoId, t.vigenciaInicio),
    check('preco_convenio_valor_nao_negativo', sql`${t.valor} >= 0`),
    check('preco_convenio_cobertura_faixa', sql`${t.coberturaPct} between 0 and 100`),
    check(
      'preco_convenio_vigencia_ordenada',
      sql`${t.vigenciaFim} is null or ${t.vigenciaFim} >= ${t.vigenciaInicio}`,
    ),
  ],
)

/** Vínculo do paciente com um convênio: a carteirinha. */
export const pacienteConvenio = pgTable(
  'paciente_convenio',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'cascade' }),
    convenioId: uuid('convenio_id')
      .notNull()
      .references(() => convenio.id, { onDelete: 'restrict' }),
    numeroCarteirinha: varchar('numero_carteirinha', { length: 40 }).notNull(),
    plano: text('plano'),
    /** Falso quando o paciente é dependente. O titular pode não ser paciente da clínica. */
    ehTitular: boolean('eh_titular').notNull().default(true),
    nomeTitular: text('nome_titular'),
    adesaoEm: date('adesao_em'),
    validade: date('validade'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('paciente_convenio_carteirinha_uk').on(t.convenioId, t.numeroCarteirinha),
    // Uma carteirinha ATIVA por paciente e operadora: duas tornariam indefinido
    // qual número vai na guia. Ver drizzle/0020.
    uniqueIndex('paciente_convenio_uma_ativa_uk')
      .on(t.pacienteId, t.convenioId)
      .where(sql`${t.ativo}`),
    index('paciente_convenio_paciente_idx').on(t.pacienteId),
    check('paciente_convenio_titular_nomeado', sql`${t.ehTitular} or ${t.nomeTitular} is not null`),
  ],
)
