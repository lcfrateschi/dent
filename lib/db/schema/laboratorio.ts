import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { despesa } from './despesas'
import { situacaoOrdemLaboratorioEnum } from './enums'
import { proximoNumero } from './numeracao'
import { clinicaId } from './tenant'
import { itemPlano } from './tratamento'

/** Laboratório de prótese. Uma clínica trabalha com dois ou três. */
export const laboratorio = pgTable(
  'laboratorio',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    contatoNome: text('contato_nome'),
    contatoTelefone: varchar('contato_telefone', { length: 20 }),
    cnpj: varchar('cnpj', { length: 14 }),
    /** Prazo combinado, em dias. Pré-preenche a ordem; a ordem pode divergir. */
    prazoPadraoDias: smallint('prazo_padrao_dias').notNull().default(7),
    observacoes: text('observacoes'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('laboratorio_nome_por_clinica_uk').on(t.clinicaId, t.nome),
    check('laboratorio_prazo_positivo', sql`${t.prazoPadraoDias} > 0`),
  ],
)

/**
 * Ordem de serviço de prótese: a peça sai, o laboratório trabalha, a peça volta,
 * e o paciente espera.
 *
 * ── Por que ela pende de `item_plano`, e não é cadastro solto ──────────────
 * A prótese é uma linha do plano de tratamento — tem procedimento, dente, valor e
 * cobertura. Uma ordem sem item de plano seria um custo sem receita
 * correspondente, e a margem da prótese (que é onde a clínica ganha ou perde nesse
 * procedimento) não fecharia. Por isso `item_plano_id` é **obrigatório**.
 *
 * ── Por que ela NÃO cria despesa automaticamente ──────────────────────────
 * A tentação é óbvia: a ordem tem custo, despesa tem valor, ligue os dois. Não
 * liga, e o motivo é o faturamento do laboratório — ele **cobra por mês**, uma nota
 * cobrindo várias peças. Uma despesa por ordem produziria N lançamentos que não
 * casam com a nota, e a conciliação bancária não fecharia nunca; é o mesmo
 * raciocínio que fez a conciliação Pix casar por `end_to_end_id` em vez de por
 * "valor e data parecidos".
 *
 * Então: `custo` aqui é o **valor combinado** — serve para a margem do item e para
 * conferir a nota quando ela chegar. A despesa é a nota, lançada à mão, e
 * `despesa_id` liga as duas quando a clínica quiser rastrear. Sem contagem dupla.
 */
export const ordemLaboratorio = pgTable(
  'ordem_laboratorio',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Número legível, por clínica — é o que o laboratório cita ao telefone. */
    numero: integer('numero').notNull().default(proximoNumero('ordem_laboratorio')),
    laboratorioId: uuid('laboratorio_id').notNull(),
    itemPlanoId: uuid('item_plano_id').notNull(),
    /** O que fazer. Texto porque especificação de prótese não cabe em enum. */
    especificacao: text('especificacao').notNull(),
    /** Cor da escala (Vita A2, B1…). Prótese com a cor errada volta para refação. */
    cor: varchar('cor', { length: 20 }),
    situacao: situacaoOrdemLaboratorioEnum('situacao').notNull().default('aberta'),
    enviadaEm: timestamp('enviada_em', { withTimezone: true }),
    /** Dia civil combinado para a peça voltar — é data de compromisso, não instante. */
    prazoEm: date('prazo_em'),
    recebidaEm: timestamp('recebida_em', { withTimezone: true }),
    custo: numeric('custo', { precision: 10, scale: 2 }).notNull().default('0'),
    /**
     * Ordem que esta refaz. Refação não é situação: é ordem nova apontando para a
     * anterior, porque "quem paga a refação" é pergunta que precisa das duas linhas
     * para ser respondida — e porque apagar o histórico da peça que não serviu é
     * apagar a evidência da conversa com o laboratório.
     */
    refazId: uuid('refaz_id'),
    motivoRefacao: text('motivo_refacao'),
    /** A nota do laboratório, quando a clínica quiser ligar as duas. Ver o cabeçalho. */
    despesaId: uuid('despesa_id'),
    observacao: text('observacao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'ordem_laboratorio_laboratorio_id_laboratorio_id_fk',
      columns: [t.laboratorioId, t.clinicaId],
      foreignColumns: [laboratorio.id, laboratorio.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ordem_laboratorio_item_plano_id_item_plano_id_fk',
      columns: [t.itemPlanoId, t.clinicaId],
      foreignColumns: [itemPlano.id, itemPlano.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ordem_laboratorio_refaz_id_ordem_laboratorio_id_fk',
      columns: [t.refazId, t.clinicaId],
      foreignColumns: [t.id, t.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ordem_laboratorio_despesa_id_despesa_id_fk',
      columns: [t.despesaId, t.clinicaId],
      foreignColumns: [despesa.id, despesa.clinicaId],
    }).onDelete('set null'),
    uniqueIndex('ordem_laboratorio_numero_por_clinica_uk').on(t.clinicaId, t.numero),
    index('ordem_laboratorio_situacao_idx').on(t.clinicaId, t.situacao, t.prazoEm),
    check('ordem_laboratorio_custo_nao_negativo', sql`${t.custo} >= 0`),
    check(
      'ordem_laboratorio_refacao_justificada',
      sql`${t.refazId} is null or ${t.motivoRefacao} is not null`,
    ),
    /* Recebida antes de enviada é digitação, não história. */
    check(
      'ordem_laboratorio_recebida_depois_de_enviada',
      sql`${t.recebidaEm} is null or ${t.enviadaEm} is null or ${t.recebidaEm} >= ${t.enviadaEm}`,
    ),
    /* Situação e evidência andam juntas — "recebida" sem data de recebimento é
       estado sem fato, igual a cobrança Pix "paga" sem `end_to_end_id`. */
    check(
      'ordem_laboratorio_situacao_com_evidencia',
      sql`(${t.situacao} <> 'enviada' or ${t.enviadaEm} is not null)
          and (${t.situacao} <> 'recebida' or (${t.enviadaEm} is not null and ${t.recebidaEm} is not null))`,
    ),
  ],
)
