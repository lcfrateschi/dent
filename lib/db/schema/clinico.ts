import { sql } from 'drizzle-orm'
import {
  foreignKey,
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { profissional } from './acesso'
import { agendamento } from './agenda'
import { estadoDenteEnum, origemAnamneseEnum, severidadeAlertaEnum } from './enums'
import { paciente } from './pacientes'
import { dente } from './referencia'
import { clinicaId } from './tenant'

/**
 * Questionário de saúde. VERSIONADA: refazer não sobrescreve, insere versão nova.
 * Comparar versões ao longo do tempo é clinicamente relevante.
 */
export const anamnese = pgTable(
  'anamnese',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    profissionalId: uuid('profissional_id').references(() => profissional.id, {
      onDelete: 'set null',
    }),
    versao: integer('versao').notNull(),
    /** Respostas do questionário. JSONB porque o formulário evolui sem migration. */
    respostas: jsonb('respostas').notNull(),
    /** Versão do formulário que gerou estas respostas — necessária para renderizar o histórico. */
    versaoFormulario: varchar('versao_formulario', { length: 20 }).notNull(),
    preenchidaEm: timestamp('preenchida_em', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Quem respondeu: a clínica ou o próprio paciente (Fase 19).
     *
     * ⚠️ **Não é metadado de conveniência — é a diferença entre dado clínico e
     * declaração do paciente.** Anamnese colhida pelo dentista já passou pelo
     * julgamento de quem sabe repetir a pergunta de outro jeito ("toma remédio para
     * pressão?" depois de "é hipertenso?" — a segunda pergunta pega o que a primeira
     * perdeu). Respondida no portal, é o que o paciente entendeu do formulário.
     *
     * Tratar as duas como a mesma coisa é o caminho para um alerta de alergia que
     * ninguém confirmou virar decisão de anestésico.
     */
    origem: origemAnamneseEnum('origem').notNull().default('clinica'),
    /**
     * Quando o dentista CONFERIU uma anamnese autodeclarada.
     *
     * Nulo numa anamnese do portal significa "ainda não passou por profissional", e é
     * assim que a tela do paciente mostra o aviso. Numa anamnese da clínica é nulo
     * também — ela não precisa de conferência, porque quem a colheu é quem conferiria.
     * A trava que garante a coerência das duas colunas é o CHECK em `drizzle/0031`.
     */
    conferidaEm: timestamp('conferida_em', { withTimezone: true }),
    conferidaPorId: uuid('conferida_por_id').references(() => profissional.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    foreignKey({
      name: 'anamnese_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    uniqueIndex('anamnese_paciente_versao_uk').on(t.pacienteId, t.versao),
    check('anamnese_versao_positiva', sql`${t.versao} >= 1`),
  ],
)

/**
 * Condição que precisa aparecer em TODA tela do paciente: alergia, anticoagulante,
 * diabetes, gravidez. Normalmente derivada da anamnese, mas editável à mão.
 */
export const alertaClinico = pgTable(
  'alerta_clinico',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    tipo: text('tipo').notNull(),
    descricao: text('descricao').notNull(),
    severidade: severidadeAlertaEnum('severidade').notNull().default('atencao'),
    /** Anamnese que originou o alerta, quando automático. */
    origemAnamneseId: uuid('origem_anamnese_id').references(() => anamnese.id, {
      onDelete: 'set null',
    }),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'alerta_clinico_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('cascade'),
    index('alerta_paciente_ativo_idx').on(t.pacienteId).where(sql`${t.ativo}`)],
)

/**
 * Estado do dente inteiro, por paciente: ausente, com coroa, com implante.
 *
 * Separado das faces de propósito. Face vem de `item_plano` e `execucao` — é
 * consequência de tratamento. Estado do dente é uma CONSTATAÇÃO do exame
 * clínico: "o 18 não está aqui" não é um procedimento executado, e forçá-lo a
 * ser um criaria item de plano fantasma no financeiro.
 *
 * Linha ausente = dente presente e íntegro. Só o que desvia do normal é gravado.
 */
export const dentePaciente = pgTable(
  'dente_paciente',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    denteFdi: smallint('dente_fdi')
      .notNull()
      .references(() => dente.fdi, { onDelete: 'restrict' }),
    estado: estadoDenteEnum('estado').notNull(),
    observacao: text('observacao'),
    /** Quem constatou. Estado de dente é achado clínico, tem autor. */
    profissionalId: uuid('profissional_id').references(() => profissional.id, {
      onDelete: 'set null',
    }),
    registradoEm: timestamp('registrado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'dente_paciente_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('cascade'),
    // Um estado por dente por paciente — o odontograma sobrescreve, não acumula.
    uniqueIndex('dente_paciente_uk').on(t.pacienteId, t.denteFdi),
    index('dente_paciente_idx').on(t.pacienteId),
  ],
)

/**
 * Registro clínico de um atendimento. **APPEND-ONLY.**
 *
 * Não existe UPDATE nem DELETE — garantido por trigger no banco
 * (drizzle/0001_constraints.sql), não por disciplina no código.
 * Corrigir = inserir nova evolução com `retifica_id` apontando para a anterior.
 * A original permanece visível. Exigência do CFO; guarda mínima de 20 anos.
 */
export const evolucao = pgTable(
  'evolucao',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    profissionalId: uuid('profissional_id').notNull(),
    agendamentoId: uuid('agendamento_id').references(() => agendamento.id, {
      onDelete: 'set null',
    }),
    texto: text('texto').notNull(),
    /** Assinatura do profissional. Sem isso a evolução é rascunho e não vale como prontuário. */
    assinadoEm: timestamp('assinado_em', { withTimezone: true }),
    /** SHA-256 de (texto + profissional + timestamp) — detecta adulteração fora da aplicação. */
    assinaturaHash: varchar('assinatura_hash', { length: 64 }),
    /**
     * Aponta para a evolução que esta retifica. Encadeamento, não substituição:
     * a retificada continua legível no prontuário.
     */
    retificaId: uuid('retifica_id'),
    motivoRetificacao: text('motivo_retificacao'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'evolucao_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'evolucao_profissional_id_profissional_id_fk',
      columns: [t.profissionalId, t.clinicaId],
      foreignColumns: [profissional.id, profissional.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'evolucao_retifica_id_evolucao_id_fk',
      columns: [t.retificaId, t.clinicaId],
      foreignColumns: [t.id, t.clinicaId],
    }).onDelete('restrict'),
    index('evolucao_paciente_idx').on(t.pacienteId, t.criadoEm),
    uniqueIndex('evolucao_retifica_uk').on(t.retificaId).where(sql`${t.retificaId} is not null`),
    check('evolucao_texto_nao_vazio', sql`length(btrim(${t.texto})) > 0`),
    check(
      'evolucao_retificacao_justificada',
      sql`${t.retificaId} is null or ${t.motivoRetificacao} is not null`,
    ),
    check(
      'evolucao_assinatura_completa',
      sql`(${t.assinadoEm} is null) = (${t.assinaturaHash} is null)`,
    ),
  ],
)
