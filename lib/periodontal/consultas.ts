import { db } from '@/lib/db'
import {
  autoclave,
  cicloEsterilizacao,
  itemPlano,
  laboratorio,
  ordemLaboratorio,
  paciente,
  periograma,
  planoTratamento,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm'

/**
 * Leituras das telas da Fase 21 — periograma, laboratório, esterilização e
 * propostas alternativas.
 *
 * ── Nenhuma função aqui aceita `clinicaId` ──────────────────────────────────
 * O tenant vem da sessão, e a Row Level Security filtra. É a mesma regra que
 * `lib/portal/consultas.ts` aplica a `pacienteId`: o que não se pode passar não se
 * pode errar. `DA_CLINICA_ATUAL` só aparece em consulta que seleciona `FROM clinica`
 * — em qualquer outra tabela ele geraria `where "clinica"."id" = …` sem `clinica` no
 * FROM, que é o erro 42P01 que a Fase 20 levou.
 *
 * ── Auditoria de leitura NÃO está aqui ──────────────────────────────────────
 * Estas funções montam lista para a tela. O registro de leitura de prontuário mora
 * no núcleo (`sitiosDoPeriogramaComAtor` em `periograma.ts`), que é quem abre o
 * exame de um paciente. Auditar a listagem de exames a cada render encheria o
 * `audit_log` de eventos sem sujeito — e o que a LGPD pede é rastrear quem viu o
 * dado, não quem passou pela página.
 */

// ── Periograma ───────────────────────────────────────────────────────────────

export interface ExameNaLista {
  readonly id: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly profissionalNome: string | null
  readonly examinadoEm: Date
  readonly concluidoEm: Date | null
  readonly sitios: number
}

/** Exames de um paciente, do mais recente para o mais antigo. */
export async function periogramasDoPaciente(pacienteId: string): Promise<readonly ExameNaLista[]> {
  return await db
    .select({
      id: periograma.id,
      pacienteId: periograma.pacienteId,
      pacienteNome: paciente.nome,
      profissionalNome: usuario.nome,
      examinadoEm: periograma.examinadoEm,
      concluidoEm: periograma.concluidoEm,
      // Subconsulta e não join: com join, `count` multiplicaria pelas linhas de
      // dente. Aqui a tabela é nomeada literalmente porque `${tabela.coluna}` num
      // template `sql` renderiza SEM qualificar — em subconsulta isso vira
      // "column reference is ambiguous". Armadilha registrada no CLAUDE.md.
      sitios: sql<number>`(
        select count(*)::int from periograma_sitio s where s.periograma_id = "periograma"."id"
      )`,
    })
    .from(periograma)
    .innerJoin(paciente, eq(paciente.id, periograma.pacienteId))
    .leftJoin(profissional, eq(profissional.id, periograma.profissionalId))
    .leftJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(eq(periograma.pacienteId, pacienteId))
    .orderBy(desc(periograma.examinadoEm))
}

/** O exame em aberto do paciente, se houver — é nele que a grade digita. */
export async function periogramaEmAberto(
  pacienteId: string,
): Promise<{ readonly id: string } | null> {
  const [linha] = await db
    .select({ id: periograma.id })
    .from(periograma)
    .where(and(eq(periograma.pacienteId, pacienteId), isNull(periograma.concluidoEm)))
    .orderBy(desc(periograma.examinadoEm))
    .limit(1)
  return linha ?? null
}

// ── Ordem de laboratório ─────────────────────────────────────────────────────

export interface OrdemNaLista {
  readonly id: string
  readonly numero: number
  readonly laboratorioNome: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly procedimentoNome: string
  readonly denteFdi: number | null
  readonly especificacao: string
  readonly cor: string | null
  readonly situacao: 'aberta' | 'enviada' | 'recebida' | 'cancelada'
  readonly prazoEm: string | null
  readonly enviadaEm: Date | null
  readonly recebidaEm: Date | null
  readonly custo: string
  readonly refazNumero: number | null
  readonly motivoRefacao: string | null
}

/**
 * A fila do laboratório: o que está fora da clínica e o que venceu o prazo.
 *
 * A ordenação responde à pergunta da manhã — "o que devia ter voltado?" — e não
 * "o que é mais novo". Aberta e enviada primeiro, por prazo; recebida e cancelada
 * descem.
 */
export async function ordensDeLaboratorio(
  incluirFechadas = false,
): Promise<readonly OrdemNaLista[]> {
  const anterior = db.$with('anterior').as(
    db
      .select({ id: ordemLaboratorio.id, numero: ordemLaboratorio.numero })
      .from(ordemLaboratorio),
  )

  const linhas = await db
    .with(anterior)
    .select({
      id: ordemLaboratorio.id,
      numero: ordemLaboratorio.numero,
      laboratorioNome: laboratorio.nome,
      pacienteId: paciente.id,
      pacienteNome: paciente.nome,
      procedimentoNome: procedimento.nome,
      denteFdi: itemPlano.denteFdi,
      especificacao: ordemLaboratorio.especificacao,
      cor: ordemLaboratorio.cor,
      situacao: ordemLaboratorio.situacao,
      prazoEm: ordemLaboratorio.prazoEm,
      enviadaEm: ordemLaboratorio.enviadaEm,
      recebidaEm: ordemLaboratorio.recebidaEm,
      custo: ordemLaboratorio.custo,
      refazNumero: anterior.numero,
      motivoRefacao: ordemLaboratorio.motivoRefacao,
    })
    .from(ordemLaboratorio)
    .innerJoin(laboratorio, eq(laboratorio.id, ordemLaboratorio.laboratorioId))
    .innerJoin(itemPlano, eq(itemPlano.id, ordemLaboratorio.itemPlanoId))
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .leftJoin(anterior, eq(anterior.id, ordemLaboratorio.refazId))
    .where(
      incluirFechadas
        ? undefined
        : or(eq(ordemLaboratorio.situacao, 'aberta'), eq(ordemLaboratorio.situacao, 'enviada')),
    )
    .orderBy(
      // Fora da clínica primeiro; dentro dela depois. `nulls last` porque ordem sem
      // prazo combinado não é a mais urgente — é a que ninguém combinou.
      sql`case when ${ordemLaboratorio.situacao} in ('aberta','enviada') then 0 else 1 end`,
      sql`${ordemLaboratorio.prazoEm} asc nulls last`,
      desc(ordemLaboratorio.numero),
    )
  return linhas
}

/** Itens de plano que ainda não têm ordem — é o que a tela oferece para criar. */
export async function itensSemOrdem(): Promise<
  readonly {
    readonly id: string
    readonly rotulo: string
  }[]
> {
  const linhas = await db
    .select({
      id: itemPlano.id,
      pacienteNome: paciente.nome,
      procedimentoNome: procedimento.nome,
      denteFdi: itemPlano.denteFdi,
    })
    .from(itemPlano)
    .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
    .innerJoin(paciente, eq(paciente.id, planoTratamento.pacienteId))
    .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .where(
      and(
        eq(planoTratamento.status, 'ativo'),
        sql`not exists (
          select 1 from ordem_laboratorio o where o.item_plano_id = "item_plano"."id"
                                              and o.situacao <> 'cancelada'
        )`,
      ),
    )
    .orderBy(asc(paciente.nome))
    .limit(200)

  return linhas.map((l) => ({
    id: l.id,
    rotulo: `${l.pacienteNome} — ${l.procedimentoNome}${l.denteFdi ? ` (dente ${l.denteFdi})` : ''}`,
  }))
}

export async function laboratoriosAtivos(): Promise<
  readonly { readonly id: string; readonly nome: string; readonly prazoPadraoDias: number }[]
> {
  return await db
    .select({
      id: laboratorio.id,
      nome: laboratorio.nome,
      prazoPadraoDias: laboratorio.prazoPadraoDias,
    })
    .from(laboratorio)
    .where(eq(laboratorio.ativo, true))
    .orderBy(asc(laboratorio.nome))
}

// ── Esterilização ────────────────────────────────────────────────────────────

export interface CicloNaLista {
  readonly id: string
  readonly numero: number
  readonly dia: string
  readonly autoclaveNome: string
  readonly responsavelNome: string
  readonly iniciadoEm: Date
  readonly programa: string | null
  readonly conteudo: string
  readonly indicadorQuimico: 'aprovado' | 'reprovado'
  readonly biologicoResultado: 'pendente' | 'negativo' | 'positivo'
  readonly biologicoLidoEm: Date | null
  readonly certificado: boolean | null
}

/**
 * Ciclos recentes, **pendentes de biológico primeiro**.
 *
 * A ordem é a razão da tela existir: o indicador biológico sai dias depois, e um
 * ciclo esquecido em `pendente` é um pacote em uso cuja esterilização ninguém
 * confirmou. Pendente no topo transforma isso em trabalho visível.
 */
export async function ciclosDeEsterilizacao(limite = 60): Promise<readonly CicloNaLista[]> {
  return await db
    .select({
      id: cicloEsterilizacao.id,
      numero: cicloEsterilizacao.numero,
      dia: cicloEsterilizacao.dia,
      autoclaveNome: autoclave.nome,
      responsavelNome: usuario.nome,
      iniciadoEm: cicloEsterilizacao.iniciadoEm,
      programa: cicloEsterilizacao.programa,
      conteudo: cicloEsterilizacao.conteudo,
      indicadorQuimico: cicloEsterilizacao.indicadorQuimico,
      biologicoResultado: cicloEsterilizacao.biologicoResultado,
      biologicoLidoEm: cicloEsterilizacao.biologicoLidoEm,
      certificado: cicloEsterilizacao.certificado,
    })
    .from(cicloEsterilizacao)
    .innerJoin(autoclave, eq(autoclave.id, cicloEsterilizacao.autoclaveId))
    .innerJoin(usuario, eq(usuario.id, cicloEsterilizacao.responsavelId))
    .orderBy(
      sql`case when ${cicloEsterilizacao.biologicoResultado} = 'pendente' then 0 else 1 end`,
      desc(cicloEsterilizacao.iniciadoEm),
    )
    .limit(limite)
}

export async function autoclavesAtivas(): Promise<
  readonly { readonly id: string; readonly nome: string }[]
> {
  return await db
    .select({ id: autoclave.id, nome: autoclave.nome })
    .from(autoclave)
    .where(eq(autoclave.ativo, true))
    .orderBy(asc(autoclave.nome))
}

/**
 * O próximo número de carga do dia, para pré-preencher o formulário.
 *
 * O número está na **etiqueta do pacote** e reinicia a cada dia da clínica — é por
 * isso que `ciclo_esterilizacao.dia` é coluna gravada com default
 * `hoje_na_clinica()` e não `iniciado_em::date`: carga das 21h em São Paulo é
 * "amanhã" em UTC.
 *
 * Isto é **sugestão**, não reserva: dois operadores abrindo o formulário ao mesmo
 * tempo veem o mesmo número, e quem grava depois é recusado pelo índice único
 * `ciclo_esterilizacao_carga_uk`. Recusar é o certo — o segundo tem de olhar a
 * etiqueta que acabou de imprimir.
 */
export async function proximaCargaSugerida(autoclaveId: string): Promise<number> {
  const [linha] = await db
    .select({ maximo: sql<number>`coalesce(max(${cicloEsterilizacao.numero}), 0)::int` })
    .from(cicloEsterilizacao)
    .where(
      and(
        eq(cicloEsterilizacao.autoclaveId, autoclaveId),
        sql`${cicloEsterilizacao.dia} = hoje_na_clinica()`,
      ),
    )
  return (linha?.maximo ?? 0) + 1
}

// ── Propostas alternativas ───────────────────────────────────────────────────

export interface PropostaNaTela {
  readonly id: string
  readonly status: 'rascunho' | 'ativo' | 'concluido' | 'cancelado'
  readonly criadoEm: Date
  readonly itens: number
  readonly total: string
  readonly observacao: string | null
}

/**
 * As propostas de um grupo, para o paciente comparar A e B.
 *
 * `total` é a soma dos itens, calculada em SQL — `numeric` somado pelo Postgres, não
 * `float` somado em JS. Dinheiro no TS é `string`, e toda aritmética passa por
 * `lib/domain/dinheiro.ts`; aqui não há aritmética, há apresentação de uma soma que
 * o banco já sabe fazer com exatidão decimal.
 */
export async function propostasDoGrupo(grupoProposta: string): Promise<readonly PropostaNaTela[]> {
  return await db
    .select({
      id: planoTratamento.id,
      status: planoTratamento.status,
      criadoEm: planoTratamento.criadoEm,
      observacao: planoTratamento.observacao,
      itens: sql<number>`(
        select count(*)::int from item_plano i where i.plano_id = "plano_tratamento"."id"
      )`,
      total: sql<string>`(
        select coalesce(sum(i.valor), 0)::text from item_plano i
         where i.plano_id = "plano_tratamento"."id"
      )`,
    })
    .from(planoTratamento)
    .where(eq(planoTratamento.grupoProposta, grupoProposta))
    .orderBy(asc(planoTratamento.criadoEm))
}

/** Grupos de proposta com mais de um plano — os que valem comparar. */
export async function gruposDePropostaDoPaciente(
  pacienteId: string,
): Promise<readonly { readonly grupoProposta: string; readonly planos: number }[]> {
  const linhas = await db
    .select({
      grupoProposta: planoTratamento.grupoProposta,
      planos: sql<number>`count(*)::int`,
    })
    .from(planoTratamento)
    .where(and(eq(planoTratamento.pacienteId, pacienteId), sql`${planoTratamento.grupoProposta} is not null`))
    .groupBy(planoTratamento.grupoProposta)
    .having(sql`count(*) > 1`)

  return linhas.flatMap((l) => (l.grupoProposta ? [{ grupoProposta: l.grupoProposta, planos: l.planos }] : []))
}
