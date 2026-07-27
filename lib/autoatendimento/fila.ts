import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { listaEspera, paciente, procedimento } from '@/lib/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'

/**
 * A lista de espera **do lado da recepção**.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────────────
 * A Fase 19 abriu a porta de entrada da fila (o paciente pede pelo portal, em
 * `lib/portal/`) e não a de saída: os pedidos entravam e ninguém tinha como
 * oferecer um horário a quem estava esperando. Uma fila que só recebe não é fila,
 * é caixa de sugestões.
 *
 * ── Por que NÃO está em `lib/portal/` ──────────────────────────────────────
 * Decisão nº 2 do `CLAUDE.md`: staff e portal não compartilham consulta. As funções
 * de `lib/portal/consultas.ts` filtram por `sessao.pacienteId` e nenhuma aceita
 * `pacienteId` como parâmetro — é a defesa estrutural contra IDOR. Aqui é o
 * oposto por natureza: a recepção **precisa** ver a fila de todos os pacientes da
 * clínica. Misturar os dois lados no mesmo módulo seria criar exatamente a função
 * que, chamada do lugar errado, entrega o vizinho.
 *
 * O que protege aqui é outra coisa: `Ator` com permissão, e a RLS filtrando por
 * clínica.
 *
 * ── Por que o recurso é `relacionamento` e não um novo ─────────────────────
 * A lista de espera é uma fila de contato ativo trabalhada pela recepção — a mesma
 * forma, o mesmo perfil e a mesma natureza não-clínica das filas da Fase 18. O
 * comentário de `Recurso` em `lib/authz/politicas.ts` já argumenta por que `agenda`
 * não podia carregar aquilo de carona (o dentista tem agenda e não trabalha fila),
 * e o argumento vale igual aqui. Criar um `Recurso` novo para a mesma atividade
 * multiplicaria a matriz de permissão sem separar nada que a clínica separe.
 */

export interface LinhaDaEspera {
  readonly id: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly telefone: string | null
  readonly procedimentoNome: string | null
  readonly turno: 'manha' | 'tarde' | 'qualquer'
  readonly observacao: string | null
  readonly validoAte: Date
  readonly criadoEm: Date
  /** `true` quando `valido_ate` já passou: continua na fila e não deveria ser oferecido. */
  readonly vencida: boolean
}

/**
 * A fila que aguarda, mais antiga primeiro.
 *
 * **Ordem por chegada, não por urgência**, e isso é escolha: a lista de espera não
 * tem prioridade clínica (quem tem urgência não entra numa fila, é encaixado no
 * mesmo dia). Ordenar por qualquer outro critério faria a recepção precisar
 * justificar por que ligou para o segundo antes do primeiro.
 *
 * Inclui as **vencidas** em vez de escondê-las: `valido_ate` passado significa "o
 * paciente disse que esperaria até tal dia", e sumir com a linha faria a recepção
 * ligar sem saber que o prazo acabou. A tela marca, a pessoa decide.
 */
export async function filaDeEspera(): Promise<readonly LinhaDaEspera[]> {
  const linhas = await db
    .select({
      id: listaEspera.id,
      pacienteId: listaEspera.pacienteId,
      pacienteNome: paciente.nome,
      telefone: sql<string | null>`coalesce(${paciente.telefoneWhatsapp}, ${paciente.telefone})`,
      procedimentoNome: procedimento.nome,
      turno: listaEspera.turno,
      observacao: listaEspera.observacao,
      validoAte: listaEspera.validoAte,
      criadoEm: listaEspera.criadoEm,
    })
    .from(listaEspera)
    .innerJoin(paciente, eq(paciente.id, listaEspera.pacienteId))
    .leftJoin(procedimento, eq(procedimento.id, listaEspera.procedimentoId))
    .where(eq(listaEspera.situacao, 'aguardando'))
    .orderBy(asc(listaEspera.criadoEm))

  const agora = Date.now()
  return linhas.map((l) => ({ ...l, vencida: l.validoAte.getTime() < agora }))
}

export type ResultadoEspera =
  | { readonly ok: true; readonly mensagem: string }
  | { readonly ok: false; readonly mensagem: string }

/**
 * Encerra um pedido da fila.
 *
 * ── `atendida` × `encerrada`, e por que o motivo é obrigatório numa e não noutra ──
 * `atendida` = a recepção ofereceu um horário e o paciente aceitou. O motivo é
 * evidente (foi atendido) e o CHECK do banco não o exige.
 *
 * `encerrada` = saiu da fila sem ser atendido — desistiu, não respondeu, o prazo
 * venceu. Aqui o motivo é **obrigatório**, e não por burocracia: é a única linha que
 * explica, três meses depois, por que aquele paciente nunca foi chamado. O CHECK
 * `lista_espera_encerramento_com_motivo` da `0031` cobra isso no banco; validar aqui
 * antes é só para a mensagem ser legível em vez de vir do Postgres.
 *
 * ── O que esta função NÃO faz ──────────────────────────────────────────────
 * **Não agenda.** Marcar o horário é a agenda, com a EXCLUDE constraint de
 * não-sobreposição e todas as regras que ela já tem. Duplicar aquilo aqui criaria um
 * segundo caminho para gravar agendamento — e o segundo caminho é sempre o que
 * esquece uma trava. A recepção marca na agenda e depois marca a linha como atendida.
 */
export async function encerrarEsperaComAtor(
  ator: Ator,
  entrada: {
    readonly id: string
    readonly situacao: 'atendida' | 'encerrada'
    readonly motivo?: string
  },
): Promise<ResultadoEspera> {
  if (!/^[0-9a-f-]{36}$/i.test(entrada.id)) {
    return { ok: false, mensagem: 'Pedido inválido.' }
  }

  const motivo = entrada.motivo?.trim() ?? ''
  if (entrada.situacao === 'encerrada' && motivo.length === 0) {
    return {
      ok: false,
      mensagem: 'Diga por que este paciente saiu da fila sem ser atendido — é o que explica depois.',
    }
  }

  const atualizadas = await db
    .update(listaEspera)
    .set({
      situacao: entrada.situacao,
      encerradoEm: sql`now()`,
      motivoEncerramento: motivo.length > 0 ? motivo.slice(0, 300) : null,
    })
    // `situacao = 'aguardando'` no WHERE: sem isso, dois cliques encerram duas vezes
    // e o segundo sobrescreve o motivo do primeiro com outro carimbo de hora.
    .where(and(eq(listaEspera.id, entrada.id), eq(listaEspera.situacao, 'aguardando')))
    .returning({ id: listaEspera.id, pacienteId: listaEspera.pacienteId })

  const linha = atualizadas[0]
  if (!linha) {
    // Casou zero linhas: ou o id não é desta clínica (a RLS filtrou), ou já foi
    // encerrado. As duas dão a mesma resposta de propósito — dizer "não é da sua
    // clínica" confirmaria a existência do id para quem o adivinhou.
    return { ok: false, mensagem: 'Este pedido já foi encerrado ou não está mais na fila.' }
  }

  await registrar({
    ator,
    acao: 'atualizacao',
    entidade: 'lista_espera',
    entidadeId: linha.id,
    pacienteId: linha.pacienteId,
    detalhes: { situacao: entrada.situacao, motivo: motivo.slice(0, 300) || null },
  })

  return {
    ok: true,
    mensagem:
      entrada.situacao === 'atendida'
        ? 'Marcado como atendido. Não esqueça de criar o agendamento na agenda.'
        : 'Pedido encerrado.',
  }
}
