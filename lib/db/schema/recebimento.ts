import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { formaPagamentoEnum, situacaoPixEnum } from './enums'
import { pagamento, parcela } from './financeiro'
import { clinicaId } from './tenant'

/**
 * O lado eletrônico da entrada: quanto a maquininha come, e cobrança por Pix.
 *
 * ── Duas coisas diferentes moram aqui, e o fio que as une é a conciliação ───
 * `taxa_meio_pagamento` responde "de R$ 100 no crédito, quanto chega na conta?".
 * `intencao_pix` e `evento_pix` respondem "este dinheiro que caiu é de qual
 * parcela?". As duas existem porque a versão manual delas é onde o mês não fecha.
 */

/**
 * A taxa do meio de pagamento (MDR), com vigência.
 *
 * ── Por que tem vigência, e por que ela não se sobrepõe ─────────────────────
 * MDR é negociado e renegociado. Uma taxa sem data faria a conciliação de março ser
 * recalculada quando a de setembro mudasse — e o histórico de quanto a clínica
 * realmente recebeu passaria a depender do contrato de hoje.
 *
 * A regra é a mesma que já vale para preço de convênio, e pelo mesmo motivo: **a
 * taxa aplicada é a vigente na DATA DO PAGAMENTO**, nunca a de hoje. E existe
 * EXCLUDE constraint impedindo duas linhas válidas para o mesmo meio no mesmo dia —
 * com duas, o valor líquido passaria a depender da ordem da consulta, que é a classe
 * de bug que não dá erro e não dá o mesmo resultado duas vezes.
 *
 * ── Percentual E valor fixo ─────────────────────────────────────────────────
 * Pix costuma ser centavos fixos por transação; cartão é percentual. Boleto é os
 * dois (tarifa fixa por liquidação). Modelar só percentual obrigaria a fingir que
 * R$ 0,99 de tarifa é 0,99% de algo.
 */
export const taxaMeioPagamento = pgTable(
  'taxa_meio_pagamento',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    meio: formaPagamentoEnum('meio').notNull(),
    /** Percentual sobre o valor, 0 a 100. `2.49` = 2,49%. */
    percentual: numeric('percentual', { precision: 5, scale: 2 }).notNull().default('0'),
    /** Tarifa fixa por transação, em reais. */
    valorFixo: numeric('valor_fixo', { precision: 10, scale: 2 }).notNull().default('0'),
    /** Quantas parcelas o adquirente antecipa nesta taxa. Documental. */
    observacao: text('observacao'),
    vigenciaInicio: date('vigencia_inicio').notNull(),
    /** Inclusive. Nulo = vigente. */
    vigenciaFim: date('vigencia_fim'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('taxa_meio_idx').on(t.clinicaId, t.meio, t.vigenciaInicio),
    check(
      'taxa_meio_percentual_faixa',
      sql`${t.percentual} >= 0 and ${t.percentual} <= 100`,
    ),
    check('taxa_meio_fixo_nao_negativo', sql`${t.valorFixo} >= 0`),
    check(
      'taxa_meio_vigencia_coerente',
      sql`${t.vigenciaFim} is null or ${t.vigenciaFim} >= ${t.vigenciaInicio}`,
    ),
    // `dinheiro` não tem taxa, e uma linha dizendo que tem é erro de cadastro que
    // aparece como caixa menor sem explicação.
    check('taxa_meio_dinheiro_sem_taxa', sql`${t.meio} <> 'dinheiro'`),
  ],
)

/**
 * A cobrança Pix emitida para uma parcela — o QR que o paciente lê.
 *
 * ── Por que existe uma tabela, e não só um campo em `pagamento` ─────────────
 * O QR nasce **antes** do dinheiro. Entre a emissão e a liquidação existe um estado
 * ("emiti, o paciente não pagou ainda") que não é um pagamento e não pode virar
 * linha em `pagamento` — senão o caixa contaria intenção como recebimento, que é
 * exatamente a mentira que esta fase existe para corrigir, invertida.
 *
 * `pagamento_id` é preenchido na liquidação: é o elo que diz "este QR virou aquele
 * dinheiro". Nulo enquanto pendente.
 */
export const intencaoPix = pgTable(
  'intencao_pix',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    parcelaId: uuid('parcela_id').notNull(),
    /**
     * O identificador da cobrança no PSP (26 a 35 caracteres no padrão do Banco
     * Central). Único por clínica: é por ele que o webhook acha a cobrança.
     */
    txid: text('txid').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    situacao: situacaoPixEnum('situacao').notNull().default('pendente'),
    /** O "copia e cola" (BR Code). Guardado para reenviar sem emitir outra cobrança. */
    copiaECola: text('copia_e_cola'),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    /**
     * Identificador da LIQUIDAÇÃO no arranjo Pix (`E` + ISPB + timestamp + sufixo).
     * Vem no evento de pagamento, não na emissão — é a prova de que o dinheiro caiu.
     */
    endToEndId: text('end_to_end_id'),
    pagamentoId: uuid('pagamento_id'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    liquidadoEm: timestamp('liquidado_em', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'intencao_pix_parcela_id_parcela_id_fk',
      columns: [t.parcelaId, t.clinicaId],
      foreignColumns: [parcela.id, parcela.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'intencao_pix_pagamento_id_pagamento_id_fk',
      columns: [t.pagamentoId, t.clinicaId],
      foreignColumns: [pagamento.id, pagamento.clinicaId],
    }).onDelete('restrict'),
    uniqueIndex('intencao_pix_txid_uk').on(t.clinicaId, t.txid),
    index('intencao_pix_parcela_idx').on(t.parcelaId),
    check('intencao_pix_valor_positivo', sql`${t.valor} > 0`),
    /**
     * Estado e evidência andam juntos. `paga` sem `end_to_end_id` seria uma
     * liquidação sem prova; `end_to_end_id` sem `pagamento_id` seria dinheiro que
     * caiu e não entrou no caixa. Os dois casos são conciliação que não fecha, e o
     * CHECK os torna impossíveis em vez de improváveis.
     */
    check(
      'intencao_pix_liquidacao_coerente',
      sql`(${t.situacao} = 'pago') = (${t.endToEndId} is not null
           and ${t.pagamentoId} is not null and ${t.liquidadoEm} is not null)`,
    ),
  ],
)

/**
 * Cada notificação recebida do PSP. **É aqui que a idempotência mora.**
 *
 * ── Por que gravar o evento antes de mexer em dinheiro ──────────────────────
 * PSP reentrega. É o comportamento correto dele: se não recebeu 200, tenta de novo —
 * e vai tentar depois de um timeout nosso, de um deploy no meio, de um 500. A
 * segunda notificação carrega **o mesmo `end_to_end_id`**, porque é a mesma
 * liquidação.
 *
 * Então o `INSERT` aqui vem primeiro, e `(clinica_id, end_to_end_id)` é único: a
 * reentrega **colide no índice** e o processamento nem começa. A alternativa
 * ("verifica se já existe, se não existe processa") tem janela entre a verificação e
 * a escrita, e duas entregas simultâneas conciliam duas vezes — dinheiro em dobro no
 * caixa, com o extrato mostrando uma entrada só.
 *
 * É a mesma ideia de `mensagem_whatsapp.chave_idempotencia`, que existe para não
 * mandar dois lembretes ao mesmo paciente. Aqui o custo do erro é maior.
 *
 * ── Por que o payload inteiro fica guardado ─────────────────────────────────
 * Quando a conciliação de um mês é contestada, a pergunta é "o que o PSP nos disse,
 * exatamente?". Resposta reconstruída a partir de campos extraídos não serve; o
 * `jsonb` bruto serve. Ele **não** contém dado clínico — é valor, data e
 * identificador de transação.
 */
export const eventoPix = pgTable(
  'evento_pix',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** `E`+ISPB+… — a chave de idempotência, única por clínica. */
    endToEndId: text('end_to_end_id').notNull(),
    txid: text('txid').notNull(),
    valor: numeric('valor', { precision: 10, scale: 2 }).notNull(),
    /** Instante da liquidação informado pelo PSP, não o da chegada aqui. */
    liquidadoEm: timestamp('liquidado_em', { withTimezone: true }).notNull(),
    recebidoEm: timestamp('recebido_em', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload').notNull(),
    /**
     * Quando o evento foi transformado em pagamento. Nulo = chegou e não casou com
     * cobrança nenhuma — e isso é visível de propósito, porque Pix recebido sem
     * cobrança correspondente é dinheiro na conta que ninguém sabe de quem é.
     */
    processadoEm: timestamp('processado_em', { withTimezone: true }),
    motivoNaoProcessado: text('motivo_nao_processado'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('evento_pix_e2e_uk').on(t.clinicaId, t.endToEndId),
    index('evento_pix_txid_idx').on(t.clinicaId, t.txid),
    index('evento_pix_pendentes_idx')
      .on(t.clinicaId, t.recebidoEm)
      .where(sql`${t.processadoEm} is null`),
    check('evento_pix_valor_positivo', sql`${t.valor} > 0`),
    check(
      'evento_pix_nao_processado_justificado',
      sql`${t.processadoEm} is not null or ${t.motivoNaoProcessado} is not null`,
    ),
  ],
)
