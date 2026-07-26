import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  agendamento,
  mensagemWhatsapp,
  paciente,
  respostaWhatsapp,
  usuario,
  profissional,
} from '@/lib/db/schema'
import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'

/**
 * Leituras da tela de WhatsApp.
 *
 * A ordem das seções da tela vem do que é urgente para a recepção, não do que é
 * bonito de mostrar:
 *
 * 1. **Respostas não entendidas** — alguém escreveu algo e ninguém tratou. É a
 *    única coisa aqui que representa um paciente esperando resposta.
 * 2. **Travadas em "enviando"** — a decisão de não reenviar sozinho só é
 *    defensável se essas linhas ficarem visíveis.
 * 3. **Falhas** — telefone errado no cadastro aparece aqui.
 * 4. **Fila e histórico** — contexto.
 */

export interface PainelWhatsapp {
  readonly pendentes: number
  readonly enviadasHoje: number
  readonly falhadas: number
  readonly travadas: number
  readonly naoEntendidas: number
  readonly provedor: string
}

export async function painelWhatsapp(ator: Ator, agora: Date): Promise<PainelWhatsapp> {
  const inicioDoDia = new Date(agora.getTime() - 24 * 3_600_000)
  const limiteTravada = new Date(agora.getTime() - 15 * 60_000)

  const [linha] = await db
    .select({
      pendentes: count(sql`case when ${mensagemWhatsapp.situacao} = 'pendente' then 1 end`),
      enviadasHoje: count(
        sql`case when ${mensagemWhatsapp.enviadoEm} >= ${inicioDoDia.toISOString()}::timestamptz then 1 end`,
      ),
      falhadas: count(sql`case when ${mensagemWhatsapp.situacao} = 'falhou' then 1 end`),
      travadas: count(
        sql`case when ${mensagemWhatsapp.situacao} = 'enviando' and ${mensagemWhatsapp.reivindicadoEm} <= ${limiteTravada.toISOString()}::timestamptz then 1 end`,
      ),
    })
    .from(mensagemWhatsapp)

  const [naoEntendidas] = await db
    .select({ n: count() })
    .from(respostaWhatsapp)
    .where(and(eq(respostaWhatsapp.interpretacao, 'nao_entendido'), isNull(respostaWhatsapp.tratadoEm)))

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'mensageria',
    detalhes: { tela: 'painel_whatsapp' },
  })

  return {
    pendentes: Number(linha?.pendentes ?? 0),
    enviadasHoje: Number(linha?.enviadasHoje ?? 0),
    falhadas: Number(linha?.falhadas ?? 0),
    travadas: Number(linha?.travadas ?? 0),
    naoEntendidas: Number(naoEntendidas?.n ?? 0),
    // Mostrar o provedor na tela evita a pior confusão possível: a clínica
    // acreditar que está mandando mensagem de verdade quando está no simulado.
    provedor: process.env.WHATSAPP_PROVEDOR === 'meta' ? 'meta' : 'simulado',
  }
}

/** Respostas que a máquina não entendeu e ninguém tratou. A fila de trabalho. */
export async function respostasParaHumano(limite = 50) {
  return db
    .select({
      id: respostaWhatsapp.id,
      texto: respostaWhatsapp.texto,
      remetente: respostaWhatsapp.remetente,
      recebidoEm: respostaWhatsapp.recebidoEm,
      pacienteId: respostaWhatsapp.pacienteId,
      pacienteNome: paciente.nome,
      agendamentoId: respostaWhatsapp.agendamentoId,
      agendamentoInicio: agendamento.inicio,
      agendamentoStatus: agendamento.status,
    })
    .from(respostaWhatsapp)
    .leftJoin(paciente, eq(paciente.id, respostaWhatsapp.pacienteId))
    .leftJoin(agendamento, eq(agendamento.id, respostaWhatsapp.agendamentoId))
    .where(
      and(eq(respostaWhatsapp.interpretacao, 'nao_entendido'), isNull(respostaWhatsapp.tratadoEm)),
    )
    .orderBy(respostaWhatsapp.recebidoEm)
    .limit(limite)
}

/** Últimas respostas interpretadas — o histórico que explica a agenda. */
export async function respostasRecentes(limite = 30) {
  return db
    .select({
      id: respostaWhatsapp.id,
      texto: respostaWhatsapp.texto,
      interpretacao: respostaWhatsapp.interpretacao,
      remetente: respostaWhatsapp.remetente,
      recebidoEm: respostaWhatsapp.recebidoEm,
      acaoTomada: respostaWhatsapp.acaoTomada,
      pacienteId: respostaWhatsapp.pacienteId,
      pacienteNome: paciente.nome,
      tratadoEm: respostaWhatsapp.tratadoEm,
    })
    .from(respostaWhatsapp)
    .leftJoin(paciente, eq(paciente.id, respostaWhatsapp.pacienteId))
    .orderBy(desc(respostaWhatsapp.recebidoEm))
    .limit(limite)
}

/** Mensagens que falharam ou travaram — o que precisa de gente. */
export async function mensagensComProblema(agora: Date, limite = 50) {
  const limiteTravada = new Date(agora.getTime() - 15 * 60_000)
  return db
    .select({
      id: mensagemWhatsapp.id,
      situacao: mensagemWhatsapp.situacao,
      destino: mensagemWhatsapp.destino,
      tipo: mensagemWhatsapp.tipo,
      agendadoPara: mensagemWhatsapp.agendadoPara,
      reivindicadoEm: mensagemWhatsapp.reivindicadoEm,
      tentativas: mensagemWhatsapp.tentativas,
      erroCodigo: mensagemWhatsapp.erroCodigo,
      erroMensagem: mensagemWhatsapp.erroMensagem,
      pacienteId: mensagemWhatsapp.pacienteId,
      pacienteNome: paciente.nome,
      agendamentoId: mensagemWhatsapp.agendamentoId,
      agendamentoInicio: agendamento.inicio,
    })
    .from(mensagemWhatsapp)
    .innerJoin(paciente, eq(paciente.id, mensagemWhatsapp.pacienteId))
    .leftJoin(agendamento, eq(agendamento.id, mensagemWhatsapp.agendamentoId))
    .where(
      sql`(${mensagemWhatsapp.situacao} = 'falhou'
        or (${mensagemWhatsapp.situacao} = 'enviando'
            and ${mensagemWhatsapp.reivindicadoEm} <= ${limiteTravada.toISOString()}::timestamptz))`,
    )
    .orderBy(desc(mensagemWhatsapp.criadoEm))
    .limit(limite)
}

/** A fila: o que ainda vai sair, e quando. */
export async function filaDeEnvio(limite = 50) {
  return db
    .select({
      id: mensagemWhatsapp.id,
      destino: mensagemWhatsapp.destino,
      tipo: mensagemWhatsapp.tipo,
      corpo: mensagemWhatsapp.corpo,
      agendadoPara: mensagemWhatsapp.agendadoPara,
      pacienteId: mensagemWhatsapp.pacienteId,
      pacienteNome: paciente.nome,
      agendamentoInicio: agendamento.inicio,
      profissionalNome: usuario.nome,
    })
    .from(mensagemWhatsapp)
    .innerJoin(paciente, eq(paciente.id, mensagemWhatsapp.pacienteId))
    .leftJoin(agendamento, eq(agendamento.id, mensagemWhatsapp.agendamentoId))
    .leftJoin(profissional, eq(profissional.id, agendamento.profissionalId))
    .leftJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(eq(mensagemWhatsapp.situacao, 'pendente'))
    .orderBy(mensagemWhatsapp.agendadoPara)
    .limit(limite)
}

/** Histórico de mensagens de um paciente — aparece na ficha dele. */
export async function historicoDoPaciente(pacienteId: string, limite = 20) {
  return db
    .select({
      id: mensagemWhatsapp.id,
      tipo: mensagemWhatsapp.tipo,
      situacao: mensagemWhatsapp.situacao,
      corpo: mensagemWhatsapp.corpo,
      agendadoPara: mensagemWhatsapp.agendadoPara,
      enviadoEm: mensagemWhatsapp.enviadoEm,
      lidaEm: mensagemWhatsapp.lidaEm,
      erroMensagem: mensagemWhatsapp.erroMensagem,
    })
    .from(mensagemWhatsapp)
    .where(eq(mensagemWhatsapp.pacienteId, pacienteId))
    .orderBy(desc(mensagemWhatsapp.criadoEm))
    .limit(limite)
}

/**
 * Agendamentos dos próximos dias com a situação do lembrete.
 *
 * É a visão que responde a pergunta da recepção às 18h: "quem de amanhã ainda
 * não confirmou?".
 */
export async function agendaComLembrete(de: Date, ate: Date) {
  return db
    .select({
      agendamentoId: agendamento.id,
      inicio: agendamento.inicio,
      status: agendamento.status,
      confirmadoVia: agendamento.confirmadoVia,
      pacienteId: paciente.id,
      pacienteNome: paciente.nome,
      telefone: paciente.telefone,
      telefoneWhatsapp: paciente.telefoneWhatsapp,
      profissionalNome: usuario.nome,
      mensagemSituacao: mensagemWhatsapp.situacao,
      mensagemAgendadaPara: mensagemWhatsapp.agendadoPara,
      mensagemErro: mensagemWhatsapp.erroMensagem,
    })
    .from(agendamento)
    .innerJoin(paciente, eq(paciente.id, agendamento.pacienteId))
    .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .leftJoin(
      mensagemWhatsapp,
      and(
        eq(mensagemWhatsapp.agendamentoId, agendamento.id),
        eq(mensagemWhatsapp.tipo, 'lembrete_consulta'),
      ),
    )
    .where(
      and(
        gte(agendamento.inicio, de),
        sql`${agendamento.inicio} < ${ate.toISOString()}::timestamptz`,
        inArray(agendamento.status, ['agendado', 'confirmado']),
      ),
    )
    .orderBy(agendamento.inicio)
}
