import { sql } from 'drizzle-orm'
import {
  foreignKey,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { agendamento } from './agenda'
import {
  interpretacaoRespostaEnum,
  provedorMensagemEnum,
  situacaoMensagemEnum,
  tipoMensagemEnum,
} from './enums'
import { paciente } from './pacientes'
import { clinicaId } from './tenant'

/**
 * Fila de saída e caixa de entrada do WhatsApp.
 *
 * **Por que uma fila no banco e não uma chamada direta.** Enviar mensagem é I/O
 * para fora que falha, demora e não tem transação. Se a ação "confirmar
 * agendamento" chamasse a Meta direto, três coisas dariam errado: a tela ficaria
 * esperando a rede, um retry do usuário mandaria a mensagem duas vezes, e uma
 * falha da Meta faria rollback de coisa que já aconteceu no mundo.
 *
 * Então a ação só INSERE uma linha aqui, na mesma transação do resto. Quem envia
 * é um processo separado que reivindica linhas pendentes. Isso dá as três
 * propriedades que importam:
 *
 * 1. **Nunca envia duas vezes.** `chave_idempotencia` é UNIQUE. Duas tentativas
 *    de enfileirar o mesmo lembrete são um conflito de chave, não duas mensagens.
 *    E `enviado_em` é imutável depois de preenchido (trigger), então nem um bug
 *    de código consegue marcar a mesma linha como enviada outra vez.
 * 2. **Registro do que foi dito.** `corpo` guarda o texto exato entregue ao
 *    paciente. Sem isso, "vocês me mandaram o horário errado" não tem resposta.
 * 3. **Falha visível.** Mensagem que não saiu fica na tabela com o erro, em vez
 *    de virar exceção perdida no log.
 */

export const mensagemWhatsapp = pgTable(
  'mensagem_whatsapp',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pacienteId: uuid('paciente_id').notNull(),
    /** Lembrete pertence a um atendimento; aviso geral, não. */
    agendamentoId: uuid('agendamento_id'),
    tipo: tipoMensagemEnum('tipo').notNull(),

    /**
     * Chave que torna o envio idempotente. Vem do domínio, não do banco:
     * `lembrete:<agendamentoId>:<inicio ISO>`. Remarcar o atendimento muda o
     * início, logo muda a chave, logo o novo horário recebe lembrete próprio —
     * e reprocessar o mesmo horário não gera nada.
     */
    chaveIdempotencia: text('chave_idempotencia').notNull().unique(),

    /** Destino em E.164 sem `+`, como a Meta exige. Congelado no enfileiramento. */
    destino: varchar('destino', { length: 15 }).notNull(),
    /** Texto exato enviado ao paciente. Prova do que foi dito. */
    corpo: text('corpo').notNull(),
    /** Template aprovado na Meta. Fora da janela de 24h, texto livre é rejeitado. */
    template: text('template'),
    parametros: jsonb('parametros'),

    situacao: situacaoMensagemEnum('situacao').notNull().default('pendente'),
    /** Momento decidido por lib/domain/lembrete.ts — nunca de madrugada. */
    agendadoPara: timestamp('agendado_para', { withTimezone: true }).notNull(),

    provedor: provedorMensagemEnum('provedor'),
    /** `wamid` da Meta. Único quando presente: é como o webhook nos encontra. */
    idExterno: text('id_externo'),

    tentativas: smallint('tentativas').notNull().default(0),
    /** Quando um worker reivindicou a linha. Denuncia envio travado. */
    reivindicadoEm: timestamp('reivindicado_em', { withTimezone: true }),
    enviadoEm: timestamp('enviado_em', { withTimezone: true }),
    entregueEm: timestamp('entregue_em', { withTimezone: true }),
    lidaEm: timestamp('lida_em', { withTimezone: true }),
    falhouEm: timestamp('falhou_em', { withTimezone: true }),
    erroCodigo: text('erro_codigo'),
    erroMensagem: text('erro_mensagem'),

    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp('atualizado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'mensagem_whatsapp_agendamento_id_agendamento_id_fk',
      columns: [t.agendamentoId, t.clinicaId],
      foreignColumns: [agendamento.id, agendamento.clinicaId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mensagem_whatsapp_paciente_id_paciente_id_fk',
      columns: [t.pacienteId, t.clinicaId],
      foreignColumns: [paciente.id, paciente.clinicaId],
    }).onDelete('restrict'),
    // O índice que o worker usa para reivindicar: pendentes já vencidas.
    index('mensagem_pendente_idx')
      .on(t.agendadoPara)
      .where(sql`${t.situacao} = 'pendente'`),
    index('mensagem_paciente_idx').on(t.pacienteId, t.criadoEm),
    index('mensagem_agendamento_idx').on(t.agendamentoId),
    uniqueIndex('mensagem_id_externo_uk')
      .on(t.idExterno)
      .where(sql`${t.idExterno} is not null`),
    check('mensagem_destino_e164', sql`${t.destino} ~ '^55[0-9]{10,11}$'`),
    check('mensagem_corpo_nao_vazio', sql`length(btrim(${t.corpo})) > 0`),
    // Situação e carimbos não podem discordar: "enviada" sem `enviado_em` é uma
    // linha que mente para o relatório, e "pendente" com `enviado_em` é uma
    // mensagem que já saiu esperando para sair de novo.
    //
    // `falhou` fica de fora das duas exigências porque a Meta aceita a chamada
    // (200 + wamid) e só depois avisa por webhook que não entregou. Nesse caso a
    // linha tem `enviado_em` E `falhou_em` — as duas coisas aconteceram.
    check(
      'mensagem_enviada_tem_carimbo',
      sql`case
        when ${t.situacao} in ('enviada','entregue','lida') then ${t.enviadoEm} is not null
        when ${t.situacao} in ('pendente','enviando','cancelada') then ${t.enviadoEm} is null
        else true
      end`,
    ),
    check(
      'mensagem_falhou_tem_motivo',
      sql`${t.situacao} <> 'falhou' or (${t.falhouEm} is not null and ${t.erroMensagem} is not null)`,
    ),
    check('mensagem_tentativas_nao_negativa', sql`${t.tentativas} >= 0`),
  ],
)

/**
 * Mensagem recebida do paciente. Append-only: é fato ocorrido fora daqui.
 *
 * `id_externo` é UNIQUE porque **a Meta reentrega webhook**. Sem essa chave, uma
 * reentrega processaria o mesmo "não posso" duas vezes e cancelaria um
 * agendamento que o paciente já tinha remarcado.
 */
export const respostaWhatsapp = pgTable(
  'resposta_whatsapp',
  {
    clinicaId: clinicaId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** `wamid` da mensagem recebida. A trava contra reentrega de webhook. */
    idExterno: text('id_externo').notNull().unique(),
    /** Quem mandou, em E.164. Pode não casar com paciente nenhum. */
    remetente: varchar('remetente', { length: 15 }).notNull(),
    pacienteId: uuid('paciente_id').references(() => paciente.id, { onDelete: 'set null' }),
    /** A mensagem de saída que provocou esta resposta, quando dá para saber. */
    mensagemId: uuid('mensagem_id').references(() => mensagemWhatsapp.id, {
      onDelete: 'set null',
    }),
    agendamentoId: uuid('agendamento_id').references(() => agendamento.id, {
      onDelete: 'set null',
    }),

    texto: text('texto').notNull(),
    interpretacao: interpretacaoRespostaEnum('interpretacao').notNull(),

    recebidoEm: timestamp('recebido_em', { withTimezone: true }).notNull().defaultNow(),
    /** Preenchido quando a resposta já produziu efeito na agenda. */
    processadoEm: timestamp('processado_em', { withTimezone: true }),
    /** O que o sistema fez. Texto para o humano ler na auditoria. */
    acaoTomada: text('acao_tomada'),
    /** Marcado quando alguém da recepção resolveu um `nao_entendido`. */
    tratadoEm: timestamp('tratado_em', { withTimezone: true }),

    criadoEm: timestamp('criado_em', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('resposta_remetente_idx').on(t.remetente, t.recebidoEm),
    index('resposta_agendamento_idx').on(t.agendamentoId),
    // A fila de trabalho da recepção: o que a máquina não entendeu.
    index('resposta_pendente_humano_idx')
      .on(t.recebidoEm)
      .where(sql`${t.interpretacao} = 'nao_entendido' and ${t.tratadoEm} is null`),
    check('resposta_texto_nao_vazio', sql`length(${t.texto}) > 0`),
  ],
)
