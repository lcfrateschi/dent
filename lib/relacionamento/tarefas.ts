import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { contatoRelacionamento, paciente, tarefaRelacionamento } from '@/lib/db/schema'
import {
  type ResultadoContato,
  contatoEncerra,
  contatoResolve,
  exigirMotivoDeDispensa,
  podeTransitar,
} from '@/lib/domain/relacionamento'
import { ErroDominio } from '@/lib/domain/erros'
import type { Transacao } from '@/lib/tenant/executar'
import { eq, sql } from 'drizzle-orm'

/**
 * Trabalhar a fila: assumir, registrar contato, resolver, dispensar.
 * **Núcleo, sem `'use server'`.**
 *
 * ── A regra mora no domínio ────────────────────────────────────────────────
 * Nenhuma transição é decidida aqui: `podeTransitar` decide, e este arquivo
 * persiste. Foi assim porque a regra que importa — *tarefa dispensada não reabre* —
 * é a mesma que o gerador precisa respeitar, e ter duas cópias dela (uma na ação,
 * uma no gerador) é como as duas divergem.
 *
 * ── Por que `FOR UPDATE` em toda mutação ───────────────────────────────────
 * Duas pessoas na recepção olhando a mesma fila é o caso normal, não a exceção.
 * Sem o lock, as duas leem `aberta`, as duas passam por `podeTransitar`, e a
 * segunda sobrescreve a decisão da primeira — dispensada por uma, resolvida pela
 * outra, e o motivo da dispensa fica pendurado numa tarefa "resolvida". Mesmo
 * padrão de `lib/estoque/baixaDaExecucao.ts`.
 */

export type ResultadoTarefa =
  | { readonly ok: true; readonly mensagem: string }
  | { readonly ok: false; readonly mensagem: string }

export interface ContatoRegistrado {
  readonly tarefaId: string
  readonly canal: 'telefone' | 'whatsapp' | 'email' | 'presencial'
  readonly resultado: ResultadoContato
  readonly observacao?: string
}

interface TarefaTravada {
  readonly id: string
  readonly situacao: 'aberta' | 'em_andamento' | 'resolvida' | 'dispensada'
  readonly pacienteId: string
  readonly tipo: string
}

/**
 * Trava a linha e entrega a TRANSAÇÃO ao callback.
 *
 * ── Por que o `tx` é passado adiante, e não só o `atual` ───────────────────
 * A primeira versão passava apenas a linha lida e as escritas usavam `db`. Isso
 * **travou o processo**: `db` pega OUTRA conexão do pool, que fica esperando o lock
 * `FOR UPDATE` que a transação de fora segura — e a transação só libera depois que o
 * callback retorna. Auto-deadlock, sem erro, sem log: o `psql` mostrava um backend
 * `idle in transaction` e outro em `wait_event_type = Lock`, para sempre.
 *
 * É o tipo de bug que não aparece em revisão de código (as duas linhas parecem
 * corretas isoladamente) e não aparece em teste rápido (o timeout é infinito, não
 * uma falha). Aparece como "a tela não responde".
 */
async function comTarefaTravada<T>(
  tarefaId: string,
  fn: (atual: TarefaTravada, tx: Transacao) => Promise<T>,
): Promise<T | { ok: false; mensagem: string }> {
  return await db.transaction(async (tx) => {
    const [atual] = await tx
      .select({
        id: tarefaRelacionamento.id,
        situacao: tarefaRelacionamento.situacao,
        pacienteId: tarefaRelacionamento.pacienteId,
        tipo: tarefaRelacionamento.tipo,
      })
      .from(tarefaRelacionamento)
      .where(eq(tarefaRelacionamento.id, tarefaId))
      .for('update')
      .limit(1)

    if (!atual) return { ok: false as const, mensagem: 'Tarefa não encontrada.' }
    return await fn(atual, tx)
  })
}

/** Assume a tarefa. Idempotente: assumir o que já é seu não é erro. */
export async function assumirTarefaComAtor(ator: Ator, tarefaId: string): Promise<ResultadoTarefa> {
  const r = await comTarefaTravada(tarefaId, async (atual, tx) => {
    const t = podeTransitar(atual.situacao, 'em_andamento')
    if (!t.ok) return { ok: false as const, mensagem: t.motivo }

    await tx
      .update(tarefaRelacionamento)
      .set({
        situacao: 'em_andamento',
        responsavelId: ator.usuarioId,
        atualizadoEm: sql`now()`,
      })
      .where(eq(tarefaRelacionamento.id, tarefaId))

    return { ok: true as const, mensagem: 'Tarefa assumida.' }
  })
  return r as ResultadoTarefa
}

/**
 * Registra uma tentativa de contato — e deixa o RESULTADO decidir o resto.
 *
 * ── Por que o resultado move a tarefa sozinho ──────────────────────────────
 * A alternativa era a recepção registrar o contato e depois clicar em "resolver"
 * ou "dispensar". Dois cliques para uma informação, e o segundo é o que se esquece:
 * a fila encheria de tarefas em andamento cujo último contato diz "paciente não
 * quer". O resultado já contém a decisão — `remarcou` resolve, `nao_quer` e
 * `numero_errado` dispensam — e o domínio é quem sabe disso
 * (`contatoResolve` / `contatoEncerra`).
 *
 * `nao_atendeu` e `falou` deixam a tarefa em andamento de propósito: ainda há o
 * que fazer.
 */
export async function registrarContatoComAtor(
  ator: Ator,
  entrada: ContatoRegistrado,
): Promise<ResultadoTarefa> {
  const r = await comTarefaTravada(entrada.tarefaId, async (atual, tx) => {
    /**
     * Contato é aceito em QUALQUER situação, inclusive resolvida e dispensada.
     *
     * Registrar que se falou com alguém é fato, não transição — e recusar o
     * registro faria a recepção anotar em papel. O que a situação fechada impede é
     * a tarefa REABRIR, e isso continua valendo: as transições abaixo passam por
     * `podeTransitar`.
     */
    await tx.insert(contatoRelacionamento).values({
      tarefaId: entrada.tarefaId,
      canal: entrada.canal,
      resultado: entrada.resultado,
      observacao: entrada.observacao?.trim() || null,
      registradoPorId: ator.usuarioId,
    })

    let mensagem = 'Contato registrado.'

    if (contatoResolve(entrada.resultado)) {
      const t = podeTransitar(atual.situacao, 'resolvida')
      if (t.ok) {
        await tx
          .update(tarefaRelacionamento)
          .set({ situacao: 'resolvida', resolvidoEm: sql`now()`, atualizadoEm: sql`now()` })
          .where(eq(tarefaRelacionamento.id, entrada.tarefaId))
        mensagem = 'Contato registrado e tarefa resolvida — o paciente voltou à agenda.'
      }
    } else if (contatoEncerra(entrada.resultado)) {
      const motivo =
        entrada.resultado === 'nao_quer'
          ? 'Paciente pediu para não ser contatado.'
          : 'Telefone não pertence ao paciente.'
      const t = podeTransitar(atual.situacao, 'dispensada')
      if (t.ok) {
        await tx
          .update(tarefaRelacionamento)
          .set({
            situacao: 'dispensada',
            motivoDispensa: motivo,
            dispensadoEm: sql`now()`,
            atualizadoEm: sql`now()`,
          })
          .where(eq(tarefaRelacionamento.id, entrada.tarefaId))
        mensagem = `Contato registrado e tarefa dispensada: ${motivo}`
      }
    } else if (atual.situacao === 'aberta') {
      await tx
        .update(tarefaRelacionamento)
        .set({
          situacao: 'em_andamento',
          responsavelId: ator.usuarioId,
          atualizadoEm: sql`now()`,
        })
        .where(eq(tarefaRelacionamento.id, entrada.tarefaId))
    }

    return { ok: true as const, mensagem }
  })

  if ((r as ResultadoTarefa).ok) {
    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'tarefa_relacionamento',
      entidadeId: entrada.tarefaId,
      detalhes: { canal: entrada.canal, resultado: entrada.resultado },
    })
  }
  return r as ResultadoTarefa
}

/** Resolve à mão — para quem marcou o horário sem passar pelo registro de contato. */
export async function resolverTarefaComAtor(
  ator: Ator,
  tarefaId: string,
): Promise<ResultadoTarefa> {
  const r = await comTarefaTravada(tarefaId, async (atual, tx) => {
    const t = podeTransitar(atual.situacao, 'resolvida')
    if (!t.ok) return { ok: false as const, mensagem: t.motivo }

    await tx
      .update(tarefaRelacionamento)
      .set({ situacao: 'resolvida', resolvidoEm: sql`now()`, atualizadoEm: sql`now()` })
      .where(eq(tarefaRelacionamento.id, tarefaId))
    return { ok: true as const, mensagem: 'Tarefa resolvida.' }
  })
  return r as ResultadoTarefa
}

/**
 * Dispensa a tarefa — com motivo, e opcionalmente marcando o opt-out do paciente.
 *
 * ── Por que dispensar pode mexer no PACIENTE, e não só na tarefa ───────────
 * "Não insista" quase nunca é sobre este orçamento: é sobre ligar. Dispensar só a
 * tarefa deixa as outras quatro filas livres para chamar a mesma pessoa amanhã, por
 * outro motivo — e o paciente não distingue as nossas filas, ele conta ligações.
 *
 * Por isso `naoContatarAte` é parâmetro daqui: uma dispensa pode ser "este assunto,
 * não" (sem data) ou "não me ligue até março" (com data), e a segunda vale para
 * todas as filas de uma vez, porque os cinco geradores filtram por ela.
 */
export async function dispensarTarefaComAtor(
  ator: Ator,
  entrada: {
    readonly tarefaId: string
    readonly motivo: string
    /** Dia civil, inclusive. Quando presente, silencia TODAS as filas até lá. */
    readonly naoContatarAte?: string
    readonly naoContatarMotivo?: string
  },
): Promise<ResultadoTarefa> {
  let motivo: string
  try {
    motivo = exigirMotivoDeDispensa(entrada.motivo)
  } catch (e) {
    return { ok: false, mensagem: e instanceof ErroDominio ? e.message : 'Motivo inválido.' }
  }

  const r = await comTarefaTravada(entrada.tarefaId, async (atual, tx) => {
    const t = podeTransitar(atual.situacao, 'dispensada')
    if (!t.ok) return { ok: false as const, mensagem: t.motivo }

    await tx
      .update(tarefaRelacionamento)
      .set({
        situacao: 'dispensada',
        motivoDispensa: motivo,
        dispensadoEm: sql`now()`,
        atualizadoEm: sql`now()`,
      })
      .where(eq(tarefaRelacionamento.id, entrada.tarefaId))

    if (entrada.naoContatarAte) {
      await tx
        .update(paciente)
        .set({
          naoContatarAte: entrada.naoContatarAte,
          naoContatarMotivo: entrada.naoContatarMotivo?.trim() || motivo,
          atualizadoEm: sql`now()`,
        })
        .where(eq(paciente.id, atual.pacienteId))
    }

    return {
      ok: true as const,
      mensagem: entrada.naoContatarAte
        ? `Tarefa dispensada. O paciente não será contatado por nenhuma fila até ${entrada.naoContatarAte}.`
        : 'Tarefa dispensada.',
    }
  })

  if ((r as ResultadoTarefa).ok) {
    await registrar({
      ator,
      acao: 'atualizacao',
      entidade: 'tarefa_relacionamento',
      entidadeId: entrada.tarefaId,
      detalhes: { dispensada: true, naoContatarAte: entrada.naoContatarAte ?? null },
    })
  }
  return r as ResultadoTarefa
}
