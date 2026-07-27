import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  clinica,
  convenio,
  execucao,
  glosa,
  guiaTiss,
  itemGuia,
  itemPlano,
  paciente,
  pacienteConvenio,
  planoTratamento,
  precoConvenio,
  procedimento,
  profissional,
  recursoGlosa,
  repasse,
  usuario,
} from '@/lib/db/schema'
import { atrasoDoRepasse } from '@/lib/domain/convenio'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'

/**
 * Leituras do faturamento por convênio.
 *
 * A consulta mais importante do módulo é `execucoesAFaturar`: ela responde "o que
 * já foi feito e ainda não foi cobrado da operadora?". Dinheiro que fica ali
 * parado é a forma mais comum de uma clínica com convênio perder receita — não por
 * glosa, por esquecimento.
 */

export interface ExecucaoAFaturar {
  readonly itemPlanoId: string
  readonly execucaoId: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly convenioId: string
  readonly convenioNome: string
  readonly numeroCarteirinha: string | null
  readonly profissionalId: string
  readonly profissionalNome: string
  readonly procedimentoNome: string
  readonly codigoTuss: string | null
  readonly denteFdi: number | null
  readonly valor: string
  readonly executadoEm: Date
  /** Dias desde a execução. Quanto maior, mais perto do prazo da operadora. */
  readonly diasParado: number
}

/**
 * Execuções de convênio ainda não faturadas.
 *
 * O filtro é `guia_tiss_id is null` — o gancho da Fase 1 usado exatamente para o
 * que foi criado. Ordenado pela execução mais ANTIGA primeiro: operadora tem prazo
 * para receber a guia, e o que está parado há mais tempo é o que corre risco de
 * glosa por prazo.
 */
export async function execucoesAFaturar(
  agora: Date,
  convenioId?: string,
): Promise<readonly ExecucaoAFaturar[]> {
  const condicoes = [
    eq(itemPlano.cobertura, 'convenio'),
    isNull(itemPlano.guiaTissId),
    sql`${itemPlano.status} in ('executado','glosado')`,
  ]
  if (convenioId) condicoes.push(eq(itemPlano.convenioId, convenioId))

  const linhas = await db
    .select({
      itemPlanoId: itemPlano.id,
      execucaoId: execucao.id,
      pacienteId: planoTratamento.pacienteId,
      pacienteNome: paciente.nome,
      convenioId: itemPlano.convenioId,
      convenioNome: convenio.nome,
      numeroCarteirinha: pacienteConvenio.numeroCarteirinha,
      profissionalId: execucao.profissionalId,
      profissionalNome: usuario.nome,
      procedimentoNome: procedimento.nome,
      codigoTuss: procedimento.codigoTuss,
      denteFdi: itemPlano.denteFdi,
      valor: itemPlano.valor,
      executadoEm: execucao.executadoEm,
    })
    .from(itemPlano)
    .innerJoin(execucao, eq(execucao.itemPlanoId, itemPlano.id))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .innerJoin(convenio, eq(convenio.id, itemPlano.convenioId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .innerJoin(profissional, eq(profissional.id, execucao.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    // `left join` na carteirinha: ela pode faltar, e isso é justamente o que a
    // tela precisa mostrar em destaque — sem carteirinha não há guia.
    .leftJoin(
      pacienteConvenio,
      and(
        eq(pacienteConvenio.pacienteId, planoTratamento.pacienteId),
        eq(pacienteConvenio.convenioId, itemPlano.convenioId),
        eq(pacienteConvenio.ativo, true),
      ),
    )
    .where(and(...condicoes))
    .orderBy(asc(execucao.executadoEm))
    .limit(300)

  return linhas.map((l) => ({
    ...l,
    convenioId: l.convenioId!,
    diasParado: Math.floor((agora.getTime() - l.executadoEm.getTime()) / 86_400_000),
  }))
}

export interface GuiaNaLista {
  readonly id: string
  readonly numero: string
  readonly situacao: string
  readonly convenioNome: string
  readonly pacienteNome: string
  readonly valorApresentado: string
  readonly valorPago: string
  readonly emitidaEm: Date
  readonly enviadaEm: Date | null
  readonly previsaoRepasse: string | null
  readonly numeroLote: string | null
  /** Dias de atraso do repasse. 0 = no prazo ou já pago. */
  readonly atrasoDias: number
}

/** Guias, com o atraso do repasse calculado. */
export async function guias(
  filtro: { readonly convenioId?: string; readonly situacao?: string } = {},
  hojeIso: string = new Date().toISOString().slice(0, 10),
): Promise<readonly GuiaNaLista[]> {
  const condicoes = []
  if (filtro.convenioId) condicoes.push(eq(guiaTiss.convenioId, filtro.convenioId))
  if (filtro.situacao) condicoes.push(eq(guiaTiss.situacao, filtro.situacao as 'enviada'))

  const linhas = await db
    .select({
      id: guiaTiss.id,
      numero: guiaTiss.numero,
      situacao: guiaTiss.situacao,
      convenioNome: convenio.nome,
      pacienteNome: paciente.nome,
      valorApresentado: guiaTiss.valorApresentado,
      valorPago: guiaTiss.valorPago,
      emitidaEm: guiaTiss.emitidaEm,
      enviadaEm: guiaTiss.enviadaEm,
      previsaoRepasse: guiaTiss.previsaoRepasse,
      numeroLote: guiaTiss.numeroLote,
    })
    .from(guiaTiss)
    .innerJoin(convenio, eq(convenio.id, guiaTiss.convenioId))
    .innerJoin(paciente, eq(paciente.id, guiaTiss.pacienteId))
    .where(condicoes.length > 0 ? and(...condicoes) : undefined)
    .orderBy(desc(guiaTiss.numero))
    .limit(200)

  return linhas.map((l) => ({
    ...l,
    numero: String(l.numero),
    // Só está atrasado o que ainda não foi pago por inteiro.
    atrasoDias:
      l.previsaoRepasse && Number(l.valorPago) < Number(l.valorApresentado)
        ? atrasoDoRepasse(l.previsaoRepasse, hojeIso)
        : 0,
  }))
}

/** Uma guia com itens, glosas e recursos — a tela de acompanhamento. */
export async function acharGuia(ator: Ator, id: string) {
  const [cabecalho] = await db
    .select({
      id: guiaTiss.id,
      numero: guiaTiss.numero,
      situacao: guiaTiss.situacao,
      convenioId: guiaTiss.convenioId,
      convenioNome: convenio.nome,
      registroAns: convenio.registroAns,
      prazoPagamentoDias: convenio.prazoPagamentoDias,
      pacienteId: guiaTiss.pacienteId,
      pacienteNome: paciente.nome,
      pacienteCpf: paciente.cpf,
      pacienteNascimento: paciente.dataNascimento,
      numeroCarteirinha: guiaTiss.numeroCarteirinha,
      profissionalNome: usuario.nome,
      cro: profissional.cro,
      ufCro: profissional.ufCro,
      /**
       * ── O cadastro que o XML TISS exige, lido do BANCO ─────────────────────
       *
       * Estes quatro campos são obrigatórios no XSD da ANS e antes não existiam em
       * lugar nenhum: `CadastroParaTiss` era montado à mão nos testes, e
       * `xmlGuiaOdontologica` estourava nomeando o que faltava. A `drizzle/0039` criou
       * três deles (o `plano` já existia desde a Fase 13, com a carteirinha).
       *
       * Vêm todos **anuláveis**, e é assim que tem de ser: clínica que não fatura
       * convênio não tem código de prestador, e exigir aqui travaria o cadastro de
       * quem nunca vai emitir guia. Quem cobra é `conferirAntesDeEnviar`, no momento
       * em que a guia é emitida — e ele lista o que falta, um por um, em vez de gerar
       * XML incompleto que passa no parser e volta como glosa semanas depois.
       */
      cnes: clinica.cnes,
      codigoPrestadorNaOperadora: convenio.codigoPrestador,
      cbos: profissional.cbos,
      planoBeneficiario: pacienteConvenio.plano,
      valorApresentado: guiaTiss.valorApresentado,
      valorPago: guiaTiss.valorPago,
      numeroLote: guiaTiss.numeroLote,
      protocoloOperadora: guiaTiss.protocoloOperadora,
      emitidaEm: guiaTiss.emitidaEm,
      enviadaEm: guiaTiss.enviadaEm,
      retornoEm: guiaTiss.retornoEm,
      previsaoRepasse: guiaTiss.previsaoRepasse,
      observacao: guiaTiss.observacao,
    })
    .from(guiaTiss)
    .innerJoin(convenio, eq(convenio.id, guiaTiss.convenioId))
    .innerJoin(paciente, eq(paciente.id, guiaTiss.pacienteId))
    .innerJoin(profissional, eq(profissional.id, guiaTiss.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    /**
     * `clinica` por join e não por consulta separada: é uma linha, e ler à parte
     * exigiria resolver "qual clínica" — que é justamente o `limit 1` sem critério que
     * a Fase 17 eliminou de dez lugares. Com o join, a clínica é a do tenant da guia,
     * por construção.
     *
     * `paciente_convenio` é LEFT: a guia pode existir sem carteirinha ativa registrada
     * (o número está congelado em `guia_tiss.numero_carteirinha`), e um `innerJoin`
     * faria a guia **desaparecer** da tela por falta de um campo opcional do XML.
     */
    .innerJoin(clinica, eq(clinica.id, guiaTiss.clinicaId))
    .leftJoin(
      pacienteConvenio,
      and(
        eq(pacienteConvenio.pacienteId, guiaTiss.pacienteId),
        eq(pacienteConvenio.convenioId, guiaTiss.convenioId),
        eq(pacienteConvenio.ativo, true),
      ),
    )
    .where(eq(guiaTiss.id, id))

  if (!cabecalho) return null

  const itens = await db
    .select({
      id: itemGuia.id,
      codigoTuss: itemGuia.codigoTuss,
      descricao: itemGuia.descricao,
      denteFdi: itemGuia.denteFdi,
      faces: itemGuia.faces,
      quantidade: itemGuia.quantidade,
      dataExecucao: itemGuia.dataExecucao,
      valorApresentado: itemGuia.valorApresentado,
      valorPago: itemGuia.valorPago,
      situacao: itemGuia.situacao,
      tentativa: itemGuia.tentativa,
    })
    .from(itemGuia)
    .where(eq(itemGuia.guiaId, id))
    .orderBy(asc(itemGuia.dataExecucao))

  const glosas = await db
    .select({
      id: glosa.id,
      itemGuiaId: glosa.itemGuiaId,
      codigoOperadora: glosa.codigoOperadora,
      classe: glosa.classe,
      motivo: glosa.motivo,
      valor: glosa.valor,
      registradaEm: glosa.registradaEm,
      recursoId: recursoGlosa.id,
      recursoEnviadoEm: recursoGlosa.enviadoEm,
      recursoDeferido: recursoGlosa.deferido,
      recursoResposta: recursoGlosa.respostaMotivo,
    })
    .from(glosa)
    .innerJoin(itemGuia, eq(itemGuia.id, glosa.itemGuiaId))
    .leftJoin(recursoGlosa, eq(recursoGlosa.glosaId, glosa.id))
    .where(eq(itemGuia.guiaId, id))
    .orderBy(desc(glosa.registradaEm))

  // Guia contém dado de saúde (procedimento, dente) e valor. Leitura é evento.
  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'guia_tiss',
    entidadeId: id,
    pacienteId: cabecalho.pacienteId,
    detalhes: { numero: String(cabecalho.numero) },
  })

  return { ...cabecalho, numero: String(cabecalho.numero), itens, glosas }
}

/**
 * Painel do convênio: o que está parado, o que venceu, o que foi glosado.
 *
 * ⚠️ As subconsultas referenciam `"convenio"."id"` **literalmente**, e não
 * `${convenio.id}`. O motivo é concreto: dentro de um template `sql`, o Drizzle
 * renderiza `${convenio.id}` como `"id"` — sem qualificar a tabela. Numa
 * subconsulta que junta `item_guia` (que também tem `id`), o Postgres responde
 * `column reference "id" is ambiguous` e a tela dá 500.
 */
export async function painelDeConvenios(hojeIso: string) {
  const linhas = await db
    .select({
      convenioId: convenio.id,
      nome: convenio.nome,
      prazoPagamentoDias: convenio.prazoPagamentoDias,
      aFaturar: sql<number>`(
        select count(*)::int from item_plano ip
        where ip.convenio_id = "convenio"."id"
          and ip.cobertura = 'convenio'
          and ip.guia_tiss_id is null
          and ip.status in ('executado','glosado')
      )`,
      valorAFaturar: sql<string>`coalesce((
        select sum(ip.valor)::text from item_plano ip
        where ip.convenio_id = "convenio"."id"
          and ip.cobertura = 'convenio'
          and ip.guia_tiss_id is null
          and ip.status in ('executado','glosado')
      ), '0.00')`,
      aReceber: sql<string>`coalesce((
        select sum(g.valor_apresentado - g.valor_pago)::text from guia_tiss g
        where g.convenio_id = "convenio"."id"
          and g.situacao in ('enviada','em_analise','glosada_parcial')
      ), '0.00')`,
      vencido: sql<string>`coalesce((
        select sum(g.valor_apresentado - g.valor_pago)::text from guia_tiss g
        where g.convenio_id = "convenio"."id"
          and g.situacao in ('enviada','em_analise','glosada_parcial')
          and g.previsao_repasse < ${hojeIso}::date
      ), '0.00')`,
      glosadoNoAno: sql<string>`coalesce((
        select sum(gl.valor)::text from glosa gl
        join item_guia ig on ig.id = gl.item_guia_id
        join guia_tiss g on g.id = ig.guia_id
        where g.convenio_id = "convenio"."id"
          and gl.registrada_em >= date_trunc('year', ${hojeIso}::date)
      ), '0.00')`,
    })
    .from(convenio)
    .where(eq(convenio.ativo, true))
    .orderBy(asc(convenio.nome))

  return linhas
}

/** Glosas em aberto, agrupadas por classe — a fila de recurso. */
export async function glosasEmAberto(limite = 100) {
  return db
    .select({
      id: glosa.id,
      classe: glosa.classe,
      motivo: glosa.motivo,
      valor: glosa.valor,
      registradaEm: glosa.registradaEm,
      guiaId: guiaTiss.id,
      guiaNumero: guiaTiss.numero,
      convenioNome: convenio.nome,
      pacienteNome: paciente.nome,
      descricao: itemGuia.descricao,
      temRecurso: sql<boolean>`${recursoGlosa.id} is not null`,
      recursoDeferido: recursoGlosa.deferido,
    })
    .from(glosa)
    .innerJoin(itemGuia, eq(itemGuia.id, glosa.itemGuiaId))
    .innerJoin(guiaTiss, eq(guiaTiss.id, itemGuia.guiaId))
    .innerJoin(convenio, eq(convenio.id, guiaTiss.convenioId))
    .innerJoin(paciente, eq(paciente.id, guiaTiss.pacienteId))
    .leftJoin(recursoGlosa, eq(recursoGlosa.glosaId, glosa.id))
    // Sem recurso, ou com recurso indeferido: os dois pedem decisão.
    .where(sql`${recursoGlosa.id} is null or ${recursoGlosa.deferido} is false`)
    .orderBy(desc(glosa.valor))
    .limit(limite)
}

/** Itens de guia esperando pagamento, para a tela de conciliação. */
export async function itensParaConciliar(convenioId: string, limite = 300) {
  return db
    .select({
      id: itemGuia.id,
      guiaNumero: guiaTiss.numero,
      pacienteNome: paciente.nome,
      descricao: itemGuia.descricao,
      dataExecucao: itemGuia.dataExecucao,
      valorApresentado: itemGuia.valorApresentado,
      valorPago: itemGuia.valorPago,
      situacao: itemGuia.situacao,
    })
    .from(itemGuia)
    .innerJoin(guiaTiss, eq(guiaTiss.id, itemGuia.guiaId))
    .innerJoin(paciente, eq(paciente.id, guiaTiss.pacienteId))
    .where(
      and(
        eq(guiaTiss.convenioId, convenioId),
        sql`${guiaTiss.situacao} in ('enviada','em_analise','glosada_parcial')`,
        // Só o que ainda falta receber.
        sql`coalesce(${itemGuia.valorPago}, 0) < ${itemGuia.valorApresentado}`,
      ),
    )
    .orderBy(asc(guiaTiss.numero), asc(itemGuia.dataExecucao))
    .limit(limite)
}

/** Repasses de um convênio. */
export async function repassesDoConvenio(convenioId: string, limite = 50) {
  return db
    .select({
      id: repasse.id,
      valorTotal: repasse.valorTotal,
      valorConciliado: repasse.valorConciliado,
      recebidoEm: repasse.recebidoEm,
      demonstrativo: repasse.demonstrativo,
      fechadoEm: repasse.fechadoEm,
    })
    .from(repasse)
    .where(eq(repasse.convenioId, convenioId))
    .orderBy(desc(repasse.recebidoEm))
    .limit(limite)
}

/** Convênios ativos, para os seletores. */
export async function conveniosAtivos() {
  return db
    .select({
      id: convenio.id,
      nome: convenio.nome,
      registroAns: convenio.registroAns,
      prazoPagamentoDias: convenio.prazoPagamentoDias,
    })
    .from(convenio)
    .where(eq(convenio.ativo, true))
    .orderBy(asc(convenio.nome))
}

/** Tabela negociada de um convênio. */
export async function tabelaDoConvenio(convenioId: string) {
  return db
    .select({
      id: precoConvenio.id,
      procedimentoId: procedimento.id,
      procedimentoNome: procedimento.nome,
      codigo: procedimento.codigo,
      codigoTuss: procedimento.codigoTuss,
      valorParticular: procedimento.valorParticular,
      valor: precoConvenio.valor,
      coberturaPct: precoConvenio.coberturaPct,
      carenciaDias: precoConvenio.carenciaDias,
      vigenciaInicio: precoConvenio.vigenciaInicio,
      vigenciaFim: precoConvenio.vigenciaFim,
    })
    .from(precoConvenio)
    .innerJoin(procedimento, eq(procedimento.id, precoConvenio.procedimentoId))
    .where(eq(precoConvenio.convenioId, convenioId))
    .orderBy(asc(procedimento.nome), desc(precoConvenio.vigenciaInicio))
}

/** Quantos procedimentos ainda estão sem código TUSS — a dívida da Fase 13. */
export async function procedimentosSemTuss(): Promise<{ semTuss: number; total: number }> {
  const [linha] = await db
    .select({
      semTuss: sql<number>`count(*) filter (where ${procedimento.codigoTuss} is null)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(procedimento)
    .where(eq(procedimento.ativo, true))

  return { semTuss: linha?.semTuss ?? 0, total: linha?.total ?? 0 }
}
