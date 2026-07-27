import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { usuario } from './acesso'
import {
  canalContatoEnum,
  resultadoContatoEnum,
  situacaoTarefaEnum,
  tipoRetornoEnum,
  tipoTarefaRelacionamentoEnum,
} from './enums'
import { agendamento } from './agenda'
import { orcamento, parcela } from './financeiro'
import { paciente } from './pacientes'
import { procedimento } from './referencia'
import { execucao, itemPlano } from './tratamento'
import { clinicaId } from './tenant'

/**
 * Relacionamento ativo: as filas de "com quem a clínica precisa falar".
 *
 * ── Por que isto existe ─────────────────────────────────────────────────────
 * O sistema sabia registrar tudo e não sabia **cobrar de si mesmo**. Um orçamento
 * enviado que ninguém respondeu ficava enviado para sempre; `status = 'faltou'`
 * era gravado e morria ali; profilaxia de seis meses dependia de alguém lembrar.
 * Nenhuma dessas coisas aparecia como erro — apareciam como um mês fraco.
 *
 * ── A decisão que sustenta o resto: a chave de idempotência ────────────────
 * Os geradores rodam no laço do despachante, a cada dez minutos, para sempre. O
 * que impede a fila de encher de duplicatas é uma `chave_idempotencia` única, com
 * `ON CONFLICT DO NOTHING` — a mesma ideia que já protege `mensagem_whatsapp`.
 *
 * O detalhe que **não** é óbvio: a chave ignora a `situacao`. Um gerador escrito
 * como "existe tarefa ABERTA para este orçamento? se não, cria" pareceria correto e
 * seria o pior bug possível desta fase — ele recriaria a tarefa **dispensada** na
 * próxima rodada, e a recepção ligaria de novo para quem pediu para não ser
 * incomodado. A chave existe uma vez por FATO (este orçamento, esta falta, esta
 * execução), não uma vez por tarefa aberta.
 *
 * ── Por que TODA FK aqui é `restrict`, inclusive as opcionais ──────────────
 * `set null` ou `cascade` na referência apagariam o rastro de que já falamos com
 * aquela pessoa — e sem o rastro a chave de idempotência não colide, e o gerador
 * recria a tarefa dispensada. Ou seja: **o `restrict` é load-bearing**, não
 * uniformidade estética. Se um dia apagar um orçamento com tarefa parecer
 * necessário, o caminho é resolver a tarefa primeiro, não afrouxar a FK.
 *
 * (Há um segundo motivo, mecânico: `ON DELETE SET NULL` em FK composto precisa da
 * forma com lista de colunas do Postgres 15+, que preserva `clinica_id` — e o
 * Drizzle não sabe expressá-la. Ver o aviso no topo de `lib/db/schema/tenant.ts`.)
 */

/**
 * Regra de retorno programado: procedimento → em quantos meses chamar de volta.
 *
 * É o motor do recall, no modelo do Open Dental adaptado. A clínica decide: raspagem
 * chama em 6 meses, manutenção de orto em 1, exame em 12. Sem tabela de regra, o
 * retorno seria um número fixo no código — e "de quanto em quanto tempo se chama o
 * paciente" é decisão clínica de cada consultório, não constante de software.
 */
export const regraRetorno = pgTable(
  'regra_retorno',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    procedimentoId: uuid('procedimento_id').notNull(),
    /** Em quantos meses depois da execução o paciente deve ser chamado. */
    meses: smallint('meses').notNull(),
    tipo: tipoRetornoEnum('tipo').notNull(),
    ativo: boolean('ativo').notNull().default(true),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'regra_retorno_procedimento_id_procedimento_id_fk',
      columns: [t.procedimentoId, t.clinicaId],
      foreignColumns: [procedimento.id, procedimento.clinicaId],
    }).onDelete('restrict'),
    /**
     * Uma regra por procedimento. Duas tornariam indefinido em quantos meses
     * chamar — e o gerador escolheria "alguma", que é o modo de falha que esta
     * fase toda existe para não repetir.
     */
    uniqueIndex('regra_retorno_procedimento_uk').on(t.clinicaId, t.procedimentoId),
    check('regra_retorno_meses_positivo', sql`${t.meses} between 1 and 120`),
  ],
)

/**
 * Uma tarefa da fila: alguém tem de falar com este paciente, por este motivo.
 *
 * As quatro referências são **mutuamente exclusivas na prática** e todas anuláveis:
 * cada tipo de tarefa usa uma. Um CHECK cobra a coerência entre `tipo` e a
 * referência preenchida — sem ele, uma tarefa de inadimplência sem parcela seria
 * uma linha que a tela não consegue explicar a ninguém.
 */
export const tarefaRelacionamento = pgTable(
  'tarefa_relacionamento',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    tipo: tipoTarefaRelacionamentoEnum('tipo').notNull(),
    pacienteId: uuid('paciente_id').notNull(),
    /**
     * Uma por FATO gerador, para sempre. **Única no mundo, não por clínica**: a
     * chave carrega o uuid da referência, então não colide entre clínicas por
     * construção, e global é a versão mais forte — nenhuma duplicata escapa nem
     * por engano de contexto. Mesmo raciocínio de
     * `mensagem_whatsapp.chave_idempotencia`.
     */
    chaveIdempotencia: text('chave_idempotencia').notNull().unique(),

    orcamentoId: uuid('orcamento_id'),
    agendamentoId: uuid('agendamento_id'),
    itemPlanoId: uuid('item_plano_id'),
    parcelaId: uuid('parcela_id'),
    /** A execução que disparou o retorno programado. */
    execucaoId: uuid('execucao_id'),

    /** Dia civil até quando isto deveria ter sido feito. Ordena a fila. */
    prazo: date('prazo').notNull(),
    situacao: situacaoTarefaEnum('situacao').notNull().default('aberta'),
    /** Quem assumiu. Nulo enquanto ninguém pegou. */
    responsavelId: uuid('responsavel_id'),
    /**
     * Obrigatório ao dispensar. "Não insista" sem motivo é indistinguível de
     * "alguém clicou errado", e a diferença decide se a fila reabre no ano que vem.
     */
    motivoDispensa: text('motivo_dispensa'),
    resolvidoEm: timestamp('resolvido_em', { withTimezone: true }),
    dispensadoEm: timestamp('dispensado_em', { withTimezone: true }),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'tarefa_relacionamento_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tarefa_relacionamento_orcamento_id_orcamento_id_fk',
      columns: [t.orcamentoId, t.clinicaId],
      foreignColumns: [orcamento.id, orcamento.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tarefa_relacionamento_agendamento_id_agendamento_id_fk',
      columns: [t.agendamentoId, t.clinicaId],
      foreignColumns: [agendamento.id, agendamento.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tarefa_relacionamento_item_plano_id_item_plano_id_fk',
      columns: [t.itemPlanoId, t.clinicaId],
      foreignColumns: [itemPlano.id, itemPlano.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tarefa_relacionamento_parcela_id_parcela_id_fk',
      columns: [t.parcelaId, t.clinicaId],
      foreignColumns: [parcela.id, parcela.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tarefa_relacionamento_execucao_id_execucao_id_fk',
      columns: [t.execucaoId, t.clinicaId],
      foreignColumns: [execucao.id, execucao.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tarefa_relacionamento_responsavel_id_usuario_id_fk',
      columns: [t.responsavelId, t.clinicaId],
      foreignColumns: [usuario.id, usuario.clinicaId],
    }).onDelete('restrict'),

    /** A fila da recepção: o que está aberto, pelo prazo mais apertado. */
    index('tarefa_relacionamento_fila_idx').on(t.situacao, t.prazo),
    index('tarefa_relacionamento_paciente_idx').on(t.pacienteId, t.situacao),

    /**
     * `tipo` e referência têm de combinar. A alternativa seria confiar no gerador,
     * e o dia em que um gerador novo esquecer a referência a tela mostra uma linha
     * "falar com o paciente" que ninguém consegue explicar — sem orçamento, sem
     * parcela, sem nada em que clicar.
     */
    check(
      'tarefa_relacionamento_referencia_coerente',
      sql`case ${t.tipo}
            when 'orcamento_sem_resposta' then ${t.orcamentoId} is not null
            when 'inadimplencia'          then ${t.parcelaId} is not null
            when 'aprovado_nao_executado' then ${t.itemPlanoId} is not null
            when 'falta_sem_remarcar'     then ${t.agendamentoId} is not null
            when 'retorno_programado'     then ${t.execucaoId} is not null
          end`,
    ),
    /** Dispensar sem motivo é o caminho para a fila reabrir sem ninguém saber por quê. */
    check(
      'tarefa_relacionamento_dispensa_com_motivo',
      sql`${t.situacao} <> 'dispensada'
          or (${t.motivoDispensa} is not null and btrim(${t.motivoDispensa}) <> '')`,
    ),
  ],
)

/**
 * Cada tentativa de contato. **É o único registro de "quantas vezes ligamos".**
 *
 * Não existe coluna `tentativas` na tarefa, de propósito: um contador
 * desnormalizado seria uma segunda verdade, livre para divergir do log — e é
 * exatamente o tipo de divergência que o projeto acabou de pagar caro no saldo de
 * estoque. A contagem sai de `count(*)` sobre esta tabela.
 *
 * Append-only por disciplina, não por trigger: corrigir um contato registrado
 * errado é registrar outro. Não há trava de banco porque isto não é prontuário —
 * é agenda de trabalho da recepção, e travar `UPDATE` aqui custaria mais em atrito
 * do que a integridade que compraria.
 */
export const contatoRelacionamento = pgTable(
  'contato_relacionamento',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    tarefaId: uuid('tarefa_id').notNull(),
    canal: canalContatoEnum('canal').notNull(),
    resultado: resultadoContatoEnum('resultado').notNull(),
    observacao: text('observacao'),
    /**
     * Quem falou. Anulável porque o contato pode vir do sistema (mensagem
     * automática, quando o template existir), não de uma pessoa.
     */
    registradoPorId: uuid('registrado_por_id'),
    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'contato_relacionamento_tarefa_id_tarefa_relacionamento_id_fk',
      columns: [t.tarefaId, t.clinicaId],
      foreignColumns: [tarefaRelacionamento.id, tarefaRelacionamento.clinicaId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'contato_relacionamento_registrado_por_id_usuario_id_fk',
      columns: [t.registradoPorId, t.clinicaId],
      foreignColumns: [usuario.id, usuario.clinicaId],
    }).onDelete('restrict'),
    index('contato_relacionamento_tarefa_idx').on(t.tarefaId, t.criadoEm),
  ],
)
