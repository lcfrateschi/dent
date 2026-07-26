'use server'

import { createHash } from 'node:crypto'
import { registrar } from '@/lib/auditoria/registrar'
import { exigirPermissao } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  agendamento,
  consentimento,
  mensagemWhatsapp,
  respostaWhatsapp,
} from '@/lib/db/schema'
import { ErroDominio } from '@/lib/domain/erros'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  FINALIDADE_WHATSAPP,
  TEXTO_TERMO_WHATSAPP,
  VERSAO_TERMO_WHATSAPP,
  temConsentimentoWhatsapp,
} from './consentimento'
import { despacharPendentes } from './despachar'
import { enfileirarLembrete } from './fila'

/**
 * Ações da tela de WhatsApp.
 *
 * O que a recepção pode fazer aqui é deliberadamente curto: enfileirar um
 * lembrete, resolver uma resposta que a máquina não entendeu, e disparar a fila
 * manualmente. **Não há "reenviar" para mensagem travada** — a decisão está em
 * drizzle/0009_mensageria_travas.sql: se ninguém sabe se a Meta entregou,
 * reenviar arrisca mandar duas vezes. Quem quer garantir liga para o paciente.
 */

export type ResultadoWhatsapp = { ok: true; mensagem: string } | { ok: false; mensagem: string }

/** Erro do Postgres, sem o embrulho "Failed query: insert into…" do Drizzle. */
function mensagemDeErro(e: unknown): string {
  if (e instanceof ErroDominio) return e.message
  let atual: unknown = e
  while (atual instanceof Error) {
    const m = atual.message
    // O texto do RAISE EXCEPTION é o único que serve para a recepção ler.
    if (!m.startsWith('Failed query') && !m.includes('insert into')) return m
    atual = (atual as { cause?: unknown }).cause
  }
  return 'Não foi possível concluir a operação.'
}

/**
 * Registra o consentimento LGPD para contato por WhatsApp.
 *
 * Grava o hash do texto aceito e a versão do termo: em uma reclamação, a clínica
 * precisa provar *qual redação* o paciente leu, não apenas que clicou.
 */
export async function registrarConsentimentoWhatsapp(
  pacienteId: string,
): Promise<ResultadoWhatsapp> {
  const ator = await exigirPermissao('paciente', 'editar')

  try {
    if (await temConsentimentoWhatsapp(pacienteId)) {
      return { ok: true, mensagem: 'Paciente já havia autorizado o contato por WhatsApp.' }
    }

    const [criado] = await db
      .insert(consentimento)
      .values({
        pacienteId,
        baseLegal: 'consentimento',
        finalidade: FINALIDADE_WHATSAPP,
        versaoTermo: VERSAO_TERMO_WHATSAPP,
        textoHash: createHash('sha256').update(TEXTO_TERMO_WHATSAPP, 'utf8').digest('hex'),
      })
      .returning({ id: consentimento.id })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'consentimento',
      entidadeId: criado?.id ?? null,
      pacienteId,
      detalhes: { finalidade: FINALIDADE_WHATSAPP, versao: VERSAO_TERMO_WHATSAPP },
    })

    revalidatePath(`/pacientes/${pacienteId}`)
    revalidatePath('/whatsapp')
    return { ok: true, mensagem: 'Autorização registrada.' }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Revoga a autorização.
 *
 * Não apaga a linha: preenche `revogado_em`. O consentimento anterior existiu e
 * as mensagens enviadas na vigência dele estavam amparadas — apagar reescreveria
 * a história e tiraria a base legal do que já foi feito.
 */
export async function revogarConsentimentoWhatsapp(
  pacienteId: string,
): Promise<ResultadoWhatsapp> {
  const ator = await exigirPermissao('paciente', 'editar')

  try {
    const revogados = await db
      .update(consentimento)
      .set({ revogadoEm: new Date() })
      .where(
        and(
          eq(consentimento.pacienteId, pacienteId),
          eq(consentimento.finalidade, FINALIDADE_WHATSAPP),
          isNull(consentimento.revogadoEm),
        ),
      )
      .returning({ id: consentimento.id })

    // Sem autorização, o que ainda não saiu não sai.
    const cancelados = await db
      .update(mensagemWhatsapp)
      .set({ situacao: 'cancelada' })
      .where(
        and(
          eq(mensagemWhatsapp.pacienteId, pacienteId),
          eq(mensagemWhatsapp.situacao, 'pendente'),
        ),
      )
      .returning({ id: mensagemWhatsapp.id })

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'consentimento',
      pacienteId,
      detalhes: {
        finalidade: FINALIDADE_WHATSAPP,
        revogados: revogados.length,
        mensagensCanceladas: cancelados.length,
      },
    })

    revalidatePath(`/pacientes/${pacienteId}`)
    revalidatePath('/whatsapp')
    return {
      ok: true,
      mensagem:
        cancelados.length > 0
          ? `Autorização revogada; ${cancelados.length} mensagem(ns) pendente(s) cancelada(s).`
          : 'Autorização revogada.',
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Enfileira (ou reenfileira) o lembrete de um agendamento. */
export async function enviarLembrete(agendamentoId: string): Promise<ResultadoWhatsapp> {
  const ator = await exigirPermissao('mensageria', 'criar')

  try {
    const r = await enfileirarLembrete(agendamentoId, new Date())
    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'mensagem_whatsapp',
      entidadeId: r.id ?? null,
      detalhes: { agendamentoId, enfileirada: r.enfileirada, motivo: r.motivo },
    })

    revalidatePath('/whatsapp')
    revalidatePath('/agenda')
    return r.enfileirada
      ? { ok: true, mensagem: 'Lembrete enfileirado.' }
      : { ok: false, mensagem: r.motivo ?? 'Não foi possível enfileirar.' }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Marca uma resposta não entendida como tratada.
 *
 * Exige dizer o que foi feito. Um botão "OK" que só some com o item deixaria a
 * próxima pessoa sem saber se alguém ligou para o paciente.
 */
export async function tratarResposta(respostaId: string, acao: string): Promise<ResultadoWhatsapp> {
  const ator = await exigirPermissao('mensageria', 'editar')

  const texto = acao.trim()
  if (texto.length < 3) {
    return { ok: false, mensagem: 'Escreva o que foi feito — a próxima pessoa precisa saber.' }
  }

  try {
    const feitas = await db
      .update(respostaWhatsapp)
      .set({ tratadoEm: new Date(), acaoTomada: texto.slice(0, 500) })
      .where(eq(respostaWhatsapp.id, respostaId))
      .returning({ id: respostaWhatsapp.id, pacienteId: respostaWhatsapp.pacienteId })

    const alvo = feitas[0]
    if (!alvo) return { ok: false, mensagem: 'Resposta não encontrada.' }

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'resposta_whatsapp',
      entidadeId: alvo.id,
      pacienteId: alvo.pacienteId,
      detalhes: { tratada: true },
    })

    revalidatePath('/whatsapp')
    return { ok: true, mensagem: 'Resposta marcada como tratada.' }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Confirma ou cancela na mão, a partir de uma resposta que a máquina não
 * entendeu. É o desfecho normal de "liguei para o paciente".
 */
export async function resolverManualmente(
  respostaId: string,
  decisao: 'confirmar' | 'cancelar',
  observacao: string,
): Promise<ResultadoWhatsapp> {
  const ator = await exigirPermissao('agenda', 'editar')
  await exigirPermissao('mensageria', 'editar')

  const [resposta] = await db
    .select({
      id: respostaWhatsapp.id,
      agendamentoId: respostaWhatsapp.agendamentoId,
      pacienteId: respostaWhatsapp.pacienteId,
      texto: respostaWhatsapp.texto,
    })
    .from(respostaWhatsapp)
    .where(eq(respostaWhatsapp.id, respostaId))

  if (!resposta) return { ok: false, mensagem: 'Resposta não encontrada.' }
  if (!resposta.agendamentoId) {
    return {
      ok: false,
      mensagem: 'Esta resposta não está ligada a um atendimento — resolva pela agenda.',
    }
  }

  try {
    const agora = new Date()

    if (decisao === 'confirmar') {
      // `confirmadoVia = 'telefone'`: quem confirmou foi a recepção falando com o
      // paciente, não o WhatsApp. Registrar 'whatsapp' faria o relatório de
      // eficácia do canal mentir.
      await db
        .update(agendamento)
        .set({ status: 'confirmado', confirmadoEm: agora, confirmadoVia: 'telefone' })
        .where(and(eq(agendamento.id, resposta.agendamentoId), eq(agendamento.status, 'agendado')))
    } else {
      const motivo = `Cancelado pela recepção após contato: ${observacao.trim() || 'sem observação'} (resposta do paciente: "${resposta.texto.slice(0, 120)}")`
      await db
        .update(agendamento)
        .set({ status: 'cancelado', canceladoEm: agora, motivoCancelamento: motivo })
        .where(
          and(
            eq(agendamento.id, resposta.agendamentoId),
            inArray(agendamento.status, ['agendado', 'confirmado']),
          ),
        )

      await db
        .update(mensagemWhatsapp)
        .set({ situacao: 'cancelada' })
        .where(
          and(
            eq(mensagemWhatsapp.agendamentoId, resposta.agendamentoId),
            eq(mensagemWhatsapp.situacao, 'pendente'),
          ),
        )
    }

    await db
      .update(respostaWhatsapp)
      .set({
        tratadoEm: agora,
        acaoTomada: `${decisao === 'confirmar' ? 'Confirmado' : 'Cancelado'} pela recepção. ${observacao.trim()}`.slice(
          0,
          500,
        ),
      })
      .where(eq(respostaWhatsapp.id, respostaId))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'agendamento',
      entidadeId: resposta.agendamentoId,
      pacienteId: resposta.pacienteId,
      detalhes: { origem: 'resposta_whatsapp', respostaId, decisao },
    })

    revalidatePath('/whatsapp')
    revalidatePath('/agenda')
    return {
      ok: true,
      mensagem: decisao === 'confirmar' ? 'Atendimento confirmado.' : 'Atendimento cancelado.',
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Dispara a fila agora, sem esperar o cron.
 *
 * Seguro de apertar duas vezes: `reivindicarMensagens` usa `FOR UPDATE SKIP
 * LOCKED`, então a segunda chamada não pega nada da primeira.
 */
export async function despacharAgora(): Promise<ResultadoWhatsapp> {
  const ator = await exigirPermissao('mensageria', 'criar')

  try {
    const r = await despacharPendentes(new Date())
    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'mensagem_whatsapp',
      detalhes: { manual: true, ...r },
    })
    revalidatePath('/whatsapp')

    if (r.reivindicadas === 0) return { ok: true, mensagem: 'Nada vencido para enviar agora.' }
    return {
      ok: true,
      mensagem: `${r.enviadas} enviada(s), ${r.falhadas} falha(s) — provedor: ${r.provedor}.`,
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}
