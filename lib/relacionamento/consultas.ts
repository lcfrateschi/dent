import { db } from '@/lib/db'
import {
  agendamento,
  contatoRelacionamento,
  itemPlano,
  orcamento,
  paciente,
  parcela,
  procedimento,
  tarefaRelacionamento,
  usuario,
} from '@/lib/db/schema'
import {
  ROTULO_DO_TIPO,
  type SituacaoTarefa,
  type TipoTarefa,
  type UrgenciaDaTarefa,
  urgenciaDaTarefa,
} from '@/lib/domain/relacionamento'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'

/**
 * Leituras das filas de relacionamento.
 *
 * A tela que importa é **uma fila trabalhável**, não um relatório: quem tem de ser
 * chamado, por quê, há quanto tempo, quem já tentou e o que aconteceu. Uma lista de
 * pacientes sem essas quatro colunas produz duas ligações para a mesma pessoa e
 * nenhuma para a próxima.
 *
 * ── Nenhuma função aqui aceita `clinicaId` ─────────────────────────────────
 * Mesma regra de `lib/portal/consultas.ts` com `pacienteId`: o tenant vem da RLS,
 * não de parâmetro. Não há o que o chamador erre.
 */

export interface LinhaDaFila {
  readonly id: string
  readonly tipo: TipoTarefa
  readonly rotulo: string
  readonly situacao: SituacaoTarefa
  readonly prazo: string
  readonly urgencia: UrgenciaDaTarefa
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly telefone: string | null
  readonly telefoneWhatsapp: string | null
  /** Quantas vezes já se tentou. Vem de `count(*)` no log, não de contador. */
  readonly tentativas: number
  readonly ultimoContatoEm: Date | null
  readonly responsavelNome: string | null
  /**
   * O contexto em uma linha, para a recepção saber do que está falando **antes**
   * de ligar. Sem isto ela abre o cadastro do paciente em outra aba, todas as
   * vezes.
   */
  readonly detalhe: string
  readonly motivoDispensa: string | null
  /** O paciente pediu para não ser contatado até este dia (inclusive). */
  readonly naoContatarAte: string | null
}

/**
 * `detalhe` por tipo, montado no banco.
 *
 * Um `CASE` no SQL em vez de cinco consultas ou de montagem em TypeScript: a fila
 * é uma tela, e cinco `LEFT JOIN` numa passada custam menos que cinco idas ao
 * banco por linha exibida.
 *
 * Os nomes de coluna são literais e qualificados de propósito — `${tabela.coluna}`
 * num template `sql` renderiza sem a tabela, e aqui há `numero` em `orcamento` e em
 * `parcela`.
 */
const DETALHE = sql<string>`case "tarefa_relacionamento"."tipo"
  when 'orcamento_sem_resposta' then
    'Orçamento nº ' || "orcamento"."numero" || ' · R$ ' || "orcamento"."valor_total"
      || ' · vale até ' || to_char("orcamento"."validade_ate", 'DD/MM/YYYY')
  when 'inadimplencia' then
    'Parcela ' || "parcela"."numero" || ' · R$ ' || "parcela"."valor"
      || ' · venceu em ' || to_char("parcela"."vencimento", 'DD/MM/YYYY')
  when 'aprovado_nao_executado' then
    coalesce("procedimento"."nome", 'Procedimento') || ' · aprovado e não executado'
  when 'falta_sem_remarcar' then
    'Faltou em ' || to_char("agendamento"."inicio" at time zone 'UTC', 'DD/MM/YYYY')
  when 'retorno_programado' then
    'Retorno programado'
  else ''
end`

const TENTATIVAS = sql<number>`(
  select count(*)::int from contato_relacionamento c
   where c.tarefa_id = "tarefa_relacionamento"."id"
)`

const ULTIMO_CONTATO = sql<Date | null>`(
  select max(c.criado_em) from contato_relacionamento c
   where c.tarefa_id = "tarefa_relacionamento"."id"
)`

/**
 * A fila.
 *
 * Ordem: **atrasada primeiro, depois por prazo**. Não por tipo e não por data de
 * criação — quem trabalha a fila precisa que o topo dela seja o que está mais
 * atrasado, não o que chegou primeiro.
 */
export async function filaDeRelacionamento(
  opcoes: {
    readonly situacoes?: readonly SituacaoTarefa[]
    readonly tipos?: readonly TipoTarefa[]
    readonly limite?: number
  } = {},
): Promise<readonly LinhaDaFila[]> {
  const hoje = await hojeDaClinica()
  const situacoes = opcoes.situacoes ?? (['aberta', 'em_andamento'] as const)

  const condicoes = [inArray(tarefaRelacionamento.situacao, [...situacoes])]
  if (opcoes.tipos && opcoes.tipos.length > 0) {
    condicoes.push(inArray(tarefaRelacionamento.tipo, [...opcoes.tipos]))
  }

  const linhas = await db
    .select({
      id: tarefaRelacionamento.id,
      tipo: tarefaRelacionamento.tipo,
      situacao: tarefaRelacionamento.situacao,
      prazo: tarefaRelacionamento.prazo,
      pacienteId: paciente.id,
      pacienteNome: sql<string>`coalesce(nullif(btrim("paciente"."nome_social"), ''), "paciente"."nome")`,
      telefone: paciente.telefone,
      telefoneWhatsapp: paciente.telefoneWhatsapp,
      naoContatarAte: paciente.naoContatarAte,
      motivoDispensa: tarefaRelacionamento.motivoDispensa,
      responsavelNome: usuario.nome,
      detalhe: DETALHE,
      tentativas: TENTATIVAS,
      ultimoContatoEm: ULTIMO_CONTATO,
    })
    .from(tarefaRelacionamento)
    .innerJoin(paciente, eq(paciente.id, tarefaRelacionamento.pacienteId))
    .leftJoin(usuario, eq(usuario.id, tarefaRelacionamento.responsavelId))
    .leftJoin(orcamento, eq(orcamento.id, tarefaRelacionamento.orcamentoId))
    .leftJoin(parcela, eq(parcela.id, tarefaRelacionamento.parcelaId))
    .leftJoin(agendamento, eq(agendamento.id, tarefaRelacionamento.agendamentoId))
    .leftJoin(itemPlano, eq(itemPlano.id, tarefaRelacionamento.itemPlanoId))
    .leftJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
    .where(and(...condicoes))
    .orderBy(asc(tarefaRelacionamento.prazo), asc(tarefaRelacionamento.criadoEm))
    .limit(opcoes.limite ?? 200)

  return linhas.map((l) => ({
    ...l,
    rotulo: ROTULO_DO_TIPO[l.tipo],
    urgencia: urgenciaDaTarefa(l.prazo, hoje),
    detalhe: l.detalhe ?? '',
  }))
}

export interface ResumoDaFila {
  readonly tipo: TipoTarefa
  readonly rotulo: string
  readonly abertas: number
  readonly atrasadas: number
}

/**
 * Quantas por tipo, e quantas já passaram do prazo.
 *
 * Serve ao topo da tela e ao painel. `atrasadas` é o número que muda
 * comportamento: "12 na fila" é informação, "5 atrasadas" é trabalho.
 */
export async function resumoDaFila(): Promise<readonly ResumoDaFila[]> {
  const linhas = await db
    .select({
      tipo: tarefaRelacionamento.tipo,
      abertas: count(),
      atrasadas: sql<number>`count(*) filter (
        where "tarefa_relacionamento"."prazo" < hoje_na_clinica()
      )::int`,
    })
    .from(tarefaRelacionamento)
    .where(inArray(tarefaRelacionamento.situacao, ['aberta', 'em_andamento']))
    .groupBy(tarefaRelacionamento.tipo)

  return linhas.map((l) => ({
    tipo: l.tipo,
    rotulo: ROTULO_DO_TIPO[l.tipo],
    abertas: Number(l.abertas),
    atrasadas: Number(l.atrasadas),
  }))
}

export interface ContatoRegistrado {
  readonly id: string
  readonly canal: string
  readonly resultado: string
  readonly observacao: string | null
  readonly porNome: string | null
  readonly criadoEm: Date
}

/** O histórico de tentativas de uma tarefa, do mais recente para o mais antigo. */
export async function contatosDaTarefa(tarefaId: string): Promise<readonly ContatoRegistrado[]> {
  return await db
    .select({
      id: contatoRelacionamento.id,
      canal: contatoRelacionamento.canal,
      resultado: contatoRelacionamento.resultado,
      observacao: contatoRelacionamento.observacao,
      porNome: usuario.nome,
      criadoEm: contatoRelacionamento.criadoEm,
    })
    .from(contatoRelacionamento)
    .leftJoin(usuario, eq(usuario.id, contatoRelacionamento.registradoPorId))
    .where(eq(contatoRelacionamento.tarefaId, tarefaId))
    .orderBy(desc(contatoRelacionamento.criadoEm))
}
