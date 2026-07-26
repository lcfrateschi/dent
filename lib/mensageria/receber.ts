import { registrarDoPaciente } from '@/lib/auditoria/registrar'
import { db } from '@/lib/db'
import { agendamento, mensagemWhatsapp, paciente, respostaWhatsapp } from '@/lib/db/schema'
import type { Interpretacao } from '@/lib/domain/whatsapp'
import { paraE164 } from '@/lib/domain/whatsapp'
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { AtualizacaoStatus, MensagemRecebida } from './payload'

/**
 * O efeito de uma resposta do paciente na agenda.
 *
 * É o ponto mais delicado da Fase 9: uma mensagem de WhatsApp muda o estado da
 * clínica. Quatro regras seguram isso:
 *
 * 1. **Reentrega não conta duas vezes.** `resposta_whatsapp.id_externo` é UNIQUE
 *    e a inserção usa `ON CONFLICT DO NOTHING`. A Meta reentrega webhook quando
 *    não recebe 200 rápido; sem essa trava, o mesmo "não posso" cancelaria duas
 *    vezes — e a segunda poderia cancelar o horário que a recepção já remarcou.
 * 2. **Não entendido não age.** Só `confirmou` e `cancelou` mexem na agenda.
 *    Dúvida vira fila para humano.
 * 3. **Só age no atendimento certo.** O vínculo vem do lembrete que foi enviado
 *    para aquele número, e o atendimento tem de estar no futuro e em estado que
 *    permita a mudança.
 * 4. **Fica registrado quem pediu.** `audit_log` com ator `paciente` e o texto
 *    original na `resposta_whatsapp`. Quando alguém perguntar "por que este
 *    horário foi cancelado?", a resposta é literal.
 */

export interface ResultadoResposta {
  readonly registrada: boolean
  readonly respostaId?: string
  readonly interpretacao: Interpretacao
  readonly acao: string
  readonly agendamentoId?: string
  readonly pacienteId?: string
}

export async function processarMensagemRecebida(
  m: MensagemRecebida,
  agora: Date = new Date(),
): Promise<ResultadoResposta> {
  const remetente = normalizarRemetente(m.remetente)

  const vinculo = remetente
    ? await localizarVinculo(remetente, agora)
    : { pacienteId: null, mensagemId: null, agendamentoId: null }

  const [criada] = await db
    .insert(respostaWhatsapp)
    .values({
      idExterno: m.idExterno,
      remetente: remetente ?? m.remetente.slice(0, 15),
      pacienteId: vinculo.pacienteId,
      mensagemId: vinculo.mensagemId,
      agendamentoId: vinculo.agendamentoId,
      texto: m.texto,
      interpretacao: m.interpretacao,
      recebidoEm: m.recebidoEm,
    })
    .onConflictDoNothing({ target: respostaWhatsapp.idExterno })
    .returning({ id: respostaWhatsapp.id })

  if (!criada) {
    // Reentrega da Meta. Já foi processada; responder 200 e sair.
    return {
      registrada: false,
      interpretacao: m.interpretacao,
      acao: 'Reentrega de webhook — já havia sido processada.',
    }
  }

  const acao = await aplicarNaAgenda({
    respostaId: criada.id,
    interpretacao: m.interpretacao,
    agendamentoId: vinculo.agendamentoId,
    pacienteId: vinculo.pacienteId,
    texto: m.texto,
    agora,
  })

  await db
    .update(respostaWhatsapp)
    .set({ processadoEm: agora, acaoTomada: acao })
    .where(eq(respostaWhatsapp.id, criada.id))

  if (vinculo.pacienteId) {
    await registrarDoPaciente({
      acao: m.interpretacao === 'nao_entendido' ? 'criacao' : 'atualizacao',
      entidade: 'resposta_whatsapp',
      entidadeId: criada.id,
      pacienteId: vinculo.pacienteId,
      // Metadado, não conteúdo clínico: interpretação e efeito, não o prontuário.
      detalhes: {
        interpretacao: m.interpretacao,
        agendamentoId: vinculo.agendamentoId,
        acao,
        canal: 'whatsapp',
      },
    })
  }

  return {
    registrada: true,
    respostaId: criada.id,
    interpretacao: m.interpretacao,
    acao,
    agendamentoId: vinculo.agendamentoId ?? undefined,
    pacienteId: vinculo.pacienteId ?? undefined,
  }
}

function normalizarRemetente(bruto: string): string | null {
  try {
    return paraE164(bruto)
  } catch {
    // Número estrangeiro ou lixo: registra como veio, sem vincular a paciente.
    return null
  }
}

/**
 * Descobre paciente, lembrete e atendimento a partir do número.
 *
 * O caminho é o lembrete, não o cadastro: procura a última mensagem enviada
 * para aquele número que aponta para um atendimento futuro. Se a clínica manda
 * lembrete e o paciente responde, é desse atendimento que ele está falando.
 */
async function localizarVinculo(
  remetente: string,
  agora: Date,
): Promise<{
  pacienteId: string | null
  mensagemId: string | null
  agendamentoId: string | null
}> {
  const [lembrete] = await db
    .select({
      mensagemId: mensagemWhatsapp.id,
      pacienteId: mensagemWhatsapp.pacienteId,
      agendamentoId: mensagemWhatsapp.agendamentoId,
    })
    .from(mensagemWhatsapp)
    .innerJoin(agendamento, eq(agendamento.id, mensagemWhatsapp.agendamentoId))
    .where(
      and(
        eq(mensagemWhatsapp.destino, remetente),
        eq(mensagemWhatsapp.tipo, 'lembrete_consulta'),
        inArray(mensagemWhatsapp.situacao, ['enviada', 'entregue', 'lida']),
        gt(agendamento.inicio, agora),
      ),
    )
    .orderBy(desc(mensagemWhatsapp.enviadoEm))
    .limit(1)

  if (lembrete) {
    return {
      pacienteId: lembrete.pacienteId,
      mensagemId: lembrete.mensagemId,
      agendamentoId: lembrete.agendamentoId,
    }
  }

  // Sem lembrete correspondente: ainda vale identificar o paciente pelo número,
  // para a recepção saber quem escreveu. Mas nada é alterado na agenda.
  return { pacienteId: await pacientePorTelefone(remetente), mensagemId: null, agendamentoId: null }
}

/**
 * Paciente por telefone.
 *
 * O cadastro guarda o telefone como foi digitado — '(11) 98765-4321', '11
 * 8765-4321' de antes do nono dígito. Comparar texto com texto não acha nada.
 * Então o filtro grosso é feito no banco pelos últimos 8 dígitos (que o nono
 * dígito não mudou) e a comparação exata em `paraE164`, a mesma função que gerou
 * o destino.
 */
async function pacientePorTelefone(e164: string): Promise<string | null> {
  const oitoFinais = e164.slice(-8)

  const candidatos = await db
    .select({ id: paciente.id, telefone: paciente.telefone, whatsapp: paciente.telefoneWhatsapp })
    .from(paciente)
    .where(
      sql`regexp_replace(coalesce(${paciente.telefoneWhatsapp}, ${paciente.telefone}, ''), '\\D', '', 'g') like ${`%${oitoFinais}`}`,
    )
    .limit(20)

  for (const c of candidatos) {
    const bruto = c.whatsapp ?? c.telefone
    if (!bruto) continue
    try {
      if (paraE164(bruto) === e164) return c.id
    } catch {
      // Telefone inválido no cadastro não impede achar os outros candidatos.
    }
  }
  return null
}

async function statusAtual(agendamentoId: string): Promise<string> {
  const [a] = await db
    .select({ status: agendamento.status })
    .from(agendamento)
    .where(eq(agendamento.id, agendamentoId))
  return a?.status ?? 'inexistente'
}

async function aplicarNaAgenda(p: {
  respostaId: string
  interpretacao: Interpretacao
  agendamentoId: string | null
  pacienteId: string | null
  texto: string
  agora: Date
}): Promise<string> {
  if (p.interpretacao === 'nao_entendido') {
    return 'Resposta não interpretada — encaminhada para a recepção.'
  }
  if (!p.agendamentoId) {
    return 'Sem lembrete correspondente a um atendimento futuro — nada alterado na agenda.'
  }

  if (p.interpretacao === 'confirmou') {
    const feitas = await db
      .update(agendamento)
      .set({
        status: 'confirmado',
        confirmadoEm: p.agora,
        confirmadoVia: 'whatsapp',
      })
      .where(
        and(
          eq(agendamento.id, p.agendamentoId),
          eq(agendamento.status, 'agendado'),
          // Confirmar duas vezes não é erro, mas também não sobrescreve o
          // carimbo de quem confirmou primeiro.
          isNull(agendamento.confirmadoEm),
        ),
      )
      .returning({ id: agendamento.id })

    if (feitas.length > 0) return 'Atendimento confirmado pelo paciente via WhatsApp.'
    // Dizer o estado real, não um genérico: "já estava confirmado" para um
    // atendimento cancelado mandaria a recepção para o lugar errado.
    return `Nada alterado — o atendimento está "${await statusAtual(p.agendamentoId)}".`
  }

  // Cancelamento. O motivo cita o texto do paciente — é o que a recepção lê para
  // entender se é cancelamento mesmo ou pedido de remarcação.
  const motivo = `Cancelado pelo paciente via WhatsApp: "${p.texto.slice(0, 200)}"`
  const feitas = await db
    .update(agendamento)
    .set({
      status: 'cancelado',
      motivoCancelamento: motivo,
      canceladoEm: p.agora,
    })
    .where(
      and(
        eq(agendamento.id, p.agendamentoId),
        inArray(agendamento.status, ['agendado', 'confirmado']),
      ),
    )
    .returning({ id: agendamento.id })

  if (feitas.length === 0) {
    return `Pedido de cancelamento não aplicado — o atendimento está "${await statusAtual(p.agendamentoId)}". A recepção precisa ver.`
  }

  // Lembrete que ainda não saiu para um atendimento cancelado não deve sair.
  const cancelados = await db
    .update(mensagemWhatsapp)
    .set({ situacao: 'cancelada' })
    .where(
      and(
        eq(mensagemWhatsapp.agendamentoId, p.agendamentoId),
        eq(mensagemWhatsapp.situacao, 'pendente'),
      ),
    )
    .returning({ id: mensagemWhatsapp.id })

  return cancelados.length > 0
    ? `Atendimento cancelado pelo paciente via WhatsApp; ${cancelados.length} lembrete(s) pendente(s) cancelado(s).`
    : 'Atendimento cancelado pelo paciente via WhatsApp.'
}

/**
 * Aplica um status vindo do webhook (entregue/lida/falhou).
 *
 * Silenciosa quando não encontra a mensagem: a Meta pode mandar status de coisa
 * enviada por outro ambiente que usa o mesmo número. Não é erro nosso.
 */
export async function aplicarStatus(s: AtualizacaoStatus): Promise<boolean> {
  const campo =
    s.situacao === 'entregue'
      ? { situacao: 'entregue' as const, entregueEm: s.em }
      : s.situacao === 'lida'
        ? { situacao: 'lida' as const, lidaEm: s.em }
        : {
            situacao: 'falhou' as const,
            falhouEm: s.em,
            erroCodigo: 'WEBHOOK',
            erroMensagem: s.erro ?? 'Falha relatada pela Meta.',
          }

  // A trigger de transição recusa retrocesso (lida -> entregue chega fora de
  // ordem com frequência). Então o UPDATE já filtra os estados de onde a
  // transição é válida, e fora de ordem simplesmente não altera nada.
  const origensValidas =
    s.situacao === 'entregue'
      ? (['enviada'] as const)
      : s.situacao === 'lida'
        ? (['enviada', 'entregue'] as const)
        : (['enviada', 'entregue'] as const)

  const feitas = await db
    .update(mensagemWhatsapp)
    .set(campo)
    .where(
      and(
        eq(mensagemWhatsapp.idExterno, s.idExterno),
        inArray(mensagemWhatsapp.situacao, [...origensValidas]),
      ),
    )
    .returning({ id: mensagemWhatsapp.id })

  return feitas.length > 0
}
