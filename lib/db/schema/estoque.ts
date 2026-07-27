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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { profissional, usuario } from './acesso'
import { categoriaMaterialEnum, tipoMovimentoEstoqueEnum, unidadeMaterialEnum } from './enums'
import { procedimento } from './referencia'
import { execucao } from './tratamento'
import { clinicaId } from './tenant'

/**
 * Insumo do consultório: anestésico, resina, luva, agulha, broca, implante.
 *
 * **`unidade` é a unidade de CONSUMO**, não a de compra. Quem consome tira um
 * tubete, não uma caixa. `unidades_por_embalagem` faz a conversão no
 * recebimento — lançar "2" ao receber 2 caixas de 100 luvas é o erro mais comum
 * de quem digita nota fiscal, e ele só aparece semanas depois, como alerta de
 * mínimo que nunca dispara. Ver `converterCompra` em `lib/domain/quantidade.ts`.
 */
export const material = pgTable(
  'material',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Código interno da clínica. É o que está etiquetado na prateleira. */
    codigo: varchar('codigo', { length: 30 }).notNull(),
    nome: text('nome').notNull(),
    descricao: text('descricao'),
    categoria: categoriaMaterialEnum('categoria').notNull(),
    unidade: unidadeMaterialEnum('unidade').notNull(),
    /** Quantas unidades de consumo vêm em uma embalagem de compra. 1 = compra solta. */
    unidadesPorEmbalagem: integer('unidades_por_embalagem').notNull().default(1),
    /** Como o fornecedor vende ("caixa de 100 luvas"). Texto livre, é para ler. */
    embalagem: text('embalagem'),
    /** Ponto de reposição, na unidade de consumo. Zero = sem alerta de mínimo. */
    quantidadeMinima: numeric('quantidade_minima', { precision: 12, scale: 3 })
      .notNull()
      .default('0'),
    /**
     * Material sujeito a controle especial (Portaria 344/98 da Anvisa) — em
     * consultório, tipicamente midazolam e afins. Toda saída exige motivo e
     * responsável identificado; a trigger em `drizzle/0019` cobra isso.
     */
    controlado: boolean('controlado').notNull().default(false),
    /**
     * Rastreabilidade obrigatória do lote do FABRICANTE: implante, enxerto,
     * membrana. Se um lote for recolhido, a clínica precisa dizer em quem foi
     * usado — e para isso o número do lote não pode ser opcional.
     */
    exigeLoteDoFabricante: boolean('exige_lote_do_fabricante').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('material_codigo_por_clinica_uk').on(t.clinicaId, t.codigo),
    index('material_categoria_idx').on(t.categoria, t.nome),
    check('material_embalagem_positiva', sql`${t.unidadesPorEmbalagem} >= 1`),
    check('material_minimo_nao_negativo', sql`${t.quantidadeMinima} >= 0`),
  ],
)

/**
 * Um recebimento de material: o que entrou, de qual lote do fabricante, com que
 * validade e a que custo.
 *
 * **Nome com sufixo `_material` de propósito.** No TISS, "lote" é o protocolo que
 * agrupa guias enviadas à operadora (`guia_tiss.numero_lote`). Duas coisas
 * chamadas lote no mesmo sistema é ambiguidade garantida em code review e em
 * conversa com a clínica.
 *
 * **A linha é o recebimento, não o número do lote.** Comprar o mesmo lote do
 * fabricante duas vezes, a preços diferentes, gera duas linhas — e assim o
 * consumo é valorado pelo custo exato do que saiu, sem média ponderada. O
 * recolhimento de lote continua respondido por `codigo_fabricante`.
 *
 * `saldo` é mantido EXCLUSIVAMENTE pela trigger de `movimento_estoque`
 * (`drizzle/0019`) e tem CHECK de não-negativo: é ali que a impossibilidade de
 * consumir o que não existe deixa de ser disciplina de código e passa a ser
 * garantia do banco.
 */
export const loteMaterial = pgTable(
  'lote_material',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    materialId: uuid('material_id').notNull(),
    /** Número do lote impresso pelo fabricante. Nulo só se o material não exige. */
    codigoFabricante: varchar('codigo_fabricante', { length: 60 }),
    /** Dia civil — validade não tem hora. Nulo = material sem validade (instrumental). */
    validade: date('validade'),
    custoUnitario: numeric('custo_unitario', { precision: 10, scale: 2 }).notNull(),
    /** Saldo atual. NÃO escreva direto: é derivado dos movimentos por trigger. */
    saldo: numeric('saldo', { precision: 12, scale: 3 }).notNull().default('0'),
    fornecedor: text('fornecedor'),
    notaFiscal: varchar('nota_fiscal', { length: 60 }),
    /** Dia do recebimento. Desempata FEFO entre lotes de mesma validade. */
    recebidoEm: date('recebido_em').notNull(),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'lote_material_material_id_material_id_fk',
      columns: [t.materialId, t.clinicaId],
      foreignColumns: [material.id, material.clinicaId],
    }).onDelete('restrict'),
    /**
     * O índice do FEFO. `nulls last` casa com `ordenarFefo`: material perene sai
     * depois do que pode vencer.
     */
    index('lote_fefo_idx')
      .on(t.materialId, sql`${t.validade} asc nulls last`, t.recebidoEm)
      .where(sql`${t.saldo} > 0`),
    index('lote_validade_idx').on(t.validade).where(sql`${t.saldo} > 0`),
    index('lote_codigo_fabricante_idx').on(t.codigoFabricante),
    // Composta para o FK de `movimento_estoque` provar que o material do
    // movimento é o material do lote — sem depender de a aplicação acertar.
    unique('lote_id_material_uk').on(t.id, t.materialId),
    check('lote_saldo_nao_negativo', sql`${t.saldo} >= 0`),
    check('lote_custo_nao_negativo', sql`${t.custoUnitario} >= 0`),
  ],
)

/**
 * O livro do estoque: **append-only**, como a evolução do prontuário.
 *
 * Sem UPDATE e sem DELETE (trigger em `drizzle/0019`). Lançamento errado se
 * corrige com um `ajuste` no sentido contrário, com motivo — apagar a linha
 * apagaria a única prova de que a contagem já não fechava.
 *
 * `quantidade` é ASSINADA: entrada positiva, consumo/descarte/devolução
 * negativos, ajuste nos dois sentidos. Assim saldo é `sum(quantidade)`, que é
 * como um livro-caixa fecha — e não "soma dos positivos menos soma dos
 * negativos conforme uma coluna de direção", que dá dois lugares para errar.
 */
export const movimentoEstoque = pgTable(
  'movimento_estoque',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    loteId: uuid('lote_id').notNull(),
    /** Redundante com o lote, e é o que permite o FK composto abaixo. */
    materialId: uuid('material_id').notNull(),
    tipo: tipoMovimentoEstoqueEnum('tipo').notNull(),
    quantidade: numeric('quantidade', { precision: 12, scale: 3 }).notNull(),
    /** Custo unitário praticado neste movimento — cópia do lote na hora da baixa. */
    custoUnitario: numeric('custo_unitario', { precision: 10, scale: 2 }),
    motivo: text('motivo'),
    /**
     * Execução que consumiu o material. É o elo da rastreabilidade: com ele, o
     * recolhimento de um lote de implante responde "em quais pacientes foi
     * usado" com uma consulta, não com uma busca em papel.
     */
    execucaoId: uuid('execucao_id'),
    /** Quem retirou. Obrigatório em material controlado. */
    profissionalId: uuid('profissional_id'),
    registradoPorId: uuid('registrado_por_id').references(() => usuario.id, {
      onDelete: 'set null',
    }),
    /** Momento do fato, que pode ser anterior ao lançamento (contagem de ontem). */
    ocorridoEm: timestamp('ocorrido_em', { withTimezone: true }).notNull().defaultNow(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'movimento_estoque_execucao_id_execucao_id_fk',
      columns: [t.execucaoId, t.clinicaId],
      foreignColumns: [execucao.id, execucao.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'movimento_estoque_lote_id_lote_material_id_fk',
      columns: [t.loteId, t.clinicaId],
      foreignColumns: [loteMaterial.id, loteMaterial.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'movimento_estoque_material_id_material_id_fk',
      columns: [t.materialId, t.clinicaId],
      foreignColumns: [material.id, material.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'movimento_estoque_profissional_id_profissional_id_fk',
      columns: [t.profissionalId, t.clinicaId],
      foreignColumns: [profissional.id, profissional.clinicaId],
    }).onDelete('restrict'),
    index('movimento_lote_idx').on(t.loteId, t.ocorridoEm),
    index('movimento_material_idx').on(t.materialId, t.ocorridoEm),
    index('movimento_execucao_idx').on(t.execucaoId).where(sql`${t.execucaoId} is not null`),
    index('movimento_tipo_idx').on(t.tipo, t.ocorridoEm),
    check('movimento_quantidade_nao_zero', sql`${t.quantidade} <> 0`),
    /**
     * O sinal segue o tipo. A regra vive em `sinalEsperado` no domínio e aqui —
     * de propósito: o domínio dá a mensagem boa na tela, o banco garante que
     * nenhum caminho (script, psql, importador) grave consumo positivo.
     */
    check(
      'movimento_sinal_pelo_tipo',
      sql`case
        when ${t.tipo} = 'entrada' then ${t.quantidade} > 0
        when ${t.tipo} in ('consumo','descarte','devolucao') then ${t.quantidade} < 0
        else true
      end`,
    ),
    check(
      'movimento_ajuste_e_descarte_com_motivo',
      sql`${t.tipo} not in ('ajuste','descarte') or (${t.motivo} is not null and btrim(${t.motivo}) <> '')`,
    ),
    check('movimento_custo_nao_negativo', sql`${t.custoUnitario} is null or ${t.custoUnitario} >= 0`),
    // Só consumo se liga a execução: descarte de material vencido não tem paciente.
    check(
      'movimento_execucao_so_em_consumo',
      sql`${t.execucaoId} is null or ${t.tipo} = 'consumo'`,
    ),
  ],
)

/**
 * Ficha técnica: quanto de cada material um procedimento consome.
 *
 * Serve para PROPOR a baixa quando a execução é registrada — nunca para
 * executá-la sozinha. Se o sistema baixasse por conta própria, a rastreabilidade
 * afirmaria um lote que talvez não tenha sido o usado, e uma rastreabilidade que
 * mente é pior que nenhuma. O dentista confirma em um clique, com o lote FEFO
 * já pré-selecionado.
 */
export const insumoProcedimento = pgTable(
  'insumo_procedimento',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    procedimentoId: uuid('procedimento_id').notNull(),
    materialId: uuid('material_id').notNull(),
    quantidade: numeric('quantidade', { precision: 12, scale: 3 }).notNull(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'insumo_procedimento_material_id_material_id_fk',
      columns: [t.materialId, t.clinicaId],
      foreignColumns: [material.id, material.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'insumo_procedimento_procedimento_id_procedimento_id_fk',
      columns: [t.procedimentoId, t.clinicaId],
      foreignColumns: [procedimento.id, procedimento.clinicaId],
    }).onDelete('cascade'),
    unique('insumo_procedimento_material_uk').on(t.procedimentoId, t.materialId),
    index('insumo_material_idx').on(t.materialId),
    check('insumo_quantidade_positiva', sql`${t.quantidade} > 0`),
  ],
)
