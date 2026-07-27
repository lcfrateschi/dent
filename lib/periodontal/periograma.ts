import { registrar } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { periograma, periogramaDente, periogramaSitio } from '@/lib/db/schema'
import {
  type ComparacaoPeriograma,
  type SitioMedido,
  type SitioPeriograma,
  aceitaPeriograma,
  compararPeriogramas,
  ehMultirradicular,
  exigirSitioValido,
} from '@/lib/domain/periograma'
import { erro } from '@/lib/domain/erros'
import { and, desc, eq } from 'drizzle-orm'

/**
 * Registro e leitura do periograma. **Núcleo, sem `'use server'`.**
 *
 * Não há `acoes.ts` nesta fase porque não há tela — as funções abaixo são chamadas
 * pela demonstração (`npm run periograma:demo`). Quando a tela existir, ela ganha um
 * `acoes.ts` fino que autoriza e delega, como nas outras áreas.
 *
 * ── Por que a gravação é em LOTE ────────────────────────────────────────────
 * Um periograma completo são 192 sítios. Uma chamada por sítio seriam 192 idas ao
 * servidor para um exame — e é assim que um módulo clínico deixa de ser usado. Aqui
 * o exame nasce primeiro e os sítios entram em lote, um `INSERT` múltiplo por
 * sextante, numa transação.
 *
 * O que isto **não** resolve: a ergonomia da digitação. Na prática o dentista dita e
 * a auxiliar digita, e isso pede grade navegável por teclado. Está fora desta fase.
 */

export interface MedidaParaGravar {
  readonly denteFdi: number
  readonly sitio: SitioPeriograma
  readonly profundidadeMm: number
  readonly recessaoMm?: number
  readonly sangramento?: boolean
  readonly supuracao?: boolean
}

export interface AchadoDoDente {
  readonly denteFdi: number
  readonly mobilidade?: number | null
  readonly furca?: number | null
  readonly observacao?: string | null
}

/** Abre um exame. Nasce em andamento — a boca é examinada por sextante. */
export async function abrirPeriogramaComAtor(
  ator: Ator,
  entrada: { readonly pacienteId: string; readonly observacao?: string },
): Promise<{ readonly id: string }> {
  if (!ator.profissionalId) {
    erro('SEM_PROFISSIONAL', 'Exame periodontal é ato clínico: exige profissional com CRO.')
  }

  const [linha] = await db
    .insert(periograma)
    .values({
      pacienteId: entrada.pacienteId,
      profissionalId: ator.profissionalId,
      observacao: entrada.observacao ?? null,
    })
    .returning({ id: periograma.id })

  await registrar({
    ator,
    acao: 'criacao',
    entidade: 'periograma',
    entidadeId: linha!.id,
    pacienteId: entrada.pacienteId,
  })

  return { id: linha!.id }
}

/**
 * Grava os dentes examinados e as medidas de sítio, em lote.
 *
 * A validação de domínio roda **antes** do banco, por dois motivos: a mensagem é
 * melhor (o CHECK diz "violates check constraint", o domínio diz qual dente e por
 * quê) e um lote de 192 medidas não deve morrer no servidor por causa da primeira.
 * As travas do banco continuam lá — elas são a garantia, isto é a cortesia.
 */
export async function registrarMedidasComAtor(
  ator: Ator,
  periogramaId: string,
  dentes: readonly AchadoDoDente[],
  medidas: readonly MedidaParaGravar[],
): Promise<{ readonly dentes: number; readonly sitios: number }> {
  for (const d of dentes) {
    if (!aceitaPeriograma(d.denteFdi)) {
      erro(
        'DENTE_NAO_ACEITO',
        `O periograma cobre só dentição permanente; ${d.denteFdi} é decíduo.`,
        { denteFdi: d.denteFdi },
      )
    }
    if (d.furca !== null && d.furca !== undefined && !ehMultirradicular(d.denteFdi)) {
      erro(
        'FURCA_EM_RAIZ_UNICA',
        `O dente ${d.denteFdi} tem raiz única e não tem furca.`,
        { denteFdi: d.denteFdi },
      )
    }
  }
  for (const m of medidas) {
    exigirSitioValido(m.denteFdi, m.sitio)
  }

  return await db.transaction(async (tx) => {
    if (dentes.length > 0) {
      await tx.insert(periogramaDente).values(
        dentes.map((d) => ({
          periogramaId,
          denteFdi: d.denteFdi,
          mobilidade: d.mobilidade ?? null,
          furca: d.furca ?? null,
          observacao: d.observacao ?? null,
        })),
      )
    }
    if (medidas.length > 0) {
      await tx.insert(periogramaSitio).values(
        medidas.map((m) => ({
          periogramaId,
          denteFdi: m.denteFdi,
          sitio: m.sitio,
          profundidadeSondagemMm: m.profundidadeMm,
          recessaoMm: m.recessaoMm ?? 0,
          sangramento: m.sangramento ?? false,
          supuracao: m.supuracao ?? false,
        })),
      )
    }
    return { dentes: dentes.length, sitios: medidas.length }
  })
}

export async function concluirPeriogramaComAtor(ator: Ator, periogramaId: string): Promise<void> {
  await db
    .update(periograma)
    .set({ concluidoEm: new Date() })
    .where(eq(periograma.id, periogramaId))

  await registrar({ ator, acao: 'atualizacao', entidade: 'periograma', entidadeId: periogramaId })
}

/**
 * Os sítios de um exame, no formato que o domínio compara.
 *
 * **Leitura de prontuário é evento auditável** (decisão 6 do CLAUDE.md): dado de
 * saúde é sensível na LGPD, e ler conta. Por isso esta função exige `Ator` —
 * consulta de periograma não é leitura anônima.
 */
export async function sitiosDoPeriogramaComAtor(
  ator: Ator,
  periogramaId: string,
): Promise<readonly SitioMedido[]> {
  const linhas = await db
    .select({
      denteFdi: periogramaSitio.denteFdi,
      sitio: periogramaSitio.sitio,
      profundidadeMm: periogramaSitio.profundidadeSondagemMm,
      recessaoMm: periogramaSitio.recessaoMm,
      sangramento: periogramaSitio.sangramento,
      supuracao: periogramaSitio.supuracao,
    })
    .from(periogramaSitio)
    .where(eq(periogramaSitio.periogramaId, periogramaId))

  await registrar({ ator, acao: 'leitura', entidade: 'periograma', entidadeId: periogramaId })

  return linhas
}

/**
 * Compara os dois exames mais recentes do paciente.
 *
 * A comparação em si é pura (`lib/domain/periograma.ts`) e **emparelhada**: só
 * entram os sítios presentes nos dois exames. Dente extraído no intervalo aparece
 * como perda dentária, não como melhora — ver o comentário de `compararPeriogramas`.
 */
export async function compararUltimosDoisComAtor(
  ator: Ator,
  pacienteId: string,
): Promise<ComparacaoPeriograma | null> {
  const exames = await db
    .select({ id: periograma.id })
    .from(periograma)
    .where(eq(periograma.pacienteId, pacienteId))
    .orderBy(desc(periograma.examinadoEm))
    .limit(2)

  if (exames.length < 2) return null

  // `exames[1]` é o mais antigo — a ordenação é decrescente.
  const antes = await sitiosDoPeriogramaComAtor(ator, exames[1]!.id)
  const depois = await sitiosDoPeriogramaComAtor(ator, exames[0]!.id)
  return compararPeriogramas(antes, depois)
}

/** Achados por dente de um exame — mobilidade e furca. */
export async function dentesDoPeriograma(
  periogramaId: string,
): Promise<readonly { denteFdi: number; mobilidade: number | null; furca: number | null }[]> {
  return await db
    .select({
      denteFdi: periogramaDente.denteFdi,
      mobilidade: periogramaDente.mobilidade,
      furca: periogramaDente.furca,
    })
    .from(periogramaDente)
    .where(and(eq(periogramaDente.periogramaId, periogramaId)))
}
