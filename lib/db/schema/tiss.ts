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
import { profissional, usuario } from './acesso'
import { convenio } from './convenios'
import { classeGlosaEnum, situacaoGuiaEnum, situacaoItemGuiaEnum } from './enums'
import { itemPlano } from './tratamento'
import { paciente } from './pacientes'
import { proximoNumero } from './numeracao'
import { clinicaId } from './tenant'

/**
 * Faturamento por convênio: guia, glosa, recurso e repasse.
 *
 * ── O modelo em uma frase ───────────────────────────────────────────────────
 * `guia_tiss` é o documento apresentado à operadora; `item_guia` é cada
 * procedimento nele, ligado ao `item_plano` que o originou; `repasse` é o
 * pagamento que a operadora faz cobrindo vários itens de várias guias.
 *
 * ── Por que item_guia existe, em vez de faturar direto o item_plano ─────────
 * Porque um procedimento pode ser apresentado **mais de uma vez**: glosado,
 * recorrido, reapresentado. Se o valor apresentado morasse em `item_plano`, cada
 * reapresentação sobrescreveria a anterior e a clínica perderia a história — que é
 * justamente o que se leva para uma discussão com a operadora.
 *
 * ── A separação que evita o erro clássico ───────────────────────────────────
 * `valor_apresentado` (o que pedimos) e `valor_pago` (o que veio) são colunas
 * distintas, e a glosa é a diferença — nunca um campo que alguém digita. Glosa
 * digitada à mão divergindo do que o repasse mostra é a origem de conciliação que
 * nunca fecha.
 */

/**
 * Guia apresentada à operadora.
 *
 * Uma guia agrupa procedimentos de **um paciente** num período. Não é lote: o lote
 * é o conjunto de guias enviado de uma vez, e ele mora em `numero_lote` porque a
 * operadora identifica o envio por ele.
 */
export const guiaTiss = pgTable(
  'guia_tiss',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Número da guia no prestador, sequencial e sem buraco.
     *
     * Vem de uma sequence (`guia_numero_seq`), não de `count(*) + 1`: dois
     * faturamentos simultâneos gerariam o mesmo número, e número repetido de guia é
     * rejeição no protocolo.
     */
    numero: numeric('numero', { precision: 12, scale: 0 })
      .notNull()
      .default(proximoNumero('guia_tiss')),
    convenioId: uuid('convenio_id').notNull(),
    pacienteId: uuid('paciente_id').notNull(),
    /** Carteirinha COPIADA na emissão: a do cadastro pode mudar depois. */
    numeroCarteirinha: varchar('numero_carteirinha', { length: 40 }).notNull(),
    /** Profissional executante — vai no campo obrigatório da guia. */
    profissionalId: uuid('profissional_id').notNull(),

    situacao: situacaoGuiaEnum('situacao').notNull().default('rascunho'),

    /** Valor somado dos itens apresentados. Conferido por trigger deferida. */
    valorApresentado: numeric('valor_apresentado', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    /** Somado dos pagamentos recebidos por item. Mantido por trigger. */
    valorPago: numeric('valor_pago', { precision: 12, scale: 2 }).notNull().default('0'),

    /** Lote do envio, como a operadora identifica o protocolo. */
    numeroLote: varchar('numero_lote', { length: 30 }),
    /** Protocolo devolvido pela operadora no recebimento. */
    protocoloOperadora: varchar('protocolo_operadora', { length: 60 }),

    emitidaEm: timestamp('emitida_em', { withTimezone: true }).notNull().defaultNow(),
    enviadaEm: timestamp('enviada_em', { withTimezone: true }),
    /** Quando a operadora devolveu a análise. */
    retornoEm: timestamp('retorno_em', { withTimezone: true }),
    /** Data prevista do repasse, calculada do envio + prazo contratual. */
    previsaoRepasse: date('previsao_repasse'),

    observacao: text('observacao'),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'guia_tiss_convenio_id_convenio_id_fk',
      columns: [t.convenioId, t.clinicaId],
      foreignColumns: [convenio.id, convenio.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'guia_tiss_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'guia_tiss_profissional_id_profissional_id_fk',
      columns: [t.profissionalId, t.clinicaId],
      foreignColumns: [profissional.id, profissional.clinicaId],
    }).onDelete('restrict'),
    // Único por clínica: a operadora exige número único por PRESTADOR, e o
    // prestador é a clínica. Duas clínicas emitindo a guia 1 no mesmo mês é
    // normal — elas mandam para operadoras diferentes, com CNPJ diferente.
    uniqueIndex('guia_numero_por_clinica_uk').on(t.clinicaId, t.numero),
    index('guia_convenio_idx').on(t.convenioId, t.situacao),
    index('guia_paciente_idx').on(t.pacienteId, t.emitidaEm),
    index('guia_lote_idx').on(t.numeroLote).where(sql`${t.numeroLote} is not null`),
    // A fila do faturamento: o que já venceu e não foi pago.
    index('guia_previsao_idx')
      .on(t.previsaoRepasse)
      .where(sql`${t.situacao} in ('enviada','em_analise','glosada_parcial')`),
    check('guia_valores_nao_negativos', sql`${t.valorApresentado} >= 0 and ${t.valorPago} >= 0`),
    check(
      'guia_enviada_tem_carimbo',
      sql`${t.situacao} = 'rascunho' or ${t.situacao} = 'cancelada' or ${t.enviadaEm} is not null`,
    ),
    check(
      'guia_rascunho_sem_carimbo',
      sql`${t.situacao} <> 'rascunho' or ${t.enviadaEm} is null`,
    ),
  ],
)

/**
 * Um procedimento dentro da guia.
 *
 * Guarda o **código TUSS congelado na emissão**. O catálogo pode ser corrigido
 * depois, e a guia tem de continuar mostrando o que foi apresentado — senão a
 * discussão com a operadora fica sem base.
 */
export const itemGuia = pgTable(
  'item_guia',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    guiaId: uuid('guia_id').notNull(),
    /**
     * O item do plano que originou este item de guia.
     *
     * `restrict`: apagar o item do plano deixaria a guia apontando para o nada, e a
     * guia é documento apresentado a terceiro.
     */
    itemPlanoId: uuid('item_plano_id').notNull(),

    /** Código TUSS congelado. Nulo enquanto a Tabela 22 da ANS não for importada. */
    codigoTuss: varchar('codigo_tuss', { length: 20 }),
    /** Descrição congelada, como foi apresentada. */
    descricao: text('descricao').notNull(),
    denteFdi: smallint('dente_fdi'),
    /** Faces em texto, como a guia exige — não o array do prontuário. */
    faces: varchar('faces', { length: 60 }),
    quantidade: smallint('quantidade').notNull().default(1),
    dataExecucao: date('data_execucao').notNull(),

    valorApresentado: numeric('valor_apresentado', { precision: 10, scale: 2 }).notNull(),
    /** Quanto a operadora pagou. Nulo = ainda não retornou. */
    valorPago: numeric('valor_pago', { precision: 10, scale: 2 }),

    situacao: situacaoItemGuiaEnum('situacao').notNull().default('apresentado'),
    /** Quantas vezes este procedimento já foi apresentado (1 = primeira). */
    tentativa: smallint('tentativa').notNull().default(1),

    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'item_guia_guia_id_guia_tiss_id_fk',
      columns: [t.guiaId, t.clinicaId],
      foreignColumns: [guiaTiss.id, guiaTiss.clinicaId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'item_guia_item_plano_id_item_plano_id_fk',
      columns: [t.itemPlanoId, t.clinicaId],
      foreignColumns: [itemPlano.id, itemPlano.clinicaId],
    }).onDelete('restrict'),
    index('item_guia_guia_idx').on(t.guiaId),
    index('item_guia_plano_idx').on(t.itemPlanoId),
    // Um procedimento não pode estar duas vezes na MESMA guia com a mesma
    // tentativa: seria cobrar em dobro no mesmo documento.
    uniqueIndex('item_guia_unico_por_tentativa').on(t.guiaId, t.itemPlanoId, t.tentativa),
    check('item_guia_valor_positivo', sql`${t.valorApresentado} > 0`),
    check('item_guia_pago_nao_negativo', sql`${t.valorPago} is null or ${t.valorPago} >= 0`),
    check('item_guia_quantidade_positiva', sql`${t.quantidade} > 0`),
    check('item_guia_tentativa_positiva', sql`${t.tentativa} > 0`),
  ],
)

/**
 * Glosa de um item.
 *
 * Append-only por trigger: glosa é a posição da operadora sobre aquele item, e
 * apagá-la apagaria a razão de um recurso. Correção se faz registrando o recurso e
 * o novo retorno.
 */
export const glosa = pgTable(
  'glosa',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    itemGuiaId: uuid('item_guia_id').notNull(),
    /** Código informado pela operadora (Tabela 38 da ANS, quando vier). */
    codigoOperadora: varchar('codigo_operadora', { length: 20 }),
    /** Classificação operacional — o que fazer a respeito. */
    classe: classeGlosaEnum('classe').notNull(),
    motivo: text('motivo').notNull(),
    /** Valor glosado. A diferença entre apresentado e pago. */
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    registradaEm: timestamp('registrada_em', { withTimezone: true }).notNull().defaultNow(),
    registradaPorId: uuid('registrada_por_id').references(() => usuario.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    foreignKey({
      name: 'glosa_item_guia_id_item_guia_id_fk',
      columns: [t.itemGuiaId, t.clinicaId],
      foreignColumns: [itemGuia.id, itemGuia.clinicaId],
    }).onDelete('restrict'),
    index('glosa_item_idx').on(t.itemGuiaId),
    index('glosa_classe_idx').on(t.classe, t.registradaEm),
    check('glosa_valor_positivo', sql`${t.valor} > 0`),
    check('glosa_motivo_nao_vazio', sql`length(btrim(${t.motivo})) > 0`),
  ],
)

/** Recurso contra uma glosa. */
export const recursoGlosa = pgTable(
  'recurso_glosa',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    glosaId: uuid('glosa_id').notNull(),
    argumento: text('argumento').notNull(),
    /** Documentos anexados ao recurso, quando houver. */
    documentoIds: uuid('documento_ids').array(),
    enviadoEm: timestamp('enviado_em', { withTimezone: true }).notNull().defaultNow(),
    /** Resposta da operadora: deferido, indeferido, ou ainda em análise. */
    deferido: boolean('deferido'),
    respostaEm: timestamp('resposta_em', { withTimezone: true }),
    respostaMotivo: text('resposta_motivo'),
    enviadoPorId: uuid('enviado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
  },
  (t) => [
    foreignKey({
      name: 'recurso_glosa_glosa_id_glosa_id_fk',
      columns: [t.glosaId, t.clinicaId],
      foreignColumns: [glosa.id, glosa.clinicaId],
    }).onDelete('restrict'),
    index('recurso_glosa_idx').on(t.glosaId),
    check('recurso_argumento_nao_vazio', sql`length(btrim(${t.argumento})) > 0`),
    check(
      'recurso_resposta_coerente',
      sql`(${t.deferido} is null) = (${t.respostaEm} is null)`,
    ),
  ],
)

/**
 * Repasse: o pagamento que a operadora faz.
 *
 * Cobre itens de **várias guias** ao mesmo tempo — é assim que a operadora paga, e
 * modelar como "um pagamento por guia" tornaria impossível conciliar o extrato.
 */
export const repasse = pgTable(
  'repasse',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    convenioId: uuid('convenio_id').notNull(),
    /** Valor total do crédito, como veio no extrato. */
    valorTotal: numeric('valor_total', { precision: 12, scale: 2 }).notNull(),
    /** Soma do que foi efetivamente atribuído a itens. Mantido por trigger. */
    valorConciliado: numeric('valor_conciliado', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    recebidoEm: date('recebido_em').notNull(),
    demonstrativo: varchar('demonstrativo', { length: 60 }),
    observacao: text('observacao'),
    /** Fechado quando a clínica conferiu tudo. Depois disso não muda. */
    fechadoEm: timestamp('fechado_em', { withTimezone: true }),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'repasse_convenio_id_convenio_id_fk',
      columns: [t.convenioId, t.clinicaId],
      foreignColumns: [convenio.id, convenio.clinicaId],
    }).onDelete('restrict'),
    index('repasse_convenio_idx').on(t.convenioId, t.recebidoEm),
    check('repasse_valor_positivo', sql`${t.valorTotal} > 0`),
    check('repasse_conciliado_nao_negativo', sql`${t.valorConciliado} >= 0`),
  ],
)

/**
 * Atribuição de parte de um repasse a um item de guia.
 *
 * É a linha que faz a conciliação existir: sem ela, um crédito de R$ 4.230,00 no
 * extrato não se liga a nenhum procedimento, e descobrir o que foi glosado exige
 * planilha à parte.
 */
export const repasseItem = pgTable(
  'repasse_item',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    repasseId: uuid('repasse_id').notNull(),
    itemGuiaId: uuid('item_guia_id').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'repasse_item_item_guia_id_item_guia_id_fk',
      columns: [t.itemGuiaId, t.clinicaId],
      foreignColumns: [itemGuia.id, itemGuia.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'repasse_item_repasse_id_repasse_id_fk',
      columns: [t.repasseId, t.clinicaId],
      foreignColumns: [repasse.id, repasse.clinicaId],
    }).onDelete('cascade'),
    index('repasse_item_repasse_idx').on(t.repasseId),
    // Um item recebe de um repasse uma vez só. Duas linhas seriam pagamento duplo.
    uniqueIndex('repasse_item_unico').on(t.repasseId, t.itemGuiaId),
    check('repasse_item_valor_nao_negativo', sql`${t.valor} >= 0`),
  ],
)
