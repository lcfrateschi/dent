import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { boolean } from 'drizzle-orm/pg-core'
import { paciente } from './pacientes'
import { procedimento } from './referencia'
import { clinicaId } from './tenant'

/**
 * Autoatendimento do paciente (Fase 19).
 *
 * Duas tabelas: a configuração por clínica e a lista de espera. O agendamento em si
 * **não** ganha tabela — ele grava em `agendamento` com `origem = 'portal'`, valor
 * que existe no enum desde a Fase 1 e que nenhum código gravava.
 *
 * Não criar tabela paralela de "pedido de agendamento" é decisão: um agendamento
 * feito pelo paciente é um agendamento, ocupa a mesma cadeira e disputa a mesma
 * EXCLUDE constraint. Uma tabela separada teria de ser reconciliada com a agenda de
 * verdade, e a reconciliação é onde nasce o horário vendido duas vezes.
 */

export const situacaoListaEsperaEnum = pgEnum('situacao_lista_espera', [
  'aguardando',
  /** A recepção ofereceu um horário e o paciente aceitou. */
  'atendida',
  /** O paciente desistiu, ou a recepção descartou com motivo. */
  'encerrada',
])

/** Turno preferido. Grosso de propósito: o paciente não conhece a grade da clínica. */
export const turnoEnum = pgEnum('turno_preferido', ['manha', 'tarde', 'qualquer'])

/**
 * Configuração do autoatendimento, uma linha por clínica.
 *
 * Tabela e não colunas em `clinica` porque são cinco campos de um assunto só, que a
 * clínica liga e desliga junto — e porque `clinica` já tem 20 colunas de
 * identificação e endereço, onde estes se perderiam.
 *
 * Os valores-limite vivem em `lib/domain/autoatendimento.ts` (`REGRA_PADRAO`), e os
 * defaults aqui os repetem. Repetição consciente: o banco precisa de default para a
 * linha nascer válida, e o domínio precisa do valor para a regra ser testável sem
 * banco. O teste `regra_padrao_bate_com_o_banco` em `docker/verificar-invariantes.sql`
 * é o que impede as duas divergirem.
 */
export const regraAutoatendimento = pgTable(
  'regra_autoatendimento',
  {
    clinicaId: clinicaId(),
    /**
     * **Desligado por padrão.** Uma clínica que atualiza o sistema não deve
     * descobrir que a agenda dela abriu para a internet.
     */
    ativo: boolean('ativo').notNull().default(false),
    antecedenciaMinimaHoras: smallint('antecedencia_minima_horas').notNull().default(24),
    antecedenciaMaximaDias: smallint('antecedencia_maxima_dias').notNull().default(60),
    maximoFuturosPorPaciente: smallint('maximo_futuros_por_paciente').notNull().default(2),
    /**
     * Texto do termo que o paciente aceita ao marcar. Vazio = não pede termo.
     * Fica aqui, e não em arquivo, porque o `texto_hash` do consentimento tem de
     * ser o hash do que a clínica **de fato** mostrou naquele dia.
     */
    termoDeAtendimento: text('termo_de_atendimento'),
    versaoTermo: text('versao_termo').notNull().default('v1'),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Uma linha por clínica: `clinica_id` é a chave primária. Duas linhas tornariam
    // indefinido qual limite vale — o mesmo raciocínio de `assinatura`.
    uniqueIndex('regra_autoatendimento_clinica_uk').on(t.clinicaId),
    check(
      'regra_autoatendimento_antecedencia_coerente',
      sql`${t.antecedenciaMinimaHoras} >= 0
          and ${t.antecedenciaMaximaDias} >= 1
          and ${t.antecedenciaMinimaHoras} <= ${t.antecedenciaMaximaDias} * 24`,
    ),
    check(
      'regra_autoatendimento_teto_positivo',
      sql`${t.maximoFuturosPorPaciente} >= 1 and ${t.maximoFuturosPorPaciente} <= 20`,
    ),
  ],
)

/**
 * Lista de espera: o paciente quer um horário mais cedo do que conseguiu.
 *
 * ⚠️ **Não confundir com `encaixe`.** `encaixe` é um valor de `origem_agendamento` e
 * está entre os termos com ⚠️ do `GLOSSARIO.md`, **aguardando validação com o
 * dentista**. Esta tabela é o mecanismo (quem quer ser chamado), não a semântica de
 * encaixe — e de propósito ela **não grava** `origem = 'encaixe'` em nada. Quando a
 * recepção oferecer um horário desta lista, quem decide a origem do agendamento
 * resultante é a recepção, na tela dela.
 */
export const listaEspera = pgTable(
  'lista_espera',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    /** Opcional: o paciente pode só querer "qualquer vaga mais cedo". */
    procedimentoId: uuid('procedimento_id'),
    turno: turnoEnum('turno').notNull().default('qualquer'),
    /** Até quando esperar. Sem isto, a lista cresce e ninguém a limpa. */
    validoAte: timestamp('valido_ate', { withTimezone: true }).notNull(),
    observacao: text('observacao'),
    situacao: situacaoListaEsperaEnum('situacao').notNull().default('aguardando'),
    encerradoEm: timestamp('encerrado_em', { withTimezone: true }),
    motivoEncerramento: text('motivo_encerramento'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'lista_espera_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'lista_espera_procedimento_id_procedimento_id_fk',
      columns: [t.procedimentoId, t.clinicaId],
      foreignColumns: [procedimento.id, procedimento.clinicaId],
    }).onDelete('restrict'),
    index('lista_espera_clinica_idx').on(t.clinicaId),
    /**
     * Um pedido ATIVO por paciente e procedimento.
     *
     * Sem isto, quem clica duas vezes entra duas vezes na fila e a recepção liga
     * duas vezes — o mesmo problema que a chave de idempotência resolve na Fase 18,
     * aqui resolvido por índice parcial porque o "fato" é o próprio par.
     *
     * ── Por que `coalesce` e não a coluna direta ────────────────────────────
     * A primeira versão era `.on(t.pacienteId, t.procedimentoId)`, e **a garantia não
     * valia justamente no caso mais comum**. Em índice único do Postgres, `NULL` não
     * é igual a `NULL` — então duas linhas com `procedimento_id IS NULL` (o paciente
     * que só quer "qualquer vaga mais cedo") não colidiam. Medido: duas linhas ativas
     * para o mesmo paciente, e o índice parecia certo.
     *
     * `NULLS NOT DISTINCT` (Postgres 15+) resolveria e é mais idiomático, mas o
     * `uniqueIndex` do Drizzle não o expressa — e um índice que só existe no banco
     * volta a divergir do snapshot no próximo `db:generate`, como aconteceu com os 29
     * FKs. A sentinela de uuid zerado é expressável nos dois lados e vale para
     * qualquer versão do Postgres.
     *
     * A sentinela é o uuid nulo, que nenhum `gen_random_uuid()` produz.
     */
    uniqueIndex('lista_espera_um_ativo_uk')
      .on(t.pacienteId, sql`coalesce(${t.procedimentoId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.situacao} = 'aguardando'`),
    index('lista_espera_fila_idx').on(t.situacao, t.criadoEm),
    check(
      'lista_espera_encerramento_com_motivo',
      sql`${t.situacao} <> 'encerrada'
          or (${t.motivoEncerramento} is not null and btrim(${t.motivoEncerramento}) <> '')`,
    ),
  ],
)
