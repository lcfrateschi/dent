import { registrar, registrarLeitura } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import {
  agendamento,
  anamnese,
  documento,
  evolucao,
  execucao,
  itemPlano,
  planoTratamento,
  procedimento,
  profissional,
  usuario,
} from '@/lib/db/schema'
import type { Face } from '@/lib/domain/dentes'
import { descreverFaces } from '@/lib/domain/faces'
import { assinaturaConfere, ordenarCadeia } from '@/lib/domain/prontuario'
import { and, asc, desc, eq, isNull, notInArray, or } from 'drizzle-orm'

/**
 * Leitura do prontuário.
 *
 * **O prontuário não é uma tabela** — é a visão agregada de anamnese, evoluções,
 * execuções, faltas e documentos (ver GLOSSARIO.md). Este arquivo é o único
 * lugar que monta essa visão, e todo acesso é auditado: dado de saúde é dado
 * sensível na LGPD, e a pergunta que a clínica precisa responder é "quem OLHOU
 * este prontuário?".
 */

export interface EvolucaoNoProntuario {
  readonly id: string
  readonly texto: string
  readonly profissionalId: string
  readonly profissionalNome: string
  readonly cro: string
  readonly ufCro: string
  readonly assinadoEm: Date | null
  readonly criadoEm: Date
  readonly retificaId: string | null
  readonly motivoRetificacao: string | null
  readonly agendamentoId: string | null
  /**
   * `true` quando o hash confere com o conteúdo. `false` numa evolução assinada
   * indica **adulteração feita fora da aplicação** — a tela precisa mostrar isso,
   * não esconder.
   */
  readonly assinaturaValida: boolean
  /** Preenchido quando existe uma retificação apontando para esta. */
  readonly retificadaPorId: string | null
}

export async function evolucoesDoPaciente(
  pacienteId: string,
): Promise<readonly EvolucaoNoProntuario[]> {
  const linhas = await db
    .select({
      id: evolucao.id,
      pacienteId: evolucao.pacienteId,
      texto: evolucao.texto,
      profissionalId: evolucao.profissionalId,
      profissionalNome: usuario.nome,
      cro: profissional.cro,
      ufCro: profissional.ufCro,
      assinadoEm: evolucao.assinadoEm,
      assinaturaHash: evolucao.assinaturaHash,
      criadoEm: evolucao.criadoEm,
      retificaId: evolucao.retificaId,
      motivoRetificacao: evolucao.motivoRetificacao,
      agendamentoId: evolucao.agendamentoId,
    })
    .from(evolucao)
    .innerJoin(profissional, eq(profissional.id, evolucao.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(eq(evolucao.pacienteId, pacienteId))
    .orderBy(asc(evolucao.criadoEm))

  // Quem retifica quem — para marcar a original como retificada na tela.
  const retificadaPor = new Map<string, string>()
  for (const l of linhas) {
    if (l.retificaId) retificadaPor.set(l.retificaId, l.id)
  }

  // `ordenarCadeia` (puro, testado) põe a original antes da correção, mesmo
  // quando a correção foi escrita meses depois.
  const ordenadas = ordenarCadeia(
    linhas.map((l) => ({
      id: l.id,
      pacienteId: l.pacienteId,
      profissionalId: l.profissionalId,
      texto: l.texto,
      assinadoEm: l.assinadoEm,
      retificaId: l.retificaId,
      criadoEm: l.criadoEm,
    })),
  )
  const posicao = new Map(ordenadas.map((e, i) => [e.id, i]))

  return linhas
    .map((l) => ({
      id: l.id,
      texto: l.texto,
      profissionalId: l.profissionalId,
      profissionalNome: l.profissionalNome,
      cro: l.cro,
      ufCro: l.ufCro,
      assinadoEm: l.assinadoEm,
      criadoEm: l.criadoEm,
      retificaId: l.retificaId,
      motivoRetificacao: l.motivoRetificacao,
      agendamentoId: l.agendamentoId,
      assinaturaValida:
        l.assinadoEm === null
          ? true // rascunho não tem assinatura para conferir
          : assinaturaConfere({
              id: l.id,
              pacienteId: l.pacienteId,
              profissionalId: l.profissionalId,
              texto: l.texto,
              assinadoEm: l.assinadoEm,
              retificaId: l.retificaId,
              criadoEm: l.criadoEm,
              assinaturaHash: l.assinaturaHash,
            }),
      retificadaPorId: retificadaPor.get(l.id) ?? null,
    }))
    .sort((a, b) => (posicao.get(a.id) ?? 0) - (posicao.get(b.id) ?? 0))
}

/** Rascunho aberto do profissional para este paciente, se houver. */
export async function rascunhoAberto(
  pacienteId: string,
  profissionalId: string,
): Promise<{ id: string; texto: string; criadoEm: Date } | null> {
  const [linha] = await db
    .select({ id: evolucao.id, texto: evolucao.texto, criadoEm: evolucao.criadoEm })
    .from(evolucao)
    .where(
      and(
        eq(evolucao.pacienteId, pacienteId),
        eq(evolucao.profissionalId, profissionalId),
        isNull(evolucao.assinadoEm),
      ),
    )
    .limit(1)
  return linha ?? null
}

// ── Linha do tempo ───────────────────────────────────────────────────────────

export type EventoProntuario =
  | {
      readonly tipo: 'anamnese'
      readonly quando: Date
      readonly id: string
      readonly versao: number
      readonly profissionalNome: string | null
    }
  | {
      readonly tipo: 'evolucao'
      readonly quando: Date
      readonly evolucao: EvolucaoNoProntuario
    }
  | {
      readonly tipo: 'execucao'
      readonly quando: Date
      readonly id: string
      readonly procedimentoNome: string
      readonly alvo: string
      readonly profissionalNome: string
    }
  | {
      readonly tipo: 'falta'
      readonly quando: Date
      readonly id: string
      readonly profissionalNome: string
    }
  | {
      readonly tipo: 'documento'
      readonly quando: Date
      readonly id: string
      readonly nomeArquivo: string
      readonly tipoDocumento: string
    }

export interface Prontuario {
  readonly eventos: readonly EventoProntuario[]
  readonly evolucoes: readonly EvolucaoNoProntuario[]
  readonly totalAssinadas: number
  readonly totalRascunhos: number
  /** Quantas assinaturas não conferem — deveria ser sempre zero. */
  readonly assinaturasInvalidas: number
}

/**
 * Monta o prontuário completo, em ordem cronológica.
 *
 * Inclui **faltas** de propósito: um paciente que não comparece a três sessões
 * de endodontia é informação clínica, não só administrativa. Aparecer na linha
 * do tempo evita que o dentista conclua "o tratamento parou sem motivo".
 */
export async function montarProntuario(ator: Ator, pacienteId: string): Promise<Prontuario> {
  const [evolucoes, anamneses, execucoes, faltas, documentos] = await Promise.all([
    evolucoesDoPaciente(pacienteId),

    db
      .select({
        id: anamnese.id,
        versao: anamnese.versao,
        preenchidaEm: anamnese.preenchidaEm,
        profissionalNome: usuario.nome,
      })
      .from(anamnese)
      .leftJoin(profissional, eq(profissional.id, anamnese.profissionalId))
      .leftJoin(usuario, eq(usuario.id, profissional.usuarioId))
      .where(eq(anamnese.pacienteId, pacienteId))
      .orderBy(asc(anamnese.versao)),

    db
      .select({
        id: execucao.id,
        executadoEm: execucao.executadoEm,
        procedimentoNome: procedimento.nome,
        denteFdi: itemPlano.denteFdi,
        faces: itemPlano.faces,
        profissionalNome: usuario.nome,
      })
      .from(execucao)
      .innerJoin(itemPlano, eq(itemPlano.id, execucao.itemPlanoId))
      .innerJoin(planoTratamento, eq(planoTratamento.id, itemPlano.planoId))
      .innerJoin(procedimento, eq(procedimento.id, itemPlano.procedimentoId))
      .innerJoin(profissional, eq(profissional.id, execucao.profissionalId))
      .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
      .where(eq(planoTratamento.pacienteId, pacienteId))
      .orderBy(asc(execucao.executadoEm)),

    db
      .select({
        id: agendamento.id,
        inicio: agendamento.inicio,
        profissionalNome: usuario.nome,
      })
      .from(agendamento)
      .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
      .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
      .where(and(eq(agendamento.pacienteId, pacienteId), eq(agendamento.status, 'faltou')))
      .orderBy(asc(agendamento.inicio)),

    db
      .select({
        id: documento.id,
        criadoEm: documento.criadoEm,
        dataExame: documento.dataExame,
        nome: documento.nome,
        tipo: documento.tipo,
      })
      .from(documento)
      .where(and(eq(documento.pacienteId, pacienteId), isNull(documento.removidoEm)))
      .orderBy(asc(documento.criadoEm)),
  ])

  const eventos: EventoProntuario[] = [
    ...anamneses.map(
      (a): EventoProntuario => ({
        tipo: 'anamnese',
        quando: a.preenchidaEm,
        id: a.id,
        versao: a.versao,
        profissionalNome: a.profissionalNome,
      }),
    ),
    ...evolucoes.map(
      (e): EventoProntuario => ({
        tipo: 'evolucao',
        // Ordena pela assinatura quando existe: é a data que vale no prontuário.
        quando: e.assinadoEm ?? e.criadoEm,
        evolucao: e,
      }),
    ),
    ...execucoes.map(
      (x): EventoProntuario => ({
        tipo: 'execucao',
        quando: x.executadoEm,
        id: x.id,
        procedimentoNome: x.procedimentoNome,
        alvo:
          x.denteFdi !== null
            ? descreverFaces(x.denteFdi, (x.faces ?? []) as readonly Face[])
            : 'Procedimento geral',
        profissionalNome: x.profissionalNome,
      }),
    ),
    ...faltas.map(
      (f): EventoProntuario => ({
        tipo: 'falta',
        quando: f.inicio,
        id: f.id,
        profissionalNome: f.profissionalNome,
      }),
    ),
    ...documentos.map(
      (d): EventoProntuario => ({
        tipo: 'documento',
        // Data do exame quando houver: a radiografia vale pela data em que foi
        // feita, não pela do upload.
        quando: d.dataExame ?? d.criadoEm,
        id: d.id,
        nomeArquivo: d.nome,
        tipoDocumento: d.tipo,
      }),
    ),
  ].sort((a, b) => a.quando.getTime() - b.quando.getTime())

  const assinaturasInvalidas = evolucoes.filter((e) => !e.assinaturaValida).length

  await registrarLeitura(ator, 'prontuario', pacienteId, {
    eventos: eventos.length,
    evolucoes: evolucoes.length,
    // Se aparecer diferente de zero na trilha, alguém mexeu no banco por fora.
    assinaturasInvalidas,
  })

  return {
    eventos,
    evolucoes,
    totalAssinadas: evolucoes.filter((e) => e.assinadoEm !== null).length,
    totalRascunhos: evolucoes.filter((e) => e.assinadoEm === null).length,
    assinaturasInvalidas,
  }
}

/**
 * Registra a EXPORTAÇÃO do prontuário.
 *
 * É a ação mais sensível do sistema: entrega o histórico clínico completo em
 * papel. O paciente tem direito a pedir (LGPD e CFO), mas cada entrega precisa
 * ficar registrada com o motivo — é isso que diferencia atender a um pedido
 * legítimo de vazar prontuário.
 */
export async function registrarExportacao(
  ator: Ator,
  pacienteId: string,
  motivo: string,
): Promise<void> {
  await registrar({
    ator,
    acao: 'exportacao',
    entidade: 'prontuario',
    entidadeId: pacienteId,
    pacienteId,
    detalhes: { motivo: motivo.trim() || 'não informado' },
  })
}

/** Últimos atendimentos concluídos sem evolução — o que falta registrar. */
export async function atendimentosSemEvolucao(
  pacienteId: string,
): Promise<readonly { id: string; inicio: Date; profissionalNome: string }[]> {
  const comEvolucao = await db
    .select({ agendamentoId: evolucao.agendamentoId })
    .from(evolucao)
    .where(eq(evolucao.pacienteId, pacienteId))

  const ids = comEvolucao.map((e) => e.agendamentoId).filter((v): v is string => v !== null)

  return db
    .select({
      id: agendamento.id,
      inicio: agendamento.inicio,
      profissionalNome: usuario.nome,
    })
    .from(agendamento)
    .innerJoin(profissional, eq(profissional.id, agendamento.profissionalId))
    .innerJoin(usuario, eq(usuario.id, profissional.usuarioId))
    .where(
      and(
        eq(agendamento.pacienteId, pacienteId),
        or(eq(agendamento.status, 'concluido'), eq(agendamento.status, 'em_atendimento')),
        ids.length > 0 ? notInArray(agendamento.id, ids) : undefined,
      ),
    )
    .orderBy(desc(agendamento.inicio))
    .limit(5)
}
