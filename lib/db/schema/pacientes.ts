import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { baseLegalEnum, sexoEnum, statusPacienteEnum } from './enums'

export const paciente = pgTable(
  'paciente',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    nomeSocial: text('nome_social'),
    cpf: varchar('cpf', { length: 11 }),
    rg: varchar('rg', { length: 20 }),
    dataNascimento: date('data_nascimento').notNull(),
    sexo: sexoEnum('sexo').notNull().default('nao_informado'),
    telefone: varchar('telefone', { length: 20 }),
    /** Destino das mensagens da Fase 9. Pode diferir do telefone principal. */
    telefoneWhatsapp: varchar('telefone_whatsapp', { length: 20 }),
    email: text('email'),

    cep: varchar('cep', { length: 8 }),
    logradouro: text('logradouro'),
    numero: varchar('numero', { length: 20 }),
    complemento: text('complemento'),
    bairro: text('bairro'),
    cidade: text('cidade'),
    uf: varchar('uf', { length: 2 }),

    /**
     * Preenchido quando o paciente é menor de idade ou incapaz.
     * O responsável assina consentimento e orçamento em nome dele.
     */
    responsavelLegalId: uuid('responsavel_legal_id').references((): AnyPgColumn => paciente.id, {
      onDelete: 'set null',
    }),
    /** Como conheceu a clínica — alimenta o relatório de origem da Fase 11. */
    indicadoPor: text('indicado_por'),
    observacoes: text('observacoes'),
    status: statusPacienteEnum('status').notNull().default('ativo'),
    primeiraConsultaEm: date('primeira_consulta_em'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // CPF é opcional (criança costuma não ter), mas único quando presente.
    uniqueIndex('paciente_cpf_uk').on(t.cpf).where(sql`${t.cpf} is not null`),
    index('paciente_nome_idx').on(sql`lower(${t.nome})`),
    index('paciente_responsavel_idx').on(t.responsavelLegalId),
  ],
)

/**
 * Credencial do portal do paciente (Fase 12).
 * Tabela e sessão distintas de `usuario` por decisão de segurança — CLAUDE.md, decisão 2.
 */
export const pacienteConta = pgTable(
  'paciente_conta',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .unique()
      .references(() => paciente.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    senhaHash: text('senha_hash').notNull(),
    emailVerificadoEm: timestamp('email_verificado_em', { withTimezone: true }),
    ativo: boolean('ativo').notNull().default(true),
    ultimoLoginEm: timestamp('ultimo_login_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('paciente_conta_email_uk').on(sql`lower(${t.email})`)],
)

/**
 * Consentimento LGPD. Versionado e imutável: revogar não apaga, preenche `revogado_em`.
 * `texto_hash` prova qual redação foi aceita.
 */
export const consentimento = pgTable(
  'consentimento',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id')
      .notNull()
      .references(() => paciente.id, { onDelete: 'restrict' }),
    baseLegal: baseLegalEnum('base_legal').notNull(),
    finalidade: text('finalidade').notNull(),
    versaoTermo: varchar('versao_termo', { length: 20 }).notNull(),
    textoHash: varchar('texto_hash', { length: 64 }).notNull(),
    /** Quando um responsável legal assina pelo paciente. */
    assinadoPorId: uuid('assinado_por_id').references(() => paciente.id, { onDelete: 'set null' }),
    aceitoEm: timestamp('aceito_em', { withTimezone: true }).notNull().defaultNow(),
    revogadoEm: timestamp('revogado_em', { withTimezone: true }),
    ip: varchar('ip', { length: 45 }),
    userAgent: text('user_agent'),
  },
  (t) => [index('consentimento_paciente_idx').on(t.pacienteId, t.aceitoEm)],
)
