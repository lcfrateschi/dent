import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  convenio,
  glosa,
  guiaTiss,
  itemGuia,
  itemPlano,
  pacienteConvenio,
  procedimento,
  recursoGlosa,
  repasse,
  repasseItem,
} from '@/lib/db/schema'
import { descreverFaces } from '@/lib/domain/faces'
import { somar, subtrair } from '@/lib/domain/dinheiro'
import { type ClasseGlosa, previsaoDeRepasse } from '@/lib/domain/convenio'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

/**
 * O ciclo da guia, chamável com um `Ator`.
 *
 * A lógica mora aqui e a autorização mora em `acoes.ts` — mesmo arranjo de
 * `lib/documentos/anexar.ts`. O ganho é concreto: este caminho é exercitável fora
 * de uma requisição HTTP, e é o que permite `npm run convenio:demo` conferir os
 * valores do faturamento contra o Postgres de verdade.
 */

export type ResultadoTiss =
  | { ok: true; mensagem: string; id?: string; numero?: string }
  | { ok: false; mensagem: string }

function mensagemDeErro(e: unknown): string {
  let atual: unknown = e
  while (atual instanceof Error) {
    const m = atual.message
    if (!m.startsWith('Failed query') && !m.includes('insert into')) return m
    atual = (atual as { cause?: unknown }).cause
  }
  return 'Não foi possível concluir a operação.'
}

/**
 * Monta uma guia com os itens escolhidos.
 *
 * Todos os itens precisam ser do **mesmo paciente e mesmo convênio** — é o que a
 * guia é. Misturar pacientes numa guia é rejeição no protocolo, e a checagem fica
 * aqui porque o banco não tem como saber que aqueles ids deveriam formar um
 * documento coerente.
 */
export async function montarGuiaComAtor(
  ator: Ator,
  entrada: {
  readonly itemPlanoIds: readonly string[]
  readonly profissionalId: string
  readonly observacao?: string
}): Promise<ResultadoTiss> {

  if (entrada.itemPlanoIds.length === 0) {
    return { ok: false, mensagem: 'Escolha pelo menos um procedimento.' }
  }

  try {
    const itens = await db
      .select({
        id: itemPlano.id,
        convenioId: itemPlano.convenioId,
        pacienteId: sql<string>`(select pt.paciente_id from plano_tratamento pt where pt.id = ${itemPlano.planoId})`,
        valor: itemPlano.valor,
        denteFdi: itemPlano.denteFdi,
        faces: itemPlano.faces,
        guiaTissId: itemPlano.guiaTissId,
        cobertura: itemPlano.cobertura,
        procedimentoNome: procedimento.nome,
        codigoTuss: procedimento.codigoTuss,
        dataExecucao: sql<string>`(
          select min(e.executado_em)::date::text from execucao e where e.item_plano_id = ${itemPlano.id}
        )`,
      })
      .from(itemPlano)
      .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
      .where(inArray(itemPlano.id, [...entrada.itemPlanoIds]))

    if (itens.length !== entrada.itemPlanoIds.length) {
      return { ok: false, mensagem: 'Algum procedimento não foi encontrado.' }
    }

    const jaFaturado = itens.find((i) => i.guiaTissId !== null)
    if (jaFaturado) {
      return {
        ok: false,
        mensagem: `"${jaFaturado.procedimentoNome}" já está em outra guia. Remova da seleção.`,
      }
    }

    const particular = itens.find((i) => i.cobertura !== 'convenio')
    if (particular) {
      return {
        ok: false,
        mensagem: `"${particular.procedimentoNome}" é particular e não vai em guia de convênio.`,
      }
    }

    const semExecucao = itens.find((i) => !i.dataExecucao)
    if (semExecucao) {
      // Guia é cobrança de serviço prestado. Sem execução registrada, não há o que
      // apresentar — e a operadora glosa por procedimento não realizado.
      return {
        ok: false,
        mensagem: `"${semExecucao.procedimentoNome}" não tem execução registrada. Registre no prontuário antes de faturar.`,
      }
    }

    const pacientes = new Set(itens.map((i) => i.pacienteId))
    const convenios = new Set(itens.map((i) => i.convenioId))
    if (pacientes.size > 1) {
      return { ok: false, mensagem: 'Uma guia é de um paciente só. Separe em guias diferentes.' }
    }
    if (convenios.size > 1) {
      return { ok: false, mensagem: 'Uma guia é de um convênio só.' }
    }

    const pacienteId = [...pacientes][0]!
    const convenioId = [...convenios][0]!

    const [carteirinha] = await db
      .select({ numero: pacienteConvenio.numeroCarteirinha })
      .from(pacienteConvenio)
      .where(
        and(
          eq(pacienteConvenio.pacienteId, pacienteId),
          eq(pacienteConvenio.convenioId, convenioId),
          eq(pacienteConvenio.ativo, true),
        ),
      )

    if (!carteirinha) {
      return {
        ok: false,
        mensagem: 'O paciente não tem carteirinha ativa deste convênio. Cadastre antes de faturar.',
      }
    }

    const total = somar(...itens.map((i) => i.valor))

    const criada = await db.transaction(async (tx) => {
      const [guia] = await tx
        .insert(guiaTiss)
        .values({
          convenioId,
          pacienteId,
          numeroCarteirinha: carteirinha.numero,
          profissionalId: entrada.profissionalId,
          valorApresentado: total,
          observacao: entrada.observacao?.trim() || null,
          criadoPorId: ator.usuarioId,
        })
        .returning({ id: guiaTiss.id, numero: guiaTiss.numero })

      await tx.insert(itemGuia).values(
        itens.map((i) => ({
          guiaId: guia!.id,
          itemPlanoId: i.id,
          // Código TUSS CONGELADO na emissão: o catálogo pode ser corrigido
          // depois, e a guia tem de continuar mostrando o que foi apresentado.
          codigoTuss: i.codigoTuss,
          descricao: i.procedimentoNome,
          denteFdi: i.denteFdi,
          faces:
            i.denteFdi && i.faces && i.faces.length > 0
              ? descreverFaces(i.denteFdi, i.faces).slice(0, 60)
              : null,
          quantidade: 1,
          dataExecucao: i.dataExecucao,
          valorApresentado: i.valor,
        })),
      )

      // Liga o item do plano à guia: é o filtro de `execucoesAFaturar`, e o que
      // impede o mesmo procedimento entrar em duas guias.
      await tx
        .update(itemPlano)
        .set({ guiaTissId: guia!.id, status: 'faturado' })
        .where(inArray(itemPlano.id, itens.map((i) => i.id)))

      return guia!
    })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'guia_tiss',
      entidadeId: criada.id,
      pacienteId,
      detalhes: { numero: String(criada.numero), itens: itens.length, valor: total },
    })

    return {
      ok: true,
      mensagem: `Guia ${criada.numero} montada com ${itens.length} procedimento(s).`,
      id: criada.id,
      numero: String(criada.numero),
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Envia a guia à operadora.
 *
 * Depois disto o que foi apresentado é imutável (trigger em `drizzle/0016`), e a
 * previsão de repasse é calculada do envio + prazo contratual — não da execução:
 * o contrato fala do protocolo.
 */
export async function enviarGuiaComAtor(
  ator: Ator,
  guiaId: string,
  numeroLote: string,
): Promise<ResultadoTiss> {

  try {
    const [g] = await db
      .select({
        id: guiaTiss.id,
        numero: guiaTiss.numero,
        situacao: guiaTiss.situacao,
        pacienteId: guiaTiss.pacienteId,
        prazoDias: convenio.prazoPagamentoDias,
        itens: sql<number>`(select count(*)::int from item_guia ig where ig.guia_id = ${guiaTiss.id})`,
      })
      .from(guiaTiss)
      .innerJoin(convenio, eq(convenio.id, guiaTiss.convenioId))
      .where(eq(guiaTiss.id, guiaId))

    if (!g) return { ok: false, mensagem: 'Guia não encontrada.' }
    if (g.situacao !== 'rascunho') {
      return { ok: false, mensagem: `Esta guia já está em "${g.situacao}".` }
    }
    if (g.itens === 0) {
      return { ok: false, mensagem: 'Guia sem procedimento não pode ser enviada.' }
    }

    const agora = new Date()
    const hoje = agora.toISOString().slice(0, 10)

    await db
      .update(guiaTiss)
      .set({
        situacao: 'enviada',
        enviadaEm: agora,
        numeroLote: numeroLote.trim() || null,
        previsaoRepasse: previsaoDeRepasse(hoje, g.prazoDias),
      })
      .where(eq(guiaTiss.id, guiaId))

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'guia_tiss',
      entidadeId: guiaId,
      pacienteId: g.pacienteId,
      detalhes: { enviada: true, numero: String(g.numero), lote: numeroLote },
    })

    return { ok: true, mensagem: `Guia ${g.numero} enviada.` }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Registra o retorno da operadora para um item: quanto pagou e, se pagou menos,
 * a glosa com o motivo.
 *
 * **A glosa é calculada, não digitada**: é `apresentado − pago`. O que a pessoa
 * informa é o motivo e a classe, que é o que a operadora manda no demonstrativo.
 */
export async function registrarRetornoComAtor(
  ator: Ator,
  entrada: {
  readonly itemGuiaId: string
  readonly valorPago: string
  readonly classeGlosa?: ClasseGlosa
  readonly motivoGlosa?: string
    readonly codigoOperadora?: string
  },
): Promise<ResultadoTiss> {

  try {
    const [item] = await db
      .select({
        id: itemGuia.id,
        guiaId: itemGuia.guiaId,
        valorApresentado: itemGuia.valorApresentado,
        descricao: itemGuia.descricao,
        pacienteId: guiaTiss.pacienteId,
        situacaoGuia: guiaTiss.situacao,
      })
      .from(itemGuia)
      .innerJoin(guiaTiss, eq(guiaTiss.id, itemGuia.guiaId))
      .where(eq(itemGuia.id, entrada.itemGuiaId))

    if (!item) return { ok: false, mensagem: 'Item não encontrado.' }
    if (item.situacaoGuia === 'rascunho') {
      return { ok: false, mensagem: 'Guia ainda não foi enviada — não há retorno para registrar.' }
    }

    const diferenca = subtrair(item.valorApresentado, entrada.valorPago)
    const houveGlosa = Number(diferenca) > 0

    if (Number(entrada.valorPago) < 0) {
      return { ok: false, mensagem: 'Valor pago não pode ser negativo.' }
    }
    if (Number(entrada.valorPago) > Number(item.valorApresentado)) {
      return {
        ok: false,
        mensagem: `A operadora não pode pagar mais que o apresentado (${item.valorApresentado}). Confira o demonstrativo.`,
      }
    }
    if (houveGlosa && (!entrada.classeGlosa || !entrada.motivoGlosa?.trim())) {
      // Glosa sem motivo é glosa que não se pode recorrer.
      return {
        ok: false,
        mensagem: 'Houve glosa: informe a classe e o motivo que a operadora deu.',
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .update(itemGuia)
        .set({
          situacao: houveGlosa
            ? Number(entrada.valorPago) > 0
              ? 'glosado_parcial'
              : 'glosado_total'
            : 'pago',
        })
        .where(eq(itemGuia.id, entrada.itemGuiaId))

      if (houveGlosa) {
        await tx.insert(glosa).values({
          itemGuiaId: entrada.itemGuiaId,
          classe: entrada.classeGlosa!,
          motivo: entrada.motivoGlosa!.trim(),
          codigoOperadora: entrada.codigoOperadora?.trim() || null,
          valor: diferenca,
          registradaPorId: ator.usuarioId,
        })

        // O item do plano volta para 'glosado': é o que o recoloca na fila de
        // `execucoesAFaturar` para eventual reapresentação.
        await tx
          .update(itemPlano)
          .set({ status: 'glosado' })
          .where(
            eq(
              itemPlano.id,
              sql`(select item_plano_id from item_guia where id = ${entrada.itemGuiaId})`,
            ),
          )
      }
    })

    await atualizarSituacaoDaGuia(item.guiaId)

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'item_guia',
      entidadeId: entrada.itemGuiaId,
      pacienteId: item.pacienteId,
      detalhes: {
        valorPago: entrada.valorPago,
        glosa: houveGlosa ? diferenca : null,
        classe: entrada.classeGlosa ?? null,
      },
    })

    return {
      ok: true,
      mensagem: houveGlosa
        ? `Retorno registrado com glosa de ${diferenca}.`
        : 'Item pago integralmente.',
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Recalcula a situação da guia a partir dos itens.
 *
 * Deriva em vez de deixar a pessoa escolher: "paga" com um item glosado dentro é
 * exatamente como a clínica perde o que foi glosado — a guia sai da fila de
 * cobrança e ninguém recorre.
 */
async function atualizarSituacaoDaGuia(guiaId: string): Promise<void> {
  const [resumo] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pagos: sql<number>`count(*) filter (where ${itemGuia.situacao} = 'pago')::int`,
      glosadosTotal: sql<number>`count(*) filter (where ${itemGuia.situacao} = 'glosado_total')::int`,
      apresentados: sql<number>`count(*) filter (where ${itemGuia.situacao} = 'apresentado')::int`,
    })
    .from(itemGuia)
    .where(eq(itemGuia.guiaId, guiaId))

  if (!resumo || resumo.total === 0) return

  const situacao =
    resumo.apresentados > 0
      ? 'em_analise'
      : resumo.pagos === resumo.total
        ? 'paga'
        : resumo.glosadosTotal === resumo.total
          ? 'glosada_total'
          : 'glosada_parcial'

  await db
    .update(guiaTiss)
    .set({ situacao, retornoEm: new Date() })
    .where(eq(guiaTiss.id, guiaId))
}

/** Recorre de uma glosa. */
export async function recorrerComAtor(
  ator: Ator,
  glosaId: string,
  argumento: string,
): Promise<ResultadoTiss> {

  if (argumento.trim().length < 20) {
    return {
      ok: false,
      mensagem: 'Escreva o argumento do recurso — é o que a operadora vai analisar.',
    }
  }

  try {
    const [existente] = await db
      .select({ id: recursoGlosa.id })
      .from(recursoGlosa)
      .where(eq(recursoGlosa.glosaId, glosaId))

    if (existente) {
      return { ok: false, mensagem: 'Esta glosa já tem recurso registrado.' }
    }

    const [criado] = await db
      .insert(recursoGlosa)
      .values({
        glosaId,
        argumento: argumento.trim(),
        enviadoPorId: ator.usuarioId,
      })
      .returning({ id: recursoGlosa.id })

    await db
      .update(itemGuia)
      .set({ situacao: 'em_recurso' })
      .where(
        eq(itemGuia.id, sql`(select item_guia_id from glosa where id = ${glosaId})`),
      )

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'recurso_glosa',
      entidadeId: criado!.id,
      detalhes: { glosaId },
    })

    return { ok: true, mensagem: 'Recurso registrado.' }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Registra a resposta da operadora ao recurso. */
export async function responderRecursoComAtor(
  ator: Ator,
  recursoId: string,
  deferido: boolean,
  motivo: string,
): Promise<ResultadoTiss> {

  try {
    const feitas = await db
      .update(recursoGlosa)
      .set({ deferido, respostaEm: new Date(), respostaMotivo: motivo.trim() || null })
      .where(and(eq(recursoGlosa.id, recursoId), isNull(recursoGlosa.deferido)))
      .returning({ id: recursoGlosa.id, glosaId: recursoGlosa.glosaId })

    if (feitas.length === 0) {
      return { ok: false, mensagem: 'Recurso não encontrado ou já respondido.' }
    }

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'recurso_glosa',
      entidadeId: recursoId,
      detalhes: { deferido },
    })

    return {
      ok: true,
      mensagem: deferido
        ? 'Recurso deferido. O valor entra no próximo repasse.'
        : 'Recurso indeferido. Decida se o valor passa a ser do paciente.',
    }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Registra um repasse recebido. */
export async function registrarRepasseComAtor(
  ator: Ator,
  entrada: {
  readonly convenioId: string
  readonly valorTotal: string
  readonly recebidoEm: string
    readonly demonstrativo?: string
  },
): Promise<ResultadoTiss> {

  if (Number(entrada.valorTotal) <= 0) {
    return { ok: false, mensagem: 'O valor do repasse tem de ser positivo.' }
  }

  try {
    const [criado] = await db
      .insert(repasse)
      .values({
        convenioId: entrada.convenioId,
        valorTotal: entrada.valorTotal,
        recebidoEm: entrada.recebidoEm,
        demonstrativo: entrada.demonstrativo?.trim() || null,
        criadoPorId: ator.usuarioId,
      })
      .returning({ id: repasse.id })

    await registrar({
      ator,
      acao: 'criacao',
      entidade: 'repasse',
      entidadeId: criado!.id,
      detalhes: { valor: entrada.valorTotal, convenioId: entrada.convenioId },
    })

    return { ok: true, mensagem: 'Repasse registrado. Agora concilie item a item.', id: criado!.id }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/**
 * Concilia o repasse com os itens.
 *
 * Uma transação para todas as atribuições: a constraint deferida confere no COMMIT
 * que a soma não passa do total recebido. Lançar uma a uma deixaria a conciliação
 * pela metade se alguma falhasse.
 */
export async function conciliarComAtor(
  ator: Ator,
  repasseId: string,
  atribuicoes: readonly { readonly itemGuiaId: string; readonly valor: string }[],
): Promise<ResultadoTiss> {

  const validas = atribuicoes.filter((a) => Number(a.valor) > 0)
  if (validas.length === 0) {
    return { ok: false, mensagem: 'Informe pelo menos um valor para conciliar.' }
  }

  try {
    await db.transaction(async (tx) => {
      for (const a of validas) {
        await tx
          .insert(repasseItem)
          .values({ repasseId, itemGuiaId: a.itemGuiaId, valor: a.valor })
          // Reconciliar o mesmo item atualiza o valor em vez de duplicar.
          .onConflictDoUpdate({
            target: [repasseItem.repasseId, repasseItem.itemGuiaId],
            set: { valor: a.valor },
          })
      }
    })

    // A situação de cada guia afetada é recalculada a partir dos itens.
    const guiasAfetadas = await db
      .select({ guiaId: itemGuia.guiaId })
      .from(itemGuia)
      .where(inArray(itemGuia.id, validas.map((a) => a.itemGuiaId)))

    for (const g of new Set(guiasAfetadas.map((x) => x.guiaId))) {
      await atualizarSituacaoDaGuia(g)
    }

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'repasse',
      entidadeId: repasseId,
      detalhes: { itensConciliados: validas.length },
    })

    return { ok: true, mensagem: `${validas.length} item(ns) conciliado(s).` }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Fecha o repasse: a conferência acabou e a conciliação não muda mais. */
export async function fecharRepasseComAtor(ator: Ator, repasseId: string): Promise<ResultadoTiss> {

  try {
    const [r] = await db
      .select({
        valorTotal: repasse.valorTotal,
        valorConciliado: repasse.valorConciliado,
        fechadoEm: repasse.fechadoEm,
      })
      .from(repasse)
      .where(eq(repasse.id, repasseId))

    if (!r) return { ok: false, mensagem: 'Repasse não encontrado.' }
    if (r.fechadoEm) return { ok: false, mensagem: 'Este repasse já está fechado.' }

    const sobra = subtrair(r.valorTotal, r.valorConciliado)
    if (Number(sobra) > 0) {
      // Avisa, mas não bloqueia: sobra pode ser crédito de item que a clínica
      // ainda não achou, e travar o fechamento não resolve — só atrasa.
      await db.update(repasse).set({ fechadoEm: new Date() }).where(eq(repasse.id, repasseId))
      await registrar({
        ator,
        acao: 'atualizacao',
        entidade: 'repasse',
        entidadeId: repasseId,
        detalhes: { fechado: true, sobraNaoConciliada: sobra },
      })
      return {
        ok: true,
        mensagem: `Repasse fechado com ${sobra} sem conciliar. Vale conferir o demonstrativo.`,
      }
    }

    await db.update(repasse).set({ fechadoEm: new Date() }).where(eq(repasse.id, repasseId))
    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'repasse',
      entidadeId: repasseId,
      detalhes: { fechado: true },
    })

    return { ok: true, mensagem: 'Repasse fechado e conciliado por inteiro.' }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}

/** Cancela uma guia em rascunho, liberando os itens para outra guia. */
export async function cancelarGuiaComAtor(
  ator: Ator,
  guiaId: string,
  motivo: string,
): Promise<ResultadoTiss> {

  if (motivo.trim().length < 5) {
    return { ok: false, mensagem: 'Diga por que está cancelando a guia.' }
  }

  try {
    const [g] = await db
      .select({ situacao: guiaTiss.situacao, numero: guiaTiss.numero, pacienteId: guiaTiss.pacienteId })
      .from(guiaTiss)
      .where(eq(guiaTiss.id, guiaId))

    if (!g) return { ok: false, mensagem: 'Guia não encontrada.' }
    if (g.situacao !== 'rascunho') {
      return {
        ok: false,
        // Guia protocolada não se apaga: o que se faz é registrar o retorno.
        mensagem: 'Guia já enviada não se cancela aqui — registre o retorno da operadora.',
      }
    }

    await db.transaction(async (tx) => {
      // Libera os itens: voltam para a fila de faturamento.
      await tx
        .update(itemPlano)
        .set({ guiaTissId: null, status: 'executado' })
        .where(eq(itemPlano.guiaTissId, guiaId))

      await tx.delete(itemGuia).where(eq(itemGuia.guiaId, guiaId))

      await tx
        .update(guiaTiss)
        .set({
          situacao: 'cancelada',
          valorApresentado: '0.00',
          observacao: `Cancelada: ${motivo.trim().slice(0, 300)}`,
        })
        .where(eq(guiaTiss.id, guiaId))
    })

    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'guia_tiss',
      entidadeId: guiaId,
      pacienteId: g.pacienteId,
      detalhes: { cancelada: true, numero: String(g.numero) },
    })

    return { ok: true, mensagem: `Guia ${g.numero} cancelada. Os procedimentos voltaram para a fila.` }
  } catch (e) {
    return { ok: false, mensagem: mensagemDeErro(e) }
  }
}
