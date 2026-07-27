import { sql } from 'drizzle-orm'
import {
  foreignKey,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { usuario } from './acesso'
import { formaPagamentoEnum, statusOrcamentoEnum, statusParcelaEnum } from './enums'
import { paciente } from './pacientes'
import { itemPlano, planoTratamento } from './tratamento'
import { proximoNumero } from './numeracao'
import { clinicaId } from './tenant'

/**
 * Documento CONGELADO derivado do plano, com validade e valor.
 * Se o plano muda depois de enviado, o orçamento não muda — gera-se outro.
 * Por isso `orcamento_item` copia descrição e valor em vez de só referenciar `item_plano`.
 */
export const orcamento = pgTable(
  'orcamento',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Número sequencial legível, para o paciente citar ao telefone. **Por
     * clínica** — ver `lib/db/schema/numeracao.ts` para o porquê de não ser mais
     * a sequence global. Único por clínica, no índice ao pé da tabela.
     */
    numero: integer('numero').notNull().default(proximoNumero('orcamento')),
    pacienteId: uuid('paciente_id').notNull(),
    planoId: uuid('plano_id').references(() => planoTratamento.id, { onDelete: 'set null' }),
    status: statusOrcamentoEnum('status').notNull().default('rascunho'),
    validadeAte: date('validade_ate').notNull(),
    valorBruto: numeric('valor_bruto', { precision: 10, scale: 2 }).notNull(),
    desconto: numeric('desconto', { precision: 10, scale: 2 }).notNull().default('0'),
    valorTotal: numeric('valor_total', { precision: 10, scale: 2 }).notNull(),
    observacao: text('observacao'),
    /** Chave do PDF gerado no storage privado. Nunca URL pública. */
    pdfKey: text('pdf_key'),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    enviadoEm: timestamp('enviado_em', { withTimezone: true }),
    decididoEm: timestamp('decidido_em', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'orcamento_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    uniqueIndex('orcamento_numero_por_clinica_uk').on(t.clinicaId, t.numero),
    index('orcamento_paciente_idx').on(t.pacienteId, t.criadoEm),
    index('orcamento_status_idx').on(t.status, t.validadeAte),
    check('orcamento_desconto_nao_negativo', sql`${t.desconto} >= 0`),
    check('orcamento_total_coerente', sql`${t.valorTotal} = ${t.valorBruto} - ${t.desconto}`),
    check('orcamento_total_nao_negativo', sql`${t.valorTotal} >= 0`),
  ],
)

/**
 * Linha do orçamento. Copia `descricao` e `valor` do item de plano no momento da emissão —
 * o documento tem que permanecer legível mesmo que o plano ou a tabela de preço mude depois.
 */
export const orcamentoItem = pgTable(
  'orcamento_item',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    orcamentoId: uuid('orcamento_id').notNull(),
    /** Rastreabilidade. Pode virar null sem invalidar o documento. */
    itemPlanoId: uuid('item_plano_id').references(() => itemPlano.id, { onDelete: 'set null' }),
    descricao: text('descricao').notNull(),
    /** Ex.: "Dente 16, faces oclusal e mesial" — congelado como texto. */
    detalhe: text('detalhe'),
    quantidade: smallint('quantidade').notNull().default(1),
    valorUnitario: numeric('valor_unitario', { precision: 10, scale: 2 }).notNull(),
    ordem: smallint('ordem').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'orcamento_item_orcamento_id_orcamento_id_fk',
      columns: [t.orcamentoId, t.clinicaId],
      foreignColumns: [orcamento.id, orcamento.clinicaId],
    }).onDelete('cascade'),
    index('orcamento_item_orcamento_idx').on(t.orcamentoId, t.ordem),
    check('orcamento_item_qtd_positiva', sql`${t.quantidade} > 0`),
    check('orcamento_item_valor_nao_negativo', sql`${t.valorUnitario} >= 0`),
  ],
)

/** Compromisso financeiro total do paciente sobre um orçamento aprovado. */
export const cobranca = pgTable(
  'cobranca',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    orcamentoId: uuid('orcamento_id').references(() => orcamento.id, { onDelete: 'set null' }),
    valorTotal: numeric('valor_total', { precision: 10, scale: 2 }).notNull(),
    forma: formaPagamentoEnum('forma').notNull(),
    qtdParcelas: smallint('qtd_parcelas').notNull().default(1),
    observacao: text('observacao'),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    canceladoEm: timestamp('cancelado_em', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'cobranca_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    index('cobranca_paciente_idx').on(t.pacienteId, t.criadoEm),
    check('cobranca_valor_positivo', sql`${t.valorTotal} > 0`),
    check('cobranca_parcelas_positivas', sql`${t.qtdParcelas} >= 1`),
  ],
)

/**
 * Fração da cobrança com vencimento próprio.
 * A soma das parcelas é sempre igual ao total da cobrança — garantido por trigger
 * deferido em drizzle/0001_constraints.sql, e calculado em lib/domain/parcelamento.ts.
 */
export const parcela = pgTable(
  'parcela',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    cobrancaId: uuid('cobranca_id').notNull(),
    numero: smallint('numero').notNull(),
    vencimento: date('vencimento').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    status: statusParcelaEnum('status').notNull().default('aberta'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'parcela_cobranca_id_cobranca_id_fk',
      columns: [t.cobrancaId, t.clinicaId],
      foreignColumns: [cobranca.id, cobranca.clinicaId],
    }).onDelete('cascade'),
    uniqueIndex('parcela_cobranca_numero_uk').on(t.cobrancaId, t.numero),
    index('parcela_vencimento_idx').on(t.vencimento, t.status),
    check('parcela_numero_positivo', sql`${t.numero} >= 1`),
    check('parcela_valor_positivo', sql`${t.valor} > 0`),
  ],
)

/** Entrada de dinheiro contra uma parcela. Uma parcela aceita pagamentos parciais. */
export const pagamento = pgTable(
  'pagamento',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    parcelaId: uuid('parcela_id').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    pagoEm: date('pago_em').notNull(),
    meio: formaPagamentoEnum('meio').notNull(),
    /** Conferido contra extrato bancário / adquirente. */
    conciliado: boolean('conciliado').notNull().default(false),
    conciliadoEm: timestamp('conciliado_em', { withTimezone: true }),
    comprovante: text('comprovante'),
    observacao: text('observacao'),
    registradoPorId: uuid('registrado_por_id').references(() => usuario.id, {
      onDelete: 'set null',
    }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    estornadoEm: timestamp('estornado_em', { withTimezone: true }),
    motivoEstorno: text('motivo_estorno'),
  },
  (t) => [
    foreignKey({
      name: 'pagamento_parcela_id_parcela_id_fk',
      columns: [t.parcelaId, t.clinicaId],
      foreignColumns: [parcela.id, parcela.clinicaId],
    }).onDelete('restrict'),
    index('pagamento_parcela_idx').on(t.parcelaId),
    index('pagamento_data_idx').on(t.pagoEm),
    check('pagamento_valor_positivo', sql`${t.valor} > 0`),
    check(
      'pagamento_estorno_justificado',
      sql`${t.estornadoEm} is null or ${t.motivoEstorno} is not null`,
    ),
    check(
      'pagamento_conciliacao_coerente',
      sql`${t.conciliado} = (${t.conciliadoEm} is not null)`,
    ),
  ],
)
