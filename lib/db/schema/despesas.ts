import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { usuario } from './acesso'
import { formaPagamentoEnum, naturezaDespesaEnum } from './enums'
import { clinicaId } from './tenant'

/**
 * O dinheiro que SAI. Contas a pagar e o que já foi pago.
 *
 * ── Por que isto existe ─────────────────────────────────────────────────────
 * `caixaDoPeriodo` somava **apenas entradas**. Não estava incompleto de um jeito
 * visível: estava **mentindo por omissão**, e a mentira é do tipo confortável — o
 * número saía maior que a realidade, todo mês, e ninguém desconfia de um caixa
 * generoso. Uma clínica que fecha julho com "R$ 62 mil recebidos" e não sabe que
 * pagou R$ 48 mil não tem informação nenhuma; tem uma sensação.
 *
 * ── A decisão que organiza estas três tabelas: obrigação ≠ pagamento ────────
 * `despesa` é a **obrigação** (o aluguel de julho existe em julho, pago ou não).
 * `pagamento_despesa` é o **movimento de caixa** (saiu do banco no dia 5 de
 * agosto). São tabelas separadas pelo mesmo motivo que `parcela` e `pagamento` são
 * separadas do lado da receita, e não é simetria decorativa:
 *
 *   • **regime de competência** pergunta "quanto custou julho?" → soma `despesa`
 *     por `competencia`;
 *   • **regime de caixa** pergunta "quanto saiu do banco em agosto?" → soma
 *     `pagamento_despesa` por `pago_em`.
 *
 * Um campo `pago boolean` na `despesa` responderia a primeira pergunta e
 * **destruiria** a segunda: não haveria data de saída, nem pagamento parcial, nem
 * como saber que a conta de julho foi paga em duas vezes. Misturar os dois regimes
 * é o erro clássico deste módulo, e o sintoma é um relatório que a contadora
 * recusa — não um erro que apareça na tela.
 *
 * ── Comissão paga é despesa, e há uma armadilha de contagem dupla ───────────
 * `comissaoDoPeriodo` (`lib/financeiro/consultas.ts`) **apura** quanto cada
 * profissional tem a receber. Quando a clínica paga, isso é uma `despesa` na
 * categoria de comissão — lançada **à mão**, nunca derivada da apuração.
 *
 * Derivar automaticamente seria a contagem dupla esperando acontecer: bastaria
 * alguém lançar o pagamento manualmente (e vai lançar, porque saiu do banco) para o
 * caixa registrar a mesma saída duas vezes. A apuração é a **fonte do número**; o
 * lançamento é ato humano. Não existe função que crie despesa a partir da comissão,
 * e não deve passar a existir.
 */

/**
 * Categoria da despesa. **Por clínica, e os valores do seed são DE PARTIDA.**
 *
 * Não é plano de contas. Plano de contas é decisão de quem faz a contabilidade da
 * clínica, tem hierarquia, código e amarração fiscal — e inventar um aqui produziria
 * quarenta campos que ninguém preenche, como qualquer formulário desenhado longe de
 * quem digita.
 *
 * O que existe é uma lista rasa do que um consultório de duas cadeiras realmente
 * paga, na mesma disciplina dos mínimos de estoque e das fichas técnicas do seed: a
 * clínica ajusta, acrescenta e desativa. `ativo` em vez de `DELETE` porque categoria
 * usada em despesa antiga não se apaga sem apagar o histórico.
 */
export const categoriaDespesa = pgTable(
  'categoria_despesa',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    /**
     * `fixa` é o que vem todo mês independente do movimento (aluguel, software);
     * `variavel` acompanha o atendimento (material, laboratório).
     *
     * Serve para uma pergunta concreta: "de quanto eu preciso por mês para manter a
     * porta aberta com zero paciente?" — que é a soma das fixas, e é o número que
     * decide se a clínica aguenta um mês fraco.
     */
    natureza: naturezaDespesaEnum('natureza').notNull().default('variavel'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('categoria_despesa_nome_uk').on(t.clinicaId, t.nome)],
)

/**
 * A regra da despesa recorrente. **Uma linha por regra, não 240 por aluguel.**
 *
 * Declarada ANTES de `despesa` por necessidade, não por estilo: `despesa` tem FK
 * composto para cá, e o callback de índices do Drizzle é avaliado na construção da
 * tabela — uma referência para frente cairia em TDZ (`Cannot access before
 * initialization`) na importação do módulo, que é o pior lugar para falhar.
 *
 * ── Por que não materializar o futuro ───────────────────────────────────────
 * A tentação é gerar as parcelas de uma vez, como o parcelamento de uma cobrança
 * faz. Mas parcelamento tem fim conhecido e valor acordado; aluguel é uma regra que
 * dura enquanto durar o contrato, e materializá-la em 20 anos de linhas cria três
 * problemas de uma vez: o reajuste anual passa a exigir editar 240 linhas futuras
 * (ou pior, editar algumas e esquecer), o fim do contrato deixa lixo com vencimento
 * em 2046, e a fila de contas a pagar fica cheia de coisa que ninguém deve ainda.
 *
 * A linha nasce quando a competência chega — gerador idempotente no laço do
 * despachante, com `(recorrente_id, competencia)` único. Projeção para frente é
 * **cálculo, não escrita**: quem quer ver os próximos seis meses soma as regras
 * ativas, sem gravar nada.
 */
export const regraDespesaRecorrente = pgTable(
  'regra_despesa_recorrente',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    categoriaId: uuid('categoria_id').notNull(),
    descricao: text('descricao').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    /**
     * Dia do vencimento no mês, 1 a 28.
     *
     * Para em 28 de propósito: 29, 30 e 31 não existem em todo mês, e "dia 31"
     * viraria uma regra que se comporta diferente em fevereiro. Quem vence dia 30
     * cadastra 28 e paga com folga, ou lança à mão — as duas são melhores que uma
     * data que às vezes escorrega sem avisar.
     */
    diaVencimento: smallint('dia_vencimento').notNull(),
    /** Primeira competência a materializar. */
    inicioEm: date('inicio_em').notNull(),
    /** Última competência, inclusive. Nulo = enquanto durar. */
    fimEm: date('fim_em'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'regra_despesa_categoria_id_categoria_despesa_id_fk',
      columns: [t.categoriaId, t.clinicaId],
      foreignColumns: [categoriaDespesa.id, categoriaDespesa.clinicaId],
    }).onDelete('restrict'),
    check('regra_despesa_valor_positivo', sql`${t.valor} > 0`),
    check(
      'regra_despesa_dia_valido',
      sql`${t.diaVencimento} >= 1 and ${t.diaVencimento} <= 28`,
    ),
    check(
      'regra_despesa_periodo_coerente',
      sql`${t.fimEm} is null or ${t.fimEm} >= ${t.inicioEm}`,
    ),
  ],
)

/**
 * A obrigação. Existe na competência a que pertence, paga ou não.
 *
 * `valor` é o total devido; o que já foi pago é a soma de `pagamento_despesa`, e o
 * saldo é derivado — nunca uma coluna. Coluna de saldo é a que fica errada primeiro
 * (é o mesmo motivo de `lote_material.saldo` ser mantido por trigger e recusar
 * `UPDATE` à mão).
 */
export const despesa = pgTable(
  'despesa',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    categoriaId: uuid('categoria_id').notNull(),
    descricao: text('descricao').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    /**
     * O dia civil a que a despesa PERTENCE — a competência.
     *
     * Para o aluguel de julho é 01/07, mesmo que a fatura chegue em 28/06 e o
     * pagamento saia em 05/08. É o campo que responde "quanto custou julho".
     */
    competencia: date('competencia').notNull(),
    /** Quando vence. Move a fila de contas a pagar, não a competência. */
    vencimento: date('vencimento').notNull(),
    fornecedor: text('fornecedor'),
    /** Número da nota, do recibo ou do boleto. Para achar o papel depois. */
    documento: text('documento'),
    observacao: text('observacao'),
    /**
     * De qual regra recorrente esta linha nasceu, quando nasceu de uma.
     *
     * É o que torna a materialização **idempotente**: `(recorrente_id, competencia)`
     * é único, então rodar o gerador duas vezes no mesmo mês não duplica o aluguel.
     * Nulo para lançamento manual — e o índice é parcial de propósito, porque dois
     * lançamentos manuais na mesma competência são normais.
     */
    recorrenteId: uuid('recorrente_id'),
    criadoPorId: uuid('criado_por_id').references(() => usuario.id, { onDelete: 'set null' }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    canceladoEm: timestamp('cancelado_em', { withTimezone: true }),
    motivoCancelamento: text('motivo_cancelamento'),
  },
  (t) => [
    foreignKey({
      name: 'despesa_categoria_id_categoria_despesa_id_fk',
      columns: [t.categoriaId, t.clinicaId],
      foreignColumns: [categoriaDespesa.id, categoriaDespesa.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'despesa_recorrente_id_regra_despesa_recorrente_id_fk',
      columns: [t.recorrenteId, t.clinicaId],
      foreignColumns: [regraDespesaRecorrente.id, regraDespesaRecorrente.clinicaId],
    }).onDelete('restrict'),
    index('despesa_competencia_idx').on(t.clinicaId, t.competencia),
    index('despesa_vencimento_idx').on(t.clinicaId, t.vencimento),
    uniqueIndex('despesa_recorrente_competencia_uk')
      .on(t.recorrenteId, t.competencia)
      .where(sql`${t.recorrenteId} is not null`),
    check('despesa_valor_positivo', sql`${t.valor} > 0`),
    check(
      'despesa_cancelamento_justificado',
      sql`${t.canceladoEm} is null or ${t.motivoCancelamento} is not null`,
    ),
  ],
)

/**
 * O movimento de caixa: dinheiro que saiu, no dia em que saiu.
 *
 * Aceita pagamento parcial (a conta do laboratório paga em duas vezes), e a soma
 * nunca passa do valor da despesa — trigger na `0034`, no mesmo molde do que já
 * impede pagamento acima do valor da parcela.
 */
export const pagamentoDespesa = pgTable(
  'pagamento_despesa',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    despesaId: uuid('despesa_id').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    /** Dia civil da saída. É por este campo que o fluxo de CAIXA soma. */
    pagoEm: date('pago_em').notNull(),
    /**
     * `formaPagamentoEnum` é reusado, e um CHECK proíbe `convenio`: convênio é
     * origem de receita, não jeito de pagar aluguel. Enum quase-igual só para
     * remover um valor custaria mais do que a checagem.
     */
    meio: formaPagamentoEnum('meio').notNull(),
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
      name: 'pagamento_despesa_despesa_id_despesa_id_fk',
      columns: [t.despesaId, t.clinicaId],
      foreignColumns: [despesa.id, despesa.clinicaId],
    }).onDelete('restrict'),
    index('pagamento_despesa_despesa_idx').on(t.despesaId),
    index('pagamento_despesa_data_idx').on(t.clinicaId, t.pagoEm),
    check('pagamento_despesa_valor_positivo', sql`${t.valor} > 0`),
    check('pagamento_despesa_meio_nao_convenio', sql`${t.meio} <> 'convenio'`),
    check(
      'pagamento_despesa_estorno_justificado',
      sql`${t.estornadoEm} is null or ${t.motivoEstorno} is not null`,
    ),
  ],
)
