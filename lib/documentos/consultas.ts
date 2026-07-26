import { registrarLeitura } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { dente, documento, paciente, usuario } from '@/lib/db/schema'
import { FORMATOS, type FormatoArquivo } from '@/lib/domain/arquivo'
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

/**
 * Leituras de documentos.
 *
 * **Documento removido não sai daqui.** As consultas filtram `removido_em is
 * null` por padrão, e isso é regra de LGPD, não de estética: o caso mais comum de
 * remoção é anexo enviado no paciente errado, e uma radiografia do paciente A
 * continuar visível na ficha do B é vazamento entre titulares. A linha permanece
 * no banco pela guarda de 20 anos — visível apenas na trilha de remoção.
 */

export interface DocumentoResumo {
  readonly id: string
  readonly tipo: string
  readonly nome: string
  readonly descricao: string | null
  readonly denteFdi: number | null
  readonly etapa: 'inicial' | 'durante' | 'final' | null
  readonly mimeType: string
  readonly tamanhoBytes: number
  readonly dataExame: Date | null
  readonly criadoEm: Date
  readonly criadoPorNome: string | null
  readonly evolucaoId: string | null
  /** `false` para HEIC e DICOM: precisa baixar para ver. */
  readonly exibivelNoNavegador: boolean
}

/** Formato conhecido a partir do mime gravado, para decidir se exibe embutido. */
export function formatoDoMime(mime: string): FormatoArquivo | null {
  const limpo = mime.toLowerCase().split(';')[0]!.trim()
  for (const f of Object.values(FORMATOS)) {
    if (f.mime === limpo) return f.formato
  }
  return null
}

function exibivel(mime: string): boolean {
  const f = formatoDoMime(mime)
  return f !== null && FORMATOS[f].exibivelNoNavegador
}

/**
 * Documentos de um paciente.
 *
 * Registra a leitura na trilha: anexo de prontuário é dado de saúde, e a
 * pergunta que a clínica precisa responder é "quem olhou a radiografia deste
 * paciente?".
 */
export async function documentosDoPaciente(
  ator: Ator,
  pacienteId: string,
  filtro: { readonly tipo?: string; readonly denteFdi?: number } = {},
): Promise<readonly DocumentoResumo[]> {
  const condicoes = [eq(documento.pacienteId, pacienteId), isNull(documento.removidoEm)]
  if (filtro.tipo) condicoes.push(eq(documento.tipo, filtro.tipo as 'radiografia'))
  if (filtro.denteFdi !== undefined) condicoes.push(eq(documento.denteFdi, filtro.denteFdi))

  const linhas = await db
    .select({
      id: documento.id,
      tipo: documento.tipo,
      nome: documento.nome,
      descricao: documento.descricao,
      denteFdi: documento.denteFdi,
      etapa: documento.etapa,
      mimeType: documento.mimeType,
      tamanhoBytes: documento.tamanhoBytes,
      dataExame: documento.dataExame,
      criadoEm: documento.criadoEm,
      criadoPorNome: usuario.nome,
      evolucaoId: documento.evolucaoId,
    })
    .from(documento)
    .leftJoin(usuario, eq(usuario.id, documento.criadoPorId))
    .where(and(...condicoes))
    // Data do exame primeiro: é a ordem clínica. Quem enviou depois uma
    // radiografia de dois anos atrás não deve aparecer como a mais recente.
    .orderBy(desc(sql`coalesce(${documento.dataExame}, ${documento.criadoEm})`))

  await registrarLeitura(ator, 'documento', pacienteId, {
    quantidade: linhas.length,
    filtro,
  })

  return linhas.map((l) => ({ ...l, exibivelNoNavegador: exibivel(l.mimeType) }))
}

/**
 * Um documento, para download.
 *
 * Devolve `null` também para o removido — a rota trata os dois casos como 404.
 * Distinguir "não existe" de "foi removido" para quem pede diria a um estranho
 * que aquele documento existiu.
 */
export async function documentoParaDownload(id: string) {
  const [linha] = await db
    .select({
      id: documento.id,
      pacienteId: documento.pacienteId,
      nome: documento.nome,
      storageKey: documento.storageKey,
      mimeType: documento.mimeType,
      tamanhoBytes: documento.tamanhoBytes,
      sha256: documento.sha256,
      tipo: documento.tipo,
      removidoEm: documento.removidoEm,
    })
    .from(documento)
    .where(and(eq(documento.id, id), isNull(documento.removidoEm)))

  return linha ?? null
}

/**
 * Pares antes/depois por dente.
 *
 * A comparação que o dentista mostra ao paciente é "este dente, antes e depois".
 * Por isso o agrupamento é por dente e não por data: duas fotos do mesmo dia
 * podem ser as duas pontas de uma restauração.
 */
export async function comparacoesPorDente(pacienteId: string) {
  const linhas = await db
    .select({
      id: documento.id,
      denteFdi: documento.denteFdi,
      denteNome: dente.nome,
      etapa: documento.etapa,
      nome: documento.nome,
      mimeType: documento.mimeType,
      dataExame: documento.dataExame,
      criadoEm: documento.criadoEm,
    })
    .from(documento)
    .innerJoin(dente, eq(dente.fdi, documento.denteFdi))
    .where(
      and(
        eq(documento.pacienteId, pacienteId),
        isNull(documento.removidoEm),
        isNotNull(documento.denteFdi),
        isNotNull(documento.etapa),
      ),
    )
    .orderBy(asc(documento.denteFdi), asc(sql`coalesce(${documento.dataExame}, ${documento.criadoEm})`))

  const porDente = new Map<
    number,
    { denteFdi: number; denteNome: string; inicial: typeof linhas[number] | null; final: typeof linhas[number] | null }
  >()

  for (const l of linhas) {
    const fdi = l.denteFdi!
    const atual =
      porDente.get(fdi) ?? { denteFdi: fdi, denteNome: l.denteNome, inicial: null, final: null }
    // A primeira 'inicial' e a última 'final' — é o par que mostra a diferença.
    if (l.etapa === 'inicial' && !atual.inicial) atual.inicial = l
    if (l.etapa === 'final') atual.final = l
    porDente.set(fdi, atual)
  }

  // Só interessa dente que tem os dois lados; um lado sozinho não é comparação.
  return [...porDente.values()].filter((d) => d.inicial && d.final)
}

/** Documentos removidos, com motivo e autor. Só para quem lê auditoria. */
export async function documentosRemovidos(pacienteId: string) {
  return db
    .select({
      id: documento.id,
      nome: documento.nome,
      tipo: documento.tipo,
      removidoEm: documento.removidoEm,
      motivoRemocao: documento.motivoRemocao,
      removidoPorNome: usuario.nome,
    })
    .from(documento)
    .leftJoin(usuario, eq(usuario.id, documento.removidoPorId))
    .where(and(eq(documento.pacienteId, pacienteId), isNotNull(documento.removidoEm)))
    .orderBy(desc(documento.removidoEm))
}

/** Contagem por tipo, para a aba da ficha do paciente. */
export async function contagemDeDocumentos(pacienteId: string): Promise<number> {
  const [linha] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documento)
    .where(and(eq(documento.pacienteId, pacienteId), isNull(documento.removidoEm)))
  return linha?.n ?? 0
}

/** Nome do paciente, para o cabeçalho da tela de documentos. */
export async function nomeDoPaciente(pacienteId: string): Promise<string | null> {
  const [p] = await db
    .select({ nome: paciente.nome, nomeSocial: paciente.nomeSocial })
    .from(paciente)
    .where(eq(paciente.id, pacienteId))
  return p ? (p.nomeSocial ?? p.nome) : null
}
