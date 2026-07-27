import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { agendamento, cadeira, clinica } from '@/lib/db/schema'
import { podeDesativarCadeira, type EstadoDaCadeira } from '@/lib/domain/administracao'
import { cnpjEhValido, normalizarCnpj } from '@/lib/domain/cnpj'
import { apenasDigitos } from '@/lib/domain/cpf'
import { type HorarioFuncionamento, exigirHorarioValido } from '@/lib/domain/horario'
import { clinicaAtual } from '@/lib/tenant/contexto'
import { and, eq, gte, notInArray, sql } from 'drizzle-orm'

/**
 * Configuração da clínica e cadeiras. **Núcleo, sem `'use server'`.**
 *
 * A clínica é uma linha singleton (`id = 1`) — decisão arquitetural 1 do
 * CLAUDE.md. Não existe criar nem apagar: existe editar.
 *
 * ── O que esta tela NÃO oferece ─────────────────────────────────────────────
 * **A base da comissão.** `clinica.base_comissao = 'valor_recebido'` é decisão
 * fechada da clínica: a comissão entra na base quando o pagamento é conciliado,
 * não quando o procedimento é executado — senão comissão paga vira adiantamento
 * quando o paciente atrasa. Um seletor na tela convidaria a reabrir isso por
 * engano, e mudaria a apuração de meses já fechados. Se a clínica quiser mudar,
 * é conversa e migration, não um clique.
 *
 * **O fuso horário** aparece, mas só para leitura: mudá-lo reinterpreta todo
 * histórico de agenda e de validade de lote.
 */

export type ResultadoConfig =
  | { readonly ok: true; readonly mensagem: string }
  | { readonly ok: false; readonly mensagem: string }

export interface DadosDaClinica {
  readonly razaoSocial: string
  readonly nomeFantasia?: string
  readonly cnpj?: string
  readonly croResponsavel?: string
  readonly ufCroResponsavel?: string
  readonly telefone?: string
  readonly email?: string
  readonly cep?: string
  readonly logradouro?: string
  readonly numero?: string
  readonly complemento?: string
  readonly bairro?: string
  readonly cidade?: string
  readonly uf?: string
  readonly passoAgendaMinutos?: number
  readonly horarioFuncionamento?: HorarioFuncionamento
}

const PASSOS_VALIDOS = [10, 15, 20, 30, 60] as const

export async function salvarClinicaComAtor(
  ator: Ator,
  dados: DadosDaClinica,
): Promise<ResultadoConfig> {
  const razaoSocial = dados.razaoSocial?.trim()
  if (!razaoSocial || razaoSocial.length < 3) {
    return { ok: false, mensagem: 'Informe a razão social.' }
  }

  const cnpj = dados.cnpj ? normalizarCnpj(dados.cnpj) : ''
  if (cnpj && !cnpjEhValido(cnpj)) {
    // O CNPJ vai no cabeçalho do orçamento, do atestado e do XML TISS. Errado,
    // volta como glosa de dado do prestador — semanas depois.
    return { ok: false, mensagem: 'CNPJ inválido (dígitos verificadores não conferem).' }
  }

  if (dados.ufCroResponsavel && !/^[A-Za-z]{2}$/.test(dados.ufCroResponsavel.trim())) {
    return { ok: false, mensagem: 'UF do CRO deve ter duas letras.' }
  }
  if (dados.uf && !/^[A-Za-z]{2}$/.test(dados.uf.trim())) {
    return { ok: false, mensagem: 'UF do endereço deve ter duas letras.' }
  }

  const passo = dados.passoAgendaMinutos
  if (passo !== undefined && !PASSOS_VALIDOS.includes(passo as (typeof PASSOS_VALIDOS)[number])) {
    return {
      ok: false,
      mensagem: `Passo da agenda deve ser um de: ${PASSOS_VALIDOS.join(', ')} minutos.`,
    }
  }

  if (dados.horarioFuncionamento) {
    try {
      // Faixa invertida ou sobreposta faria a grade oferecer horário que não
      // existe. A validação é a mesma que a agenda usa para montar a grade.
      exigirHorarioValido(dados.horarioFuncionamento)
    } catch (e) {
      return { ok: false, mensagem: e instanceof Error ? e.message : 'Horário inválido.' }
    }
  }

  const cep = dados.cep ? apenasDigitos(dados.cep) : ''
  if (cep && cep.length !== 8) return { ok: false, mensagem: 'CEP deve ter 8 dígitos.' }

  /**
   * Era um upsert de singleton (`id: 1`). Virou UPDATE da clínica corrente: criar
   * clínica agora é onboarding, operação própria, não efeito colateral de salvar
   * a configuração.
   */
  const id = await clinicaAtual()
  await db
    .update(clinica)
    .set({
      razaoSocial,
      nomeFantasia: dados.nomeFantasia?.trim() || null,
      cnpj: cnpj || null,
      croResponsavel: dados.croResponsavel?.trim() || null,
      ufCroResponsavel: dados.ufCroResponsavel?.trim().toUpperCase() || null,
      telefone: dados.telefone ? apenasDigitos(dados.telefone) : null,
      email: dados.email?.trim().toLowerCase() || null,
      cep: cep || null,
      logradouro: dados.logradouro?.trim() || null,
      numero: dados.numero?.trim() || null,
      complemento: dados.complemento?.trim() || null,
      bairro: dados.bairro?.trim() || null,
      cidade: dados.cidade?.trim() || null,
      uf: dados.uf?.trim().toUpperCase() || null,
      ...(passo !== undefined ? { passoAgendaMinutos: passo } : {}),
      ...(dados.horarioFuncionamento ? { horarioFuncionamento: dados.horarioFuncionamento } : {}),
      atualizadoEm: sql`now()`,
    })
    .where(eq(clinica.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'clinica',
    entidadeId: id,
    detalhes: { razaoSocial, temCnpj: cnpj !== '' },
  })

  return { ok: true, mensagem: 'Configuração salva.' }
}

/**
 * Salva SÓ o horário de funcionamento e o passo da agenda.
 *
 * Ação separada de propósito. A tela do horário não tem os campos de
 * identificação, e reusar `salvarClinicaComAtor` obrigaria a mandar uma razão
 * social qualquer — que o `onConflictDoUpdate` gravaria por cima. O nome da
 * clínica desapareceria dos impressos por causa de um formulário de horário.
 */
export async function salvarHorarioComAtor(
  ator: Ator,
  horario: HorarioFuncionamento,
  passoAgendaMinutos: number,
): Promise<ResultadoConfig> {
  if (!PASSOS_VALIDOS.includes(passoAgendaMinutos as (typeof PASSOS_VALIDOS)[number])) {
    return {
      ok: false,
      mensagem: `Passo da agenda deve ser um de: ${PASSOS_VALIDOS.join(', ')} minutos.`,
    }
  }
  try {
    exigirHorarioValido(horario)
  } catch (e) {
    return { ok: false, mensagem: e instanceof Error ? e.message : 'Horário inválido.' }
  }

  const id = await clinicaAtual()

  await db
    .update(clinica)
    .set({ horarioFuncionamento: horario, passoAgendaMinutos, atualizadoEm: new Date() })
    .where(eq(clinica.id, id))

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'clinica',
    entidadeId: id,
    detalhes: { horarioAlterado: true, passoAgendaMinutos },
  })

  return { ok: true, mensagem: 'Horário salvo.' }
}

// ── Cadeiras ──────────────────────────────────────────────────────────────────

async function estadoDasCadeiras(): Promise<readonly EstadoDaCadeira[]> {
  const linhas = await db
    .select({
      id: cadeira.id,
      nome: cadeira.nome,
      ativo: cadeira.ativo,
      agendamentosFuturos: sql<number>`(
        select count(*)::int from agendamento a
         where a.cadeira_id = ${cadeira.id}
           and a.inicio >= now()
           and a.status not in ('cancelado', 'faltou')
      )`,
    })
    .from(cadeira)
  return linhas
}

export async function salvarCadeiraComAtor(
  ator: Ator,
  dados: { readonly nome: string; readonly ordem?: number },
  id?: string,
): Promise<ResultadoConfig> {
  const nome = dados.nome?.trim()
  if (!nome || nome.length < 2) return { ok: false, mensagem: 'Informe o nome da cadeira.' }

  try {
    if (id) {
      await db
        .update(cadeira)
        .set({ nome, ...(dados.ordem !== undefined ? { ordem: dados.ordem } : {}) })
        .where(eq(cadeira.id, id))
      await registrar({ ator, acao: 'atualizacao', entidade: 'cadeira', entidadeId: id, detalhes: { nome } })
      return { ok: true, mensagem: `Cadeira "${nome}" atualizada.` }
    }

    const [nova] = await db
      .insert(cadeira)
      .values({ nome, ordem: dados.ordem ?? 0 })
      .returning({ id: cadeira.id })
    await registrar({ ator, acao: 'criacao', entidade: 'cadeira', entidadeId: nova?.id, detalhes: { nome } })
    return { ok: true, mensagem: `Cadeira "${nome}" criada.` }
  } catch (e) {
    const bruto = e instanceof Error ? `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ''}` : ''
    if (bruto.includes('cadeira_nome_unique')) {
      return { ok: false, mensagem: 'Já existe uma cadeira com esse nome.' }
    }
    return { ok: false, mensagem: 'Não foi possível salvar a cadeira.' }
  }
}

/**
 * Desativa a cadeira. Nunca apaga: `agendamento.cadeira_id` é histórico, e a
 * ocupação por cadeira do painel olha para trás.
 */
export async function desativarCadeiraComAtor(ator: Ator, id: string): Promise<ResultadoConfig> {
  const todas = await estadoDasCadeiras()
  const alvo = todas.find((c) => c.id === id)
  if (!alvo) return { ok: false, mensagem: 'Cadeira não encontrada.' }

  const r = podeDesativarCadeira(alvo, todas)
  if (!r.ok) return { ok: false, mensagem: r.motivo }

  try {
    await db.update(cadeira).set({ ativo: false }).where(eq(cadeira.id, id))
    await registrar({ ator, acao: 'atualizacao', entidade: 'cadeira', entidadeId: id, detalhes: { ativo: false } })
    return { ok: true, mensagem: `Cadeira "${alvo.nome}" desativada.` }
  } catch (e) {
    const bruto = e instanceof Error ? `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ''}` : ''
    if (bruto.includes('agendamento(s) futuro(s)')) {
      return { ok: false, mensagem: 'Há agendamento futuro nesta cadeira. Remarque antes de desativá-la.' }
    }
    return { ok: false, mensagem: 'Não foi possível desativar a cadeira.' }
  }
}

export async function reativarCadeiraComAtor(ator: Ator, id: string): Promise<ResultadoConfig> {
  await db.update(cadeira).set({ ativo: true }).where(eq(cadeira.id, id))
  await registrar({ ator, acao: 'atualizacao', entidade: 'cadeira', entidadeId: id, detalhes: { ativo: true } })
  return { ok: true, mensagem: 'Cadeira reativada.' }
}

/** Agendamentos futuros por cadeira — a tela mostra antes de oferecer o botão. */
export async function agendamentosFuturosPorCadeira(): Promise<readonly EstadoDaCadeira[]> {
  return estadoDasCadeiras()
}

/** Usado pela verificação por HTTP para montar cenário sem tocar no schema. */
export async function contarAgendamentosFuturos(cadeiraId: string): Promise<number> {
  const [linha] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agendamento)
    .where(
      and(
        eq(agendamento.cadeiraId, cadeiraId),
        gte(agendamento.inicio, new Date()),
        notInArray(agendamento.status, ['cancelado', 'faltou']),
      ),
    )
  return linha?.n ?? 0
}
