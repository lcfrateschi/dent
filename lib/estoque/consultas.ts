import { db } from '@/lib/db'
import {
  execucao,
  insumoProcedimento,
  itemPlano,
  loteMaterial,
  material,
  movimentoEstoque,
  paciente,
  planoTratamento,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import {
  type AvaliacaoReposicao,
  type AvaliacaoValidade,
  type LoteDisponivel,
  type SituacaoValidade,
  type TipoMovimento,
  avaliarReposicao,
  classificarValidade,
  consumoMedioDiario,
  diasDeCobertura,
  ordenarFefo,
  urgenciaDeReposicao,
} from '@/lib/domain/estoque'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { and, asc, desc, eq, gt, isNotNull, sql } from 'drizzle-orm'

/**
 * Leituras do estoque.
 *
 * A tela que importa é a de **reposição**: "o que está acabando e o que está
 * vencendo?". Um sistema de estoque que só responde "quanto tem de X" não muda
 * nada na clínica — a pergunta que a recepção faz de manhã é a outra.
 *
 * Nenhuma consulta aqui usa `new Date()` para decidir vencimento: o dia civil
 * vem de `hojeDaClinica()`, no fuso configurado. Ver o comentário em
 * `lib/domain/estoque.ts`.
 */

export interface LinhaDeEstoque {
  readonly materialId: string
  readonly codigo: string
  readonly nome: string
  readonly categoria: string
  readonly unidade: string
  readonly embalagem: string | null
  readonly unidadesPorEmbalagem: number
  readonly controlado: boolean
  readonly exigeLoteDoFabricante: boolean
  readonly saldo: string
  readonly quantidadeMinima: string
  readonly reposicao: AvaliacaoReposicao
  readonly lotes: number
  /** Pior situação de validade entre os lotes com saldo. */
  readonly validade: SituacaoValidade
  /** Data do lote que vence primeiro, entre os que têm saldo. */
  readonly proximaValidade: string | null
  readonly valorEmEstoque: string
}

/**
 * Posição do estoque, material por material.
 *
 * `apenasAtencao` filtra para o que precisa de ação — é o padrão da tela, porque
 * lista de 40 materiais em que 3 importam é lista que ninguém lê.
 */
export async function posicaoDeEstoque(opcoes?: {
  readonly apenasAtencao?: boolean
  readonly categoria?: string
}): Promise<readonly LinhaDeEstoque[]> {
  const hoje = await hojeDaClinica()

  const linhas = await db
    .select({
      materialId: material.id,
      codigo: material.codigo,
      nome: material.nome,
      categoria: material.categoria,
      unidade: material.unidade,
      embalagem: material.embalagem,
      unidadesPorEmbalagem: material.unidadesPorEmbalagem,
      controlado: material.controlado,
      exigeLoteDoFabricante: material.exigeLoteDoFabricante,
      quantidadeMinima: material.quantidadeMinima,
      saldo: sql<string>`coalesce(sum(${loteMaterial.saldo}), 0)::text`,
      lotes: sql<number>`count(${loteMaterial.id}) filter (where ${loteMaterial.saldo} > 0)::int`,
      // Valor imobilizado: saldo × custo de cada lote, somado em centavos.
      valorEmEstoque: sql<string>`coalesce(round(sum(${loteMaterial.saldo} * ${loteMaterial.custoUnitario}), 2), 0)::text`,
      proximaValidade: sql<
        string | null
      >`min(${loteMaterial.validade}) filter (where ${loteMaterial.saldo} > 0)`,
      temVencido: sql<boolean>`bool_or(${loteMaterial.validade} < ${hoje}::date and ${loteMaterial.saldo} > 0)`,
    })
    .from(material)
    .leftJoin(loteMaterial, eq(loteMaterial.materialId, material.id))
    .where(
      opcoes?.categoria
        ? and(eq(material.ativo, true), eq(material.categoria, opcoes.categoria as never))
        : eq(material.ativo, true),
    )
    .groupBy(material.id)
    .orderBy(asc(material.nome))

  const resultado = linhas.map((l) => {
    const reposicao = avaliarReposicao(l.saldo, l.quantidadeMinima)
    const validade: SituacaoValidade = l.temVencido
      ? 'vencido'
      : l.proximaValidade === null
        ? 'sem_validade'
        : classificarValidade(l.proximaValidade, hoje).situacao
    return {
      ...l,
      reposicao,
      validade,
      lotes: l.lotes ?? 0,
    }
  })

  const ordenado = [...resultado].sort((a, b) => {
    const porUrgencia = urgenciaDeReposicao(a.reposicao.situacao) - urgenciaDeReposicao(b.reposicao.situacao)
    if (porUrgencia !== 0) return porUrgencia
    return a.nome.localeCompare(b.nome, 'pt-BR')
  })

  if (!opcoes?.apenasAtencao) return ordenado
  return ordenado.filter(
    (l) => l.reposicao.situacao !== 'ok' || l.validade === 'vencido' || l.validade === 'vence_em_breve',
  )
}

export interface LoteNaTela extends LoteDisponivel {
  readonly codigoFabricante: string | null
  readonly fornecedor: string | null
  readonly notaFiscal: string | null
  readonly avaliacao: AvaliacaoValidade
}

/** Lotes de um material, em ordem FEFO — a mesma ordem em que vão sair. */
export async function lotesDoMaterial(
  materialId: string,
  opcoes?: { readonly apenasComSaldo?: boolean },
): Promise<readonly LoteNaTela[]> {
  const hoje = await hojeDaClinica()

  const linhas = await db
    .select({
      id: loteMaterial.id,
      codigoFabricante: loteMaterial.codigoFabricante,
      validade: loteMaterial.validade,
      saldo: loteMaterial.saldo,
      custoUnitario: loteMaterial.custoUnitario,
      fornecedor: loteMaterial.fornecedor,
      notaFiscal: loteMaterial.notaFiscal,
      recebidoEm: loteMaterial.recebidoEm,
    })
    .from(loteMaterial)
    .where(
      opcoes?.apenasComSaldo
        ? and(eq(loteMaterial.materialId, materialId), gt(loteMaterial.saldo, '0'))
        : eq(loteMaterial.materialId, materialId),
    )

  return ordenarFefo(linhas).map((l) => ({
    ...(l as (typeof linhas)[number]),
    avaliacao: classificarValidade(l.validade, hoje),
  }))
}

export interface LoteVencendo {
  readonly loteId: string
  readonly materialId: string
  readonly codigo: string
  readonly nome: string
  readonly unidade: string
  readonly codigoFabricante: string | null
  readonly validade: string
  readonly saldo: string
  readonly custoUnitario: string
  readonly avaliacao: AvaliacaoValidade
  /** Quanto se perde se este lote vencer com esse saldo. */
  readonly valorEmRisco: string
}

/**
 * Lotes vencidos ou vencendo, com o valor em risco.
 *
 * O valor é o que faz a tela ter efeito: "3 lotes vencendo" não move ninguém,
 * "R$ 340 vencendo em 20 dias" move.
 */
export async function lotesVencendo(diasAlerta = 60): Promise<readonly LoteVencendo[]> {
  const hoje = await hojeDaClinica()

  const linhas = await db
    .select({
      loteId: loteMaterial.id,
      materialId: material.id,
      codigo: material.codigo,
      nome: material.nome,
      unidade: material.unidade,
      codigoFabricante: loteMaterial.codigoFabricante,
      validade: loteMaterial.validade,
      saldo: loteMaterial.saldo,
      custoUnitario: loteMaterial.custoUnitario,
      valorEmRisco: sql<string>`round(${loteMaterial.saldo} * ${loteMaterial.custoUnitario}, 2)::text`,
    })
    .from(loteMaterial)
    .innerJoin(material, eq(material.id, loteMaterial.materialId))
    .where(
      and(
        gt(loteMaterial.saldo, '0'),
        isNotNull(loteMaterial.validade),
        sql`${loteMaterial.validade} <= (${hoje}::date + ${diasAlerta} * interval '1 day')`,
      ),
    )
    .orderBy(asc(loteMaterial.validade))

  return linhas.map((l) => ({
    ...l,
    validade: l.validade as string,
    avaliacao: classificarValidade(l.validade, hoje, diasAlerta),
  }))
}

export interface MovimentoNaTela {
  readonly id: string
  readonly tipo: TipoMovimento
  readonly quantidade: string
  readonly motivo: string | null
  readonly ocorridoEm: Date
  readonly materialCodigo: string
  readonly materialNome: string
  readonly unidade: string
  readonly codigoFabricante: string | null
  readonly validade: string | null
  readonly profissionalNome: string | null
  readonly registradoPor: string | null
  readonly pacienteNome: string | null
  readonly pacienteId: string | null
}

/**
 * Extrato de movimentos.
 *
 * Traz o paciente quando o movimento é consumo ligado a execução — é o que
 * responde à pergunta do recolhimento de lote. Note que isso torna a consulta
 * **um acesso a dado de paciente**: quem chama registra leitura na auditoria.
 */
export async function extratoDeMovimentos(filtro?: {
  readonly materialId?: string
  readonly loteId?: string
  readonly limite?: number
}): Promise<readonly MovimentoNaTela[]> {
  const condicoes = [
    filtro?.materialId ? eq(movimentoEstoque.materialId, filtro.materialId) : undefined,
    filtro?.loteId ? eq(movimentoEstoque.loteId, filtro.loteId) : undefined,
  ].filter((c) => c !== undefined)

  return db
    .select({
      id: movimentoEstoque.id,
      tipo: movimentoEstoque.tipo,
      quantidade: movimentoEstoque.quantidade,
      motivo: movimentoEstoque.motivo,
      ocorridoEm: movimentoEstoque.ocorridoEm,
      materialCodigo: material.codigo,
      materialNome: material.nome,
      unidade: material.unidade,
      codigoFabricante: loteMaterial.codigoFabricante,
      validade: loteMaterial.validade,
      profissionalNome: usuario.nome,
      registradoPor: sql<string | null>`(select nome from usuario u where u.id = ${movimentoEstoque.registradoPorId})`,
      pacienteNome: paciente.nome,
      pacienteId: paciente.id,
    })
    .from(movimentoEstoque)
    .innerJoin(material, eq(material.id, movimentoEstoque.materialId))
    .innerJoin(loteMaterial, eq(loteMaterial.id, movimentoEstoque.loteId))
    .leftJoin(profissional, eq(profissional.id, movimentoEstoque.profissionalId))
    .leftJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .leftJoin(execucao, eq(execucao.id, movimentoEstoque.execucaoId))
    .leftJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .leftJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .leftJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(desc(movimentoEstoque.ocorridoEm))
    .limit(filtro?.limite ?? 100)
}

export interface ConsumoDoMaterial {
  readonly materialId: string
  readonly consumoMedioDiario: string
  readonly diasDeCobertura: number | null
}

/**
 * Consumo médio e cobertura, para o material escolhido.
 *
 * O período é em dias corridos, não em dias úteis: a clínica fecha no fim de
 * semana e o cálculo por dia corrido já embute isso na média. Dias úteis
 * pareceriam mais precisos e dariam um número maior que a realidade da compra.
 */
export async function consumoDoMaterial(
  materialId: string,
  dias = 90,
): Promise<ConsumoDoMaterial> {
  const [{ saldo = '0' } = { saldo: '0' }] = await db
    .select({ saldo: sql<string>`coalesce(sum(${loteMaterial.saldo}), 0)::text` })
    .from(loteMaterial)
    .where(eq(loteMaterial.materialId, materialId))

  const movimentos = await db
    .select({ tipo: movimentoEstoque.tipo, quantidade: movimentoEstoque.quantidade })
    .from(movimentoEstoque)
    .where(
      and(
        eq(movimentoEstoque.materialId, materialId),
        sql`${movimentoEstoque.ocorridoEm} >= now() - ${dias} * interval '1 day'`,
      ),
    )

  const medio = consumoMedioDiario(movimentos, dias)
  return { materialId, consumoMedioDiario: medio, diasDeCobertura: diasDeCobertura(saldo, medio) }
}

export interface InsumoDaFicha {
  readonly materialId: string
  readonly codigo: string
  readonly nome: string
  readonly unidade: string
  readonly quantidade: string
  readonly saldo: string
  readonly controlado: boolean
}

/** Ficha técnica de um procedimento, com o saldo atual de cada insumo. */
export async function fichaDoProcedimento(
  procedimentoId: string,
): Promise<readonly InsumoDaFicha[]> {
  return db
    .select({
      materialId: material.id,
      codigo: material.codigo,
      nome: material.nome,
      unidade: material.unidade,
      quantidade: insumoProcedimento.quantidade,
      controlado: material.controlado,
      saldo: sql<string>`coalesce((select sum(saldo) from lote_material l where l.material_id = ${material.id}), 0)::text`,
    })
    .from(insumoProcedimento)
    .innerJoin(material, eq(material.id, insumoProcedimento.materialId))
    .where(eq(insumoProcedimento.procedimentoId, procedimentoId))
    .orderBy(asc(material.nome))
}

export interface MaterialNaTela {
  readonly id: string
  readonly codigo: string
  readonly nome: string
  readonly categoria: string
  readonly unidade: string
  readonly unidadesPorEmbalagem: number
  readonly embalagem: string | null
  readonly quantidadeMinima: string
  readonly controlado: boolean
  readonly exigeLoteDoFabricante: boolean
}

export async function acharMaterial(id: string): Promise<MaterialNaTela | null> {
  const [m] = await db
    .select({
      id: material.id,
      codigo: material.codigo,
      nome: material.nome,
      categoria: material.categoria,
      unidade: material.unidade,
      unidadesPorEmbalagem: material.unidadesPorEmbalagem,
      embalagem: material.embalagem,
      quantidadeMinima: material.quantidadeMinima,
      controlado: material.controlado,
      exigeLoteDoFabricante: material.exigeLoteDoFabricante,
    })
    .from(material)
    .where(eq(material.id, id))
    .limit(1)
  return m ?? null
}

export async function materiaisAtivos(): Promise<readonly MaterialNaTela[]> {
  return db
    .select({
      id: material.id,
      codigo: material.codigo,
      nome: material.nome,
      categoria: material.categoria,
      unidade: material.unidade,
      unidadesPorEmbalagem: material.unidadesPorEmbalagem,
      embalagem: material.embalagem,
      quantidadeMinima: material.quantidadeMinima,
      controlado: material.controlado,
      exigeLoteDoFabricante: material.exigeLoteDoFabricante,
    })
    .from(material)
    .where(eq(material.ativo, true))
    .orderBy(asc(material.nome))
}

export interface ResumoDoEstoque {
  readonly materiais: number
  readonly abaixoDoMinimo: number
  readonly zerados: number
  readonly lotesVencidos: number
  readonly lotesVencendo: number
  readonly valorTotal: string
  readonly valorVencido: string
}

/** Cartões do topo da tela. */
export async function resumoDoEstoque(): Promise<ResumoDoEstoque> {
  const posicao = await posicaoDeEstoque()
  const vencendo = await lotesVencendo()

  const valorTotal = posicao.reduce((acc, l) => acc + Math.round(Number(l.valorEmEstoque) * 100), 0)
  const vencidos = vencendo.filter((l) => l.avaliacao.situacao === 'vencido')
  const valorVencido = vencidos.reduce((acc, l) => acc + Math.round(Number(l.valorEmRisco) * 100), 0)

  return {
    materiais: posicao.length,
    abaixoDoMinimo: posicao.filter((l) => l.reposicao.situacao === 'abaixo_do_minimo').length,
    zerados: posicao.filter((l) => l.reposicao.situacao === 'zerado').length,
    lotesVencidos: vencidos.length,
    lotesVencendo: vencendo.filter((l) => l.avaliacao.situacao === 'vence_em_breve').length,
    valorTotal: (valorTotal / 100).toFixed(2),
    valorVencido: (valorVencido / 100).toFixed(2),
  }
}

export interface PacienteDoLote {
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly executadoEm: Date
  readonly procedimentoNome: string
  readonly quantidade: string
}

/**
 * **Recolhimento de lote**: em quais pacientes este lote foi usado.
 *
 * É a razão de `movimento_estoque.execucao_id` existir. Se o fabricante recolher
 * um lote de implante, a clínica tem de avisar quem recebeu — e sem esta consulta
 * a resposta seria procurar em papel, paciente por paciente.
 *
 * Isto lê dado de paciente: quem chama registra na auditoria.
 */
export async function pacientesQueReceberamOLote(
  loteId: string,
): Promise<readonly PacienteDoLote[]> {
  return db
    .select({
      pacienteId: paciente.id,
      pacienteNome: paciente.nome,
      executadoEm: execucao.executadoEm,
      procedimentoNome: procedimento.nome,
      quantidade: movimentoEstoque.quantidade,
    })
    .from(movimentoEstoque)
    .innerJoin(execucao, eq(execucao.id, movimentoEstoque.execucaoId))
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .where(and(eq(movimentoEstoque.loteId, loteId), eq(movimentoEstoque.tipo, 'consumo')))
    .orderBy(desc(execucao.executadoEm))
}
