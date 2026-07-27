import { sql } from 'drizzle-orm'
import {
  foreignKey,
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
import { clinicaId } from './tenant'

/**
 * O que se pretende fazer para um paciente. Vivo — muda conforme o tratamento avança.
 * Distinto do orçamento, que é um documento congelado dele. Ver GLOSSARIO.
 */
export const planoTratamento = pgTable(
  'plano_tratamento',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    profissionalId: uuid('profissional_id').notNull(),
    titulo: text('titulo').notNull(),
    diagnostico: text('diagnostico'),
    observacao: text('observacao'),
    status: statusPlanoEnum('status').notNull().default('rascunho'),
    /**
     * Agrupa PROPOSTAS ALTERNATIVAS para a mesma situação clínica — a "proposta A"
     * e a "proposta B" que o paciente escolhe entre (implante × prótese fixa;
     * tratamento completo × o que dá para fazer agora).
     *
     * Planos com o mesmo `grupo_proposta` são **mutuamente exclusivos**: no máximo
     * um deles chega a `ativo`. Nulo = plano independente.
     *
     * ── O que isto NÃO é ────────────────────────────────────────────────────
     * Não é um segundo lugar para guardar "qual o paciente escolheu". Essa
     * informação já existe e está no lugar certo: o **orçamento**, que é documento
     * congelado, com `status` em enviado/aprovado/recusado. Duplicá-la aqui criaria
     * duas verdades sobre a mesma decisão comercial, e a que divergisse seria a que
     * alguém olharia.
     *
     * O índice `plano_um_ativo_por_paciente` **continua existindo e não foi
     * afrouxado** — ele é o que impede o odontograma criar item num plano
     * imprevisível. Propostas alternativas vivem em `rascunho`, quantas forem; a
     * escolhida vira `ativo`, e aí só pode haver uma. A trava por grupo, na
     * `drizzle/0037`, é redundante com ela de propósito: expressa a intenção no
     * nível do grupo, e pega o caso em que alguém amplie a unicidade por paciente
     * um dia sem perceber que o grupo também dependia dela.
     */
    grupoProposta: uuid('grupo_proposta'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
    concluidoEm: timestamp('concluido_em', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'plano_tratamento_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'plano_tratamento_profissional_id_profissional_id_fk',
      columns: [t.profissionalId, t.clinicaId],
      foreignColumns: [profissional.id, profissional.clinicaId],
    }).onDelete('restrict'),
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
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    planoId: uuid('plano_id').notNull(),
    procedimentoId: uuid('procedimento_id').notNull(),
    /** Null para procedimentos gerais (profilaxia, documentação ortodôntica). */
    denteFdi: smallint('dente_fdi').references(() => dente.fdi, { onDelete: 'restrict' }),
    /** Faces atingidas. Validade anatômica checada em lib/domain/faces.ts. */
    faces: faceDenteEnum('faces').array(),

    cobertura: coberturaEnum('cobertura').notNull().default('particular'),
    /** Preenchido só quando cobertura = 'convenio'. */
    convenioId: uuid('convenio_id'),
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
    foreignKey({
      name: 'item_plano_convenio_id_convenio_id_fk',
      columns: [t.convenioId, t.clinicaId],
      foreignColumns: [convenio.id, convenio.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'item_plano_plano_id_plano_tratamento_id_fk',
      columns: [t.planoId, t.clinicaId],
      foreignColumns: [planoTratamento.id, planoTratamento.clinicaId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'item_plano_procedimento_id_procedimento_id_fk',
      columns: [t.procedimentoId, t.clinicaId],
      foreignColumns: [procedimento.id, procedimento.clinicaId],
    }).onDelete('restrict'),
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
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    itemPlanoId: uuid('item_plano_id').notNull(),
    profissionalId: uuid('profissional_id').notNull(),
    agendamentoId: uuid('agendamento_id').references(() => agendamento.id, {
      onDelete: 'set null',
    }),
    executadoEm: timestamp('executado_em', { withTimezone: true }).notNull(),
    observacao: text('observacao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'execucao_item_plano_id_item_plano_id_fk',
      columns: [t.itemPlanoId, t.clinicaId],
      foreignColumns: [itemPlano.id, itemPlano.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'execucao_profissional_id_profissional_id_fk',
      columns: [t.profissionalId, t.clinicaId],
      foreignColumns: [profissional.id, profissional.clinicaId],
    }).onDelete('restrict'),
    index('execucao_item_idx').on(t.itemPlanoId),
    index('execucao_profissional_periodo_idx').on(t.profissionalId, t.executadoEm),
  ],
)
