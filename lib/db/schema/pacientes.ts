import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
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
 * Credencial do portal do paciente.
 *
 * Tabela e sessão distintas de `usuario` por decisão de segurança — CLAUDE.md,
 * decisão 2. **Não existe coluna que ligue esta tabela a `usuario`**, e isso é
 * proposital: nenhuma consulta deve poder ir de um realm ao outro por join.
 *
 * `senha_hash` é NULA até o paciente definir a senha. O acesso começa por um
 * convite de uso único que a recepção entrega — não há envio de e-mail no sistema,
 * e inventar uma senha para o paciente seria pior: ela circularia por WhatsApp e
 * ficaria válida.
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
    /** Nulo até o primeiro acesso. Ver `token_convite_hash`. */
    senhaHash: text('senha_hash'),
    senhaDefinidaEm: timestamp('senha_definida_em', { withTimezone: true }),
    /**
     * SHA-256 do convite de primeiro acesso. **Nunca o token em claro**: quem lê
     * o banco não consegue entrar na conta de ninguém.
     */
    tokenConviteHash: varchar('token_convite_hash', { length: 64 }),
    tokenConviteExpiraEm: timestamp('token_convite_expira_em', { withTimezone: true }),
    /** Bloqueio temporário por tentativas erradas de senha. */
    bloqueadoAte: timestamp('bloqueado_ate', { withTimezone: true }),
    emailVerificadoEm: timestamp('email_verificado_em', { withTimezone: true }),
    ativo: boolean('ativo').notNull().default(true),
    ultimoLoginEm: timestamp('ultimo_login_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('paciente_conta_email_uk').on(sql`lower(${t.email})`),
    // Convite pendente é encontrado pelo hash na hora de validar.
    index('paciente_conta_convite_idx')
      .on(t.tokenConviteHash)
      .where(sql`${t.tokenConviteHash} is not null`),
    check(
      'paciente_conta_convite_tem_prazo',
      sql`${t.tokenConviteHash} is null or ${t.tokenConviteExpiraEm} is not null`,
    ),
    check(
      'paciente_conta_senha_tem_carimbo',
      sql`(${t.senhaHash} is null) = (${t.senhaDefinidaEm} is null)`,
    ),
  ],
)

/**
 * Sessão do portal.
 *
 * **Token opaco no banco, não JWT.** A escolha é deliberada e é o ponto de
 * segurança mais consequente desta fase:
 *
 * - **Dá para revogar.** Se o paciente perde o celular, ou a clínica precisa
 *   cortar o acesso, apagar a linha encerra a sessão na hora. Um JWT assinado
 *   vale até expirar, e não há como chamá-lo de volta.
 * - **O cookie não vale nada sem o banco.** Só o SHA-256 do token é guardado:
 *   quem lê a tabela não consegue montar um cookie válido.
 * - **Cada uso deixa rastro.** `ultimo_uso_em` e `ip` respondem "de onde essa
 *   conta foi acessada", que é a pergunta que aparece depois de uma suspeita.
 *
 * O preço é uma consulta por requisição. Para um portal de consultório, com
 * dezenas de acessos por dia, isso não é custo — é o que compra a revogação.
 */
export const pacienteSessao = pgTable(
  'paciente_sessao',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contaId: uuid('conta_id')
      .notNull()
      .references(() => pacienteConta.id, { onDelete: 'cascade' }),
    /** SHA-256 do token que está no cookie. O token em si nunca é gravado. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    expiraEm: timestamp('expira_em', { withTimezone: true }).notNull(),
    ultimoUsoEm: timestamp('ultimo_uso_em', { withTimezone: true }).notNull().defaultNow(),
    revogadaEm: timestamp('revogada_em', { withTimezone: true }),
    /** Quem revogou, quando foi a clínica. Nulo = o próprio paciente saiu. */
    revogadaPorUsuarioId: uuid('revogada_por_usuario_id'),
    ip: varchar('ip', { length: 45 }),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('paciente_sessao_conta_idx').on(t.contaId, t.criadoEm),
    check('paciente_sessao_prazo_futuro', sql`${t.expiraEm} > ${t.criadoEm}`),
  ],
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
