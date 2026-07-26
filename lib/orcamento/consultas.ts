import { registrar, registrarLeitura } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  clinica,
  convenio,
  execucao,
  itemPlano,
  orcamento,
  orcamentoItem,
  pacienteConvenio,
  paciente,
  planoTratamento,
  precoConvenio,
  profissional,
  procedimento,
  usuario,
} from '@/lib/db/schema'
import type { Face } from '@/lib/domain/dentes'
import { descreverFaces } from '@/lib/domain/faces'
import { FUSO_PADRAO, diaLocalIso } from '@/lib/domain/fuso'
import {
  type StatusOrcamento,
  statusApresentado,
  valorParaOPaciente,
} from '@/lib/domain/orcamento'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

/**
 * Consultas de plano de tratamento e orçamento.
 *
 * O ponto delicado: `item_plano.valor` é o valor CHEIO do procedimento; o que o
 * orçamento mostra é o que **o paciente desembolsa**. No particular são iguais;
 * no convênio, o paciente paga só a coparticipação. Um orçamento que mostrasse
 * o valor cheio de um item de convênio assustaria o paciente sem motivo.
 */

export interface ItemDoPlano {
  readonly id: string
  readonly procedimentoId: string
  readonly procedimentoNome: string
  readonly denteFdi: number | null
  readonly faces: readonly Face[]
  readonly status: string
  readonly cobertura: 'particular' | 'convenio'
  readonly convenioId: string | null
  readonly convenioNome: string | null
  /** Valor cheio do procedimento. */
  readonly valor: string
  /** O que o paciente paga: igual ao valor no particular, coparticipação no convênio. */
  readonly valorPaciente: string
  readonly ordem: number
  readonly observacao: string | null
  readonly executado: boolean
  /** Descrição congelável, a mesma que vai para a linha do orçamento. */
  readonly descricao: string
  readonly detalhe: string | null
}

export interface PlanoCompleto {
  readonly id: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly profissionalNome: string
  readonly titulo: string
  readonly diagnostico: string | null
  readonly observacao: string | null
  readonly status: 'rascunho' | 'ativo' | 'concluido' | 'cancelado'
  readonly criadoEm: Date
  readonly itens: readonly ItemDoPlano[]
}

/** Status de item que ainda podem entrar num orçamento. */
const ORCAMENTAVEIS = ['proposto', 'aprovado', 'executado'] as const

export async function planoDoPaciente(
  ator: Ator,
  pacienteId: string,
): Promise<PlanoCompleto | null> {
  const [plano] = await db
    .select({
      id: planoTratamento.id,
      pacienteId: planoTratamento.pacienteId,
      pacienteNome: paciente.nome,
      profissionalNome: usuario.nome,
      titulo: planoTratamento.titulo,
      diagnostico: planoTratamento.diagnostico,
      observacao: planoTratamento.observacao,
      status: planoTratamento.status,
      criadoEm: planoTratamento.criadoEm,
    })
    .from(planoTratamento)
    .innerJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .innerJoin(profissional, eq(profissional.id, planoTratamento.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(and(eq(planoTratamento.pacienteId, pacienteId), eq(planoTratamento.status, 'ativo')))
    .limit(1)

  if (!plano) return null

  const itens = await itensDoPlano(plano.id)

  await registrarLeitura(ator, 'plano_tratamento', pacienteId, {
    planoId: plano.id,
    itens: itens.length,
  })

  return { ...plano, itens }
}

export async function itensDoPlano(planoId: string): Promise<readonly ItemDoPlano[]> {
  const linhas = await db
    .select({
      id: itemPlano.id,
      procedimentoId: itemPlano.procedimentoId,
      procedimentoNome: procedimento.nome,
      denteFdi: itemPlano.denteFdi,
      faces: itemPlano.faces,
      status: itemPlano.status,
      cobertura: itemPlano.cobertura,
      convenioId: itemPlano.convenioId,
      convenioNome: convenio.nome,
      valor: itemPlano.valor,
      valorCoparticipacao: itemPlano.valorCoparticipacao,
      ordem: itemPlano.ordem,
      observacao: itemPlano.observacao,
      execucaoId: execucao.id,
    })
    .from(itemPlano)
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .leftJoin(convenio, eq(convenio.id, itemPlano.convenioId))
    .leftJoin(execucao, eq(execucao.itemPlanoId, itemPlano.id))
    .where(and(eq(itemPlano.planoId, planoId), inArray(itemPlano.status, [...ORCAMENTAVEIS])))
    .orderBy(asc(itemPlano.ordem), asc(itemPlano.criadoEm))

  const vistos = new Set<string>()
  const itens: ItemDoPlano[] = []

  for (const l of linhas) {
    if (vistos.has(l.id)) continue
    vistos.add(l.id)

    const faces = (l.faces ?? []) as readonly Face[]
    const detalhe = l.denteFdi !== null ? descreverFaces(l.denteFdi, faces) : null

    itens.push({
      id: l.id,
      procedimentoId: l.procedimentoId,
      procedimentoNome: l.procedimentoNome,
      denteFdi: l.denteFdi,
      faces,
      status: l.status,
      cobertura: l.cobertura,
      convenioId: l.convenioId,
      convenioNome: l.convenioNome,
      valor: l.valor,
      // No convênio, o valor de coparticipação já foi calculado e congelado no
      // item — não recalcular aqui, senão uma mudança na tabela de preço
      // alteraria retroativamente o que o paciente ia pagar.
      valorPaciente: l.cobertura === 'convenio' ? l.valorCoparticipacao : l.valor,
      ordem: l.ordem,
      observacao: l.observacao,
      executado: l.execucaoId !== null,
      descricao: l.procedimentoNome,
      detalhe,
    })
  }

  return itens
}

// ── Orçamento ────────────────────────────────────────────────────────────────

export interface LinhaDoOrcamento {
  readonly id: string
  readonly descricao: string
  readonly detalhe: string | null
  readonly quantidade: number
  readonly valorUnitario: string
  readonly ordem: number
}

export interface OrcamentoCompleto {
  readonly id: string
  readonly numero: number
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly pacienteCpf: string | null
  readonly planoId: string | null
  readonly status: StatusOrcamento
  /** Status considerando o vencimento — pode ser `expirado` sem estar gravado. */
  readonly statusVisivel: StatusOrcamento
  readonly validadeAte: string
  readonly valorBruto: string
  readonly desconto: string
  readonly valorTotal: string
  readonly observacao: string | null
  readonly criadoEm: Date
  readonly enviadoEm: Date | null
  readonly decididoEm: Date | null
  readonly criadoPorNome: string | null
  readonly linhas: readonly LinhaDoOrcamento[]
}

export async function acharOrcamento(
  ator: Ator,
  id: string,
): Promise<OrcamentoCompleto | null> {
  const [linha] = await db
    .select({
      id: orcamento.id,
      numero: orcamento.numero,
      pacienteId: orcamento.pacienteId,
      pacienteNome: paciente.nome,
      pacienteCpf: paciente.cpf,
      planoId: orcamento.planoId,
      status: orcamento.status,
      validadeAte: orcamento.validadeAte,
      valorBruto: orcamento.valorBruto,
      desconto: orcamento.desconto,
      valorTotal: orcamento.valorTotal,
      observacao: orcamento.observacao,
      criadoEm: orcamento.criadoEm,
      enviadoEm: orcamento.enviadoEm,
      decididoEm: orcamento.decididoEm,
      criadoPorNome: usuario.nome,
    })
    .from(orcamento)
    .innerJoin(paciente, eq(paciente.id, orcamento.pacienteId))
    .leftJoin(usuario, eq(usuario.id, orcamento.criadoPorId))
    .where(eq(orcamento.id, id))
    .limit(1)

  if (!linha) return null

  const [linhas, hojeIso] = await Promise.all([linhasDoOrcamento(id), hojeDaClinica()])

  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'orcamento',
    entidadeId: id,
    pacienteId: linha.pacienteId,
    detalhes: { numero: linha.numero },
  })

  return {
    ...linha,
    statusVisivel: statusApresentado(linha.status, linha.validadeAte, hojeIso),
    linhas,
  }
}

export async function linhasDoOrcamento(orcamentoId: string): Promise<readonly LinhaDoOrcamento[]> {
  return db
    .select({
      id: orcamentoItem.id,
      descricao: orcamentoItem.descricao,
      detalhe: orcamentoItem.detalhe,
      quantidade: orcamentoItem.quantidade,
      valorUnitario: orcamentoItem.valorUnitario,
      ordem: orcamentoItem.ordem,
    })
    .from(orcamentoItem)
    .where(eq(orcamentoItem.orcamentoId, orcamentoId))
    .orderBy(asc(orcamentoItem.ordem))
}

export interface ResumoOrcamento {
  readonly id: string
  readonly numero: number
  readonly status: StatusOrcamento
  readonly statusVisivel: StatusOrcamento
  readonly validadeAte: string
  readonly valorTotal: string
  readonly criadoEm: Date
  readonly linhas: number
}

export async function orcamentosDoPaciente(
  pacienteId: string,
): Promise<readonly ResumoOrcamento[]> {
  const [linhas, hojeIso] = await Promise.all([
    db
      .select({
        id: orcamento.id,
        numero: orcamento.numero,
        status: orcamento.status,
        validadeAte: orcamento.validadeAte,
        valorTotal: orcamento.valorTotal,
        criadoEm: orcamento.criadoEm,
        linhas: sql<number>`(select count(*)::int from orcamento_item oi where oi.orcamento_id = ${orcamento.id})`,
      })
      .from(orcamento)
      .where(eq(orcamento.pacienteId, pacienteId))
      .orderBy(desc(orcamento.numero)),
    hojeDaClinica(),
  ])

  return linhas.map((l) => ({
    ...l,
    statusVisivel: statusApresentado(l.status, l.validadeAte, hojeIso),
  }))
}

/** Dados da clínica para o cabeçalho do documento impresso. */
export interface CabecalhoClinica {
  readonly razaoSocial: string
  readonly nomeFantasia: string | null
  readonly cnpj: string | null
  readonly croResponsavel: string | null
  readonly ufCroResponsavel: string | null
  readonly telefone: string | null
  readonly email: string | null
  readonly logradouro: string | null
  readonly numero: string | null
  readonly bairro: string | null
  readonly cidade: string | null
  readonly uf: string | null
  readonly cep: string | null
}

export async function cabecalhoDaClinica(): Promise<CabecalhoClinica | null> {
  const [linha] = await db
    .select({
      razaoSocial: clinica.razaoSocial,
      nomeFantasia: clinica.nomeFantasia,
      cnpj: clinica.cnpj,
      croResponsavel: clinica.croResponsavel,
      ufCroResponsavel: clinica.ufCroResponsavel,
      telefone: clinica.telefone,
      email: clinica.email,
      logradouro: clinica.logradouro,
      numero: clinica.numero,
      bairro: clinica.bairro,
      cidade: clinica.cidade,
      uf: clinica.uf,
      cep: clinica.cep,
    })
    .from(clinica)
    .limit(1)
  return linha ?? null
}

/** "Hoje" no fuso da clínica — o vencimento é um dia civil, não um instante. */
export async function hojeDaClinica(): Promise<string> {
  const [linha] = await db.select({ fuso: clinica.fusoHorario }).from(clinica).limit(1)
  return diaLocalIso(new Date(), linha?.fuso ?? FUSO_PADRAO)
}

/**
 * Preço de convênio vigente para um procedimento, e a coparticipação resultante.
 * Usado ao trocar a cobertura de um item do plano.
 */
export async function precoDeConvenio(
  convenioId: string,
  procedimentoId: string,
): Promise<{ valor: string; coberturaPct: string; valorPaciente: string } | null> {
  const [linha] = await db
    .select({ valor: precoConvenio.valor, coberturaPct: precoConvenio.coberturaPct })
    .from(precoConvenio)
    .where(
      and(
        eq(precoConvenio.convenioId, convenioId),
        eq(precoConvenio.procedimentoId, procedimentoId),
        sql`${precoConvenio.vigenciaInicio} <= current_date`,
        sql`(${precoConvenio.vigenciaFim} is null or ${precoConvenio.vigenciaFim} >= current_date)`,
      ),
    )
    .orderBy(desc(precoConvenio.vigenciaInicio))
    .limit(1)

  if (!linha) return null

  return {
    ...linha,
    valorPaciente: valorParaOPaciente({
      cobertura: 'convenio',
      valorConvenio: linha.valor,
      coberturaPct: linha.coberturaPct,
    }),
  }
}

/** Convênios ativos do paciente, para o seletor de cobertura. */
export async function conveniosDoPaciente(
  pacienteId: string,
): Promise<readonly { convenioId: string; nome: string; carteirinha: string }[]> {
  return db
    .select({
      convenioId: pacienteConvenio.convenioId,
      nome: convenio.nome,
      carteirinha: pacienteConvenio.numeroCarteirinha,
    })
    .from(pacienteConvenio)
    .innerJoin(convenio, eq(convenio.id, pacienteConvenio.convenioId))
    .where(and(eq(pacienteConvenio.pacienteId, pacienteId), eq(pacienteConvenio.ativo, true)))
    .orderBy(asc(convenio.nome))
}
