import { sql } from 'drizzle-orm'
import {
  foreignKey,
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
import { clinicaId } from './tenant'

/**
 * Operadora de plano odontológico.
 * O módulo TISS completo é a Fase 13; estas tabelas existem desde a Fase 1 para que
 * o modelo financeiro nasça sabendo que convênio existe. Ver CLAUDE.md, decisão 4.
 */
export const convenio = pgTable(
  'convenio',
  {
    clinicaId: clinicaId(),
  id: uuid('id').primaryKey().defaultRandom(),
  // O nome era único global. Duas clínicas atendem a MESMA operadora, cada uma
  // com a sua tabela negociada — a unicidade virou por clínica, no índice abaixo.
  nome: text('nome').notNull(),
  registroAns: varchar('registro_ans', { length: 20 }),
  /**
   * O código DESTA clínica NESTA operadora, como ela o atribuiu. Obrigatório no XML TISS.
   *
   * Fica aqui e não em `clinica` porque é um código **por operadora**: a mesma clínica é
   * o prestador 4711 numa e 90233-2 na outra. Como `convenio` já é por clínica (Fase 17),
   * a coluna aqui já significa o par certo, sem tabela de ligação.
   *
   * Sem CHECK de formato, ao contrário do CNES: cada operadora usa o seu, com letras e
   * hífen. Um CHECK aqui seria convenção nossa recusando dado legítimo do cliente.
   */
  codigoPrestador: varchar('codigo_prestador', { length: 20 }),
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
  },
  (t) => [uniqueIndex('convenio_nome_por_clinica_uk').on(t.clinicaId, t.nome)],
)

/** Tabela de preços negociada: quanto o convênio paga por cada procedimento. */
export const precoConvenio = pgTable(
  'preco_convenio',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    convenioId: uuid('convenio_id').notNull(),
    procedimentoId: uuid('procedimento_id').notNull(),
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
    foreignKey({
      name: 'preco_convenio_convenio_id_convenio_id_fk',
      columns: [t.convenioId, t.clinicaId],
      foreignColumns: [convenio.id, convenio.clinicaId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'preco_convenio_procedimento_id_procedimento_id_fk',
      columns: [t.procedimentoId, t.clinicaId],
      foreignColumns: [procedimento.id, procedimento.clinicaId],
    }).onDelete('restrict'),
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
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    convenioId: uuid('convenio_id').notNull(),
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
    foreignKey({
      name: 'paciente_convenio_convenio_id_convenio_id_fk',
      columns: [t.convenioId, t.clinicaId],
      foreignColumns: [convenio.id, convenio.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'paciente_convenio_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('cascade'),
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
