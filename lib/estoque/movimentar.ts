import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { execucao, itemPlano, loteMaterial, material, movimentoEstoque, planoTratamento } from '@/lib/db/schema'
import {
  type TipoMovimento,
  planejarBaixaFefo,
  validarMovimento,
} from '@/lib/domain/estoque'
import { converterCompra, deMilesimos, paraMilesimos } from '@/lib/domain/quantidade'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { and, eq, gt } from 'drizzle-orm'

/**
 * Movimentação de estoque. **Núcleo, sem `'use server'`.**
 *
 * O mesmo desenho das fases 10 e 13: a lógica recebe o `Ator` por parâmetro e
 * vive fora da requisição, então o fluxo inteiro é verificável por script
 * (`npm run estoque:demonstrar`) sem subir HTTP nem sessão. A camada `acoes.ts`
 * só autoriza e delega.
 *
 * **O que este arquivo NÃO decide:** saldo negativo, consumo de lote vencido,
 * imutabilidade do livro e saída de controlado sem responsável são recusados
 * pelo BANCO (`drizzle/0019`). As verificações aqui existem para dar mensagem
 * boa na tela — não são a garantia. Se este arquivo tiver um bug, o estoque
 * continua íntegro.
 */

export type ResultadoEstoque =
  | { readonly ok: true; readonly mensagem: string; readonly ids?: readonly string[] }
  | { readonly ok: false; readonly mensagem: string }

/**
 * Erro de banco → mensagem que a recepção entende.
 *
 * **Lê a cadeia de `cause`, não só `message`.** O Drizzle embrulha o erro do
 * Postgres: `e.message` vira `"Failed query: insert into …"` e o texto que a
 * trigger escreveu fica em `e.cause`. Ler só `message` fazia toda mensagem boa
 * ("Lote L-VENCIDO venceu em …") virar o genérico do fim desta função — o
 * `npm run estoque:demo` pegou isso.
 */
function mensagemDoBanco(e: unknown): string {
  const partes: string[] = []
  let atual: unknown = e
  for (let i = 0; i < 5 && atual instanceof Error; i++) {
    partes.push(atual.message)
    atual = (atual as { cause?: unknown }).cause
  }
  return partes.length > 0 ? partes.join(' | ') : String(e)
}

function traduzirErro(e: unknown): string {
  const bruto = mensagemDoBanco(e)
  // As triggers de 0019 já falam português e citam o lote; repassar é melhor que
  // reescrever, porque a mensagem delas tem o número que a pessoa precisa ver.
  const marcadores = [
    'Saldo insuficiente',
    'venceu em',
    'append-only',
    'Material controlado',
    'exige o número do lote',
    'não troca de material',
    'Saldo do lote',
  ]
  if (marcadores.some((m) => bruto.includes(m))) {
    return bruto.replace(/^.*?(?=Saldo|Lote|Material|movimento_estoque)/s, '')
  }
  if (bruto.includes('movimento_sinal_pelo_tipo')) {
    return 'O sinal da quantidade não corresponde ao tipo de movimento.'
  }
  if (bruto.includes('movimento_ajuste_e_descarte_com_motivo')) {
    return 'Ajuste e descarte exigem motivo.'
  }
  if (bruto.includes('lote_saldo_nao_negativo')) {
    return 'A baixa deixaria o lote com saldo negativo.'
  }
  return 'Não foi possível registrar o movimento. Confira os dados e tente de novo.'
}

// ── Entrada (recebimento) ─────────────────────────────────────────────────────

export interface EntradaDeMaterial {
  readonly materialId: string
  /** Quantidade **em embalagens** quando `porEmbalagem`, senão em unidades de consumo. */
  readonly quantidade: string
  readonly porEmbalagem?: boolean
  readonly custoUnitario: string
  readonly codigoFabricante?: string
  /** Dia civil `YYYY-MM-DD`. Ausente = material sem validade. */
  readonly validade?: string
  readonly fornecedor?: string
  readonly notaFiscal?: string
  readonly recebidoEm?: string
}

/**
 * Registra um recebimento: cria o lote e o movimento de entrada.
 *
 * `porEmbalagem` é a proteção contra o erro clássico da nota fiscal — quem
 * recebe 2 caixas de 100 luvas marca "2 embalagens" e o sistema grava 200. Sem
 * isso, o lançamento de 2 unidades passa por todas as travas do banco (é uma
 * entrada válida) e só aparece como alerta de mínimo que nunca dispara.
 */
export async function registrarEntradaComAtor(
  ator: Ator,
  entrada: EntradaDeMaterial,
): Promise<ResultadoEstoque> {
  const [m] = await db.select().from(material).where(eq(material.id, entrada.materialId)).limit(1)
  if (!m) return { ok: false, mensagem: 'Material não encontrado.' }

  const quantidade = entrada.porEmbalagem
    ? converterCompra(entrada.quantidade, m.unidadesPorEmbalagem)
    : entrada.quantidade

  const validacao = validarMovimento({ tipo: 'entrada', quantidade })
  if (!validacao.ok) return { ok: false, mensagem: validacao.mensagem }

  const recebidoEm = entrada.recebidoEm ?? (await hojeDaClinica())

  try {
    const ids = await db.transaction(async (tx) => {
      const [lote] = await tx
        .insert(loteMaterial)
        .values({
          materialId: entrada.materialId,
          codigoFabricante: entrada.codigoFabricante?.trim() || null,
          validade: entrada.validade ?? null,
          custoUnitario: entrada.custoUnitario,
          fornecedor: entrada.fornecedor?.trim() || null,
          notaFiscal: entrada.notaFiscal?.trim() || null,
          recebidoEm,
          criadoPorId: ator.usuarioId,
        })
        .returning({ id: loteMaterial.id })

      if (!lote) throw new Error('lote não criado')

      const [mov] = await tx
        .insert(movimentoEstoque)
        .values({
          loteId: lote.id,
          materialId: entrada.materialId,
          tipo: 'entrada',
          quantidade,
          custoUnitario: entrada.custoUnitario,
          registradoPorId: ator.usuarioId,
        })
        .returning({ id: movimentoEstoque.id })

      return [lote.id, mov?.id].filter((x): x is string => typeof x === 'string')
    })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'lote_material',
      entidadeId: ids[0],
      detalhes: {
        material: m.codigo,
        quantidade,
        porEmbalagem: entrada.porEmbalagem === true,
        notaFiscal: entrada.notaFiscal ?? null,
      },
    })

    return {
      ok: true,
      ids,
      mensagem: `Entrada de ${quantidade} ${m.unidade} de ${m.nome} registrada.`,
    }
  } catch (e) {
    return { ok: false, mensagem: traduzirErro(e) }
  }
}

// ── Baixa por FEFO ────────────────────────────────────────────────────────────

export interface BaixaDeMaterial {
  readonly materialId: string
  readonly quantidade: string
  readonly tipo: Extract<TipoMovimento, 'consumo' | 'descarte' | 'devolucao'>
  readonly motivo?: string
  readonly execucaoId?: string
  readonly profissionalId?: string
  /** Lote específico, quando quem dá baixa sabe qual usou. Sem isto, FEFO decide. */
  readonly loteId?: string
}

/**
 * Dá baixa respeitando FEFO, podendo atravessar mais de um lote.
 *
 * Consumo de 5 com lotes de 3 e 4 gera **dois** movimentos, cada um no seu lote —
 * e não um movimento de 5 "no material". Isso é o que preserva a rastreabilidade:
 * saber que 3 unidades saíram do lote recolhido e 2 do outro.
 */
export async function darBaixaComAtor(
  ator: Ator,
  baixa: BaixaDeMaterial,
): Promise<ResultadoEstoque> {
  const [m] = await db.select().from(material).where(eq(material.id, baixa.materialId)).limit(1)
  if (!m) return { ok: false, mensagem: 'Material não encontrado.' }

  const validacao = validarMovimento({
    tipo: baixa.tipo,
    quantidade: `-${baixa.quantidade.replace('-', '')}`,
    motivo: baixa.motivo,
  })
  if (!validacao.ok) return { ok: false, mensagem: validacao.mensagem }

  if (m.controlado && !baixa.profissionalId) {
    return {
      ok: false,
      mensagem: `${m.nome} é de controle especial: informe o profissional responsável pela retirada.`,
    }
  }

  const hoje = await hojeDaClinica()

  const lotes = await db
    .select({
      id: loteMaterial.id,
      saldo: loteMaterial.saldo,
      validade: loteMaterial.validade,
      recebidoEm: loteMaterial.recebidoEm,
      custoUnitario: loteMaterial.custoUnitario,
    })
    .from(loteMaterial)
    .where(
      baixa.loteId
        ? and(eq(loteMaterial.id, baixa.loteId), gt(loteMaterial.saldo, '0'))
        : and(eq(loteMaterial.materialId, baixa.materialId), gt(loteMaterial.saldo, '0')),
    )

  // Descarte e devolução PODEM sair de lote vencido — é justamente o que se faz
  // com ele. Só o consumo é que não pode, e é o único que passa pelo filtro FEFO.
  const candidatos =
    baixa.tipo === 'consumo'
      ? lotes
      : lotes.map((l) => ({ ...l, validade: null as string | null }))

  const plano = planejarBaixaFefo(candidatos, baixa.quantidade, hoje)

  if (!plano.atende) {
    const vencidos = plano.vencidosIgnorados.length
    return {
      ok: false,
      mensagem:
        `Saldo insuficiente de ${m.nome}: faltam ${plano.faltante} ${m.unidade}.` +
        (vencidos > 0
          ? ` Há ${vencidos} lote(s) vencido(s) com saldo — eles não podem ser consumidos, só descartados.`
          : ''),
    }
  }

  const custoPorLote = new Map(lotes.map((l) => [l.id, l.custoUnitario]))

  try {
    const ids = await db.transaction(async (tx) => {
      const criados: string[] = []
      for (const a of plano.alocacoes) {
        const [mov] = await tx
          .insert(movimentoEstoque)
          .values({
            loteId: a.loteId,
            materialId: baixa.materialId,
            tipo: baixa.tipo,
            quantidade: deMilesimos(-paraMilesimos(a.quantidade)),
            custoUnitario: custoPorLote.get(a.loteId) ?? null,
            motivo: baixa.motivo?.trim() || null,
            execucaoId: baixa.tipo === 'consumo' ? (baixa.execucaoId ?? null) : null,
            profissionalId: baixa.profissionalId ?? ator.profissionalId ?? null,
            registradoPorId: ator.usuarioId,
          })
          .returning({ id: movimentoEstoque.id })
        if (mov) criados.push(mov.id)
      }
      return criados
    })

    // Consumo ligado a execução toca dado de paciente: a auditoria precisa do
    // paciente para responder "quem mexeu no prontuário deste paciente?".
    const pacienteId = baixa.execucaoId ? await pacienteDaExecucao(baixa.execucaoId) : null

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'movimento_estoque',
      entidadeId: ids[0],
      pacienteId,
      detalhes: {
        material: m.codigo,
        tipo: baixa.tipo,
        quantidade: baixa.quantidade,
        lotes: plano.alocacoes.length,
        controlado: m.controlado,
      },
    })

    return {
      ok: true,
      ids,
      mensagem:
        plano.alocacoes.length === 1
          ? `Baixa de ${baixa.quantidade} ${m.unidade} de ${m.nome} registrada.`
          : `Baixa de ${baixa.quantidade} ${m.unidade} de ${m.nome} registrada em ${plano.alocacoes.length} lotes (FEFO).`,
    }
  } catch (e) {
    return { ok: false, mensagem: traduzirErro(e) }
  }
}

async function pacienteDaExecucao(execucaoId: string): Promise<string | null> {
  const [linha] = await db
    .select({ pacienteId: planoTratamento.pacienteId })
    .from(execucao)
    .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .where(eq(execucao.id, execucaoId))
    .limit(1)
  return linha?.pacienteId ?? null
}

// ── Ajuste de inventário ──────────────────────────────────────────────────────

export interface AjusteDeInventario {
  readonly loteId: string
  /** Quantidade CONTADA na prateleira. A diferença é que vira movimento. */
  readonly quantidadeContada: string
  readonly motivo: string
}

/**
 * Ajusta um lote para a quantidade contada.
 *
 * Recebe **o que foi contado**, não a diferença. Pedir a diferença obrigaria
 * quem está com a caixa na mão a fazer subtração de cabeça — e é aí que a
 * contagem passa a divergir do estoque em vez de corrigi-lo.
 */
export async function ajustarInventarioComAtor(
  ator: Ator,
  ajuste: AjusteDeInventario,
): Promise<ResultadoEstoque> {
  const [lote] = await db
    .select({
      id: loteMaterial.id,
      materialId: loteMaterial.materialId,
      saldo: loteMaterial.saldo,
      custoUnitario: loteMaterial.custoUnitario,
    })
    .from(loteMaterial)
    .where(eq(loteMaterial.id, ajuste.loteId))
    .limit(1)
  if (!lote) return { ok: false, mensagem: 'Lote não encontrado.' }

  if (!ajuste.motivo?.trim()) {
    return {
      ok: false,
      mensagem:
        'Ajuste exige motivo: sem ele, perda de material e erro de lançamento ficam indistinguíveis.',
    }
  }

  const diferenca = paraMilesimos(ajuste.quantidadeContada) - paraMilesimos(lote.saldo)
  if (diferenca === 0) {
    return { ok: true, mensagem: 'A contagem confere com o sistema. Nada a ajustar.' }
  }

  try {
    const [mov] = await db
      .insert(movimentoEstoque)
      .values({
        loteId: lote.id,
        materialId: lote.materialId,
        tipo: 'ajuste',
        quantidade: deMilesimos(diferenca),
        custoUnitario: lote.custoUnitario,
        motivo: ajuste.motivo.trim(),
        profissionalId: ator.profissionalId ?? null,
        registradoPorId: ator.usuarioId,
      })
      .returning({ id: movimentoEstoque.id })

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'lote_material',
      entidadeId: lote.id,
      detalhes: {
        ajuste: deMilesimos(diferenca),
        saldoAnterior: lote.saldo,
        contado: ajuste.quantidadeContada,
        motivo: ajuste.motivo.trim(),
      },
    })

    const sinal = diferenca > 0 ? 'sobra' : 'falta'
    return {
      ok: true,
      ids: mov ? [mov.id] : [],
      mensagem: `Ajuste registrado: ${sinal} de ${deMilesimos(Math.abs(diferenca))}. Saldo agora é ${ajuste.quantidadeContada}.`,
    }
  } catch (e) {
    return { ok: false, mensagem: traduzirErro(e) }
  }
}

// ── Descarte de lote vencido ──────────────────────────────────────────────────

/**
 * Descarta todo o saldo de um lote.
 *
 * Atalho da tela de validade: é a ação que se faz depois de olhar a prateleira e
 * achar o lote vencido. Continua sendo movimento com motivo — o valor perdido
 * fica no livro, que é o que permite discutir compra excessiva depois.
 */
export async function descartarLoteComAtor(
  ator: Ator,
  loteId: string,
  motivo: string,
): Promise<ResultadoEstoque> {
  const [lote] = await db
    .select({
      id: loteMaterial.id,
      materialId: loteMaterial.materialId,
      saldo: loteMaterial.saldo,
      custoUnitario: loteMaterial.custoUnitario,
    })
    .from(loteMaterial)
    .where(eq(loteMaterial.id, loteId))
    .limit(1)
  if (!lote) return { ok: false, mensagem: 'Lote não encontrado.' }
  if (paraMilesimos(lote.saldo) === 0) {
    return { ok: false, mensagem: 'Este lote já está zerado.' }
  }
  if (!motivo?.trim()) return { ok: false, mensagem: 'Descarte exige motivo.' }

  return darBaixaComAtor(ator, {
    materialId: lote.materialId,
    quantidade: lote.saldo,
    tipo: 'descarte',
    motivo: motivo.trim(),
    loteId: lote.id,
  })
}

// ── Cadastro ──────────────────────────────────────────────────────────────────

export interface DadosDoMaterial {
  readonly codigo: string
  readonly nome: string
  readonly categoria: string
  readonly unidade: string
  readonly unidadesPorEmbalagem?: number
  readonly embalagem?: string
  readonly quantidadeMinima?: string
  readonly controlado?: boolean
  readonly exigeLoteDoFabricante?: boolean
  readonly descricao?: string
}

export async function salvarMaterialComAtor(
  ator: Ator,
  dados: DadosDoMaterial,
  id?: string,
): Promise<ResultadoEstoque> {
  if (!dados.codigo?.trim() || !dados.nome?.trim()) {
    return { ok: false, mensagem: 'Código e nome são obrigatórios.' }
  }

  try {
    const valores = {
      codigo: dados.codigo.trim(),
      nome: dados.nome.trim(),
      categoria: dados.categoria as never,
      unidade: dados.unidade as never,
      unidadesPorEmbalagem: dados.unidadesPorEmbalagem ?? 1,
      embalagem: dados.embalagem?.trim() || null,
      quantidadeMinima: dados.quantidadeMinima ?? '0',
      controlado: dados.controlado ?? false,
      exigeLoteDoFabricante: dados.exigeLoteDoFabricante ?? false,
      descricao: dados.descricao?.trim() || null,
    }

    if (id) {
      await db
        .update(material)
        .set({ ...valores, atualizadoEm: new Date() })
        .where(eq(material.id, id))
      await registrar({
        ator,
        acao: 'atualizacao',
        entidade: 'material',
        entidadeId: id,
        detalhes: { codigo: valores.codigo },
      })
      return { ok: true, ids: [id], mensagem: `${valores.nome} atualizado.` }
    }

    const [novo] = await db.insert(material).values(valores).returning({ id: material.id })
    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'material',
      entidadeId: novo?.id,
      detalhes: { codigo: valores.codigo },
    })
    return { ok: true, ids: novo ? [novo.id] : [], mensagem: `${valores.nome} cadastrado.` }
  } catch (e) {
    const bruto = e instanceof Error ? e.message : String(e)
    if (bruto.includes('material_codigo_unique')) {
      return { ok: false, mensagem: `Já existe material com o código ${dados.codigo}.` }
    }
    return { ok: false, mensagem: traduzirErro(e) }
  }
}

/** Ajusta só o mínimo — é o que a clínica mexe com frequência. */
export async function definirMinimoComAtor(
  ator: Ator,
  materialId: string,
  quantidadeMinima: string,
): Promise<ResultadoEstoque> {
  if (paraMilesimos(quantidadeMinima) < 0) {
    return { ok: false, mensagem: 'O mínimo não pode ser negativo.' }
  }
  await db
    .update(material)
    .set({ quantidadeMinima, atualizadoEm: new Date() })
    .where(eq(material.id, materialId))
  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'material',
    entidadeId: materialId,
    detalhes: { quantidadeMinima },
  })
  return { ok: true, mensagem: `Mínimo definido em ${quantidadeMinima}.` }
}
