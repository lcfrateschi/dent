import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { HORARIO_PADRAO } from '@/lib/domain/horario'
import { baseComissaoEnum, perfilUsuarioEnum } from './enums'

/**
 * Configuração da clínica. Single-tenant: existe exatamente uma linha, com id = 1.
 * Não é `clinica_id` em outras tabelas — é só configuração.
 */
export const clinica = pgTable(
  'clinica',
  {
    id: smallint('id').primaryKey().default(1),
    razaoSocial: text('razao_social').notNull(),
    nomeFantasia: text('nome_fantasia'),
    cnpj: varchar('cnpj', { length: 14 }),
    croResponsavel: varchar('cro_responsavel', { length: 20 }),
    ufCroResponsavel: varchar('uf_cro_responsavel', { length: 2 }),
    telefone: varchar('telefone', { length: 20 }),
    email: text('email'),
    cep: varchar('cep', { length: 8 }),
    logradouro: text('logradouro'),
    numero: varchar('numero', { length: 20 }),
    complemento: text('complemento'),
    bairro: text('bairro'),
    cidade: text('cidade'),
    uf: varchar('uf', { length: 2 }),
    /** Base de cálculo da comissão, padrão da clínica. Ver GLOSSARIO.md. */
    baseComissao: baseComissaoEnum('base_comissao').notNull().default('valor_recebido'),
    /**
     * Fuso da clínica. A agenda converte instante ↔ hora local por aqui, nunca
     * pelo fuso do servidor — senão o mesmo atendimento aparece em horas
     * diferentes no container e na máquina do dentista. Ver lib/domain/fuso.ts.
     */
    fusoHorario: text('fuso_horario').notNull().default('America/Sao_Paulo'),
    /**
     * Faixas de atendimento por dia da semana ('0'..'6' → [{inicio, fim}]).
     * Duas faixas por dia é o normal: quase todo consultório fecha para almoço.
     * Validado por lib/domain/horario.ts.
     */
    horarioFuncionamento: jsonb('horario_funcionamento').notNull().default(HORARIO_PADRAO),
    /** Granularidade dos horários oferecidos na agenda, em minutos. */
    passoAgendaMinutos: smallint('passo_agenda_minutos').notNull().default(15),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('clinica_singleton', sql`${t.id} = 1`)],
)

/**
 * Usuário interno (staff). Realm de autenticação SEPARADO de `paciente_conta`.
 * Nunca compartilhe query entre os dois — ver CLAUDE.md, decisão 2.
 */
export const usuario = pgTable(
  'usuario',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nome: text('nome').notNull(),
    email: text('email').notNull(),
    senhaHash: text('senha_hash').notNull(),
    perfil: perfilUsuarioEnum('perfil').notNull(),
    /**
     * MFA é obrigatório para staff (dado de saúde).
     *
     * ⚠️ O segredo TOTP está em texto claro. Quem lê esta coluna gera códigos
     * válidos — mas para usá-los ainda precisa da senha, então não é bypass de
     * autenticação; é agravamento de um vazamento de banco. Cifrar exige uma
     * chave fora do banco e rotação, e está no ROADMAP como dívida.
     */
    mfaSecret: text('mfa_secret'),
    mfaAtivo: boolean('mfa_ativo').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
    ultimoLoginEm: timestamp('ultimo_login_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('usuario_email_uk').on(sql`lower(${t.email})`)],
)

/** Dentista. 1:1 com um `usuario` de perfil 'dentista'. */
export const profissional = pgTable(
  'profissional',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    usuarioId: uuid('usuario_id')
      .notNull()
      .unique()
      .references(() => usuario.id, { onDelete: 'restrict' }),
    cro: varchar('cro', { length: 20 }).notNull(),
    ufCro: varchar('uf_cro', { length: 2 }).notNull(),
    especialidade: text('especialidade'),
    /** Percentual de comissão, 0–100. Base definida em `clinica.base_comissao`. */
    comissaoPct: numeric('comissao_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('profissional_cro_uk').on(t.cro, t.ufCro),
    check('profissional_comissao_faixa', sql`${t.comissaoPct} >= 0 and ${t.comissaoPct} <= 100`),
  ],
)
