import { registrar, registrarLeitura } from '@/lib/auditoria/registrar'
import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { alertaClinico, paciente } from '@/lib/db/schema'
import { apenasDigitos } from '@/lib/domain/cpf'
import { type SQL, and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm'

/**
 * Leitura de paciente.
 *
 * Toda função aqui recebe o `Ator` e registra na trilha de auditoria — inclusive
 * as leituras. Passar o ator como parâmetro obrigatório é intencional: torna
 * impossível consultar paciente "sem querer" fora de um contexto autenticado.
 */

export const POR_PAGINA = 20

export interface FiltroPacientes {
  readonly busca?: string
  readonly status?: 'ativo' | 'inativo' | 'arquivado' | 'todos'
  readonly pagina?: number
}

export interface LinhaPaciente {
  readonly id: string
  readonly nome: string
  readonly nomeSocial: string | null
  readonly cpf: string | null
  readonly dataNascimento: string
  readonly telefone: string | null
  readonly telefoneWhatsapp: string | null
  readonly status: 'ativo' | 'inativo' | 'arquivado'
  readonly criadoEm: Date
}

export interface PaginaPacientes {
  readonly itens: readonly LinhaPaciente[]
  readonly total: number
  readonly pagina: number
  readonly paginas: number
}

export async function listarPacientes(
  ator: Ator,
  filtro: FiltroPacientes = {},
): Promise<PaginaPacientes> {
  const pagina = Math.max(1, filtro.pagina ?? 1)
  const busca = filtro.busca?.trim() ?? ''
  const status = filtro.status ?? 'ativo'

  const condicoes: SQL[] = []

  if (status !== 'todos') {
    condicoes.push(eq(paciente.status, status))
  }

  if (busca) {
    const digitos = apenasDigitos(busca)
    const porTexto = [
      ilike(paciente.nome, `%${busca}%`),
      ilike(paciente.nomeSocial, `%${busca}%`),
    ]
    // Busca por CPF ou telefone só quando a pessoa digitou números — evita
    // varrer colunas numéricas com o nome que ela está procurando.
    if (digitos.length >= 3) {
      porTexto.push(ilike(paciente.cpf, `%${digitos}%`))
      porTexto.push(ilike(paciente.telefone, `%${digitos}%`))
      porTexto.push(ilike(paciente.telefoneWhatsapp, `%${digitos}%`))
    }
    const alternativas = or(...porTexto)
    if (alternativas) condicoes.push(alternativas)
  }

  const onde = condicoes.length > 0 ? and(...condicoes) : undefined

  const [{ total }] = await db
    .select({ total: count() })
    .from(paciente)
    .where(onde)
    .then((r) => (r.length > 0 ? r : [{ total: 0 }]) as [{ total: number }])

  const itens = await db
    .select({
      id: paciente.id,
      nome: paciente.nome,
      nomeSocial: paciente.nomeSocial,
      cpf: paciente.cpf,
      dataNascimento: paciente.dataNascimento,
      telefone: paciente.telefone,
      telefoneWhatsapp: paciente.telefoneWhatsapp,
      status: paciente.status,
      criadoEm: paciente.criadoEm,
    })
    .from(paciente)
    .where(onde)
    .orderBy(asc(sql`lower(${paciente.nome})`))
    .limit(POR_PAGINA)
    .offset((pagina - 1) * POR_PAGINA)

  // Listagem é acesso a dado de paciente: fica na trilha, com o filtro usado.
  await registrar({
    ator,
    acao: 'leitura',
    entidade: 'paciente',
    detalhes: { tipo: 'listagem', busca: busca || undefined, status, pagina, resultados: itens.length },
  })

  return {
    itens,
    total,
    pagina,
    paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
  }
}

export interface PacienteCompleto {
  readonly id: string
  readonly nome: string
  readonly nomeSocial: string | null
  readonly cpf: string | null
  readonly rg: string | null
  readonly dataNascimento: string
  readonly sexo: 'feminino' | 'masculino' | 'outro' | 'nao_informado'
  readonly telefone: string | null
  readonly telefoneWhatsapp: string | null
  readonly email: string | null
  readonly cep: string | null
  readonly logradouro: string | null
  readonly numero: string | null
  readonly complemento: string | null
  readonly bairro: string | null
  readonly cidade: string | null
  readonly uf: string | null
  readonly responsavelLegalId: string | null
  readonly indicadoPor: string | null
  readonly observacoes: string | null
  readonly status: 'ativo' | 'inativo' | 'arquivado'
  readonly criadoEm: Date
  readonly atualizadoEm: Date
}

/** Ficha do paciente. Registra a leitura vinculada ao paciente. */
export async function acharPaciente(ator: Ator, id: string): Promise<PacienteCompleto | null> {
  const [linha] = await db.select().from(paciente).where(eq(paciente.id, id)).limit(1)
  if (!linha) return null

  await registrarLeitura(ator, 'paciente', id)
  return linha as PacienteCompleto
}

/**
 * Versão sem auditoria, para uso interno (montar o nome do responsável, por
 * exemplo). Não expor em tela: leitura de ficha tem que ser auditada.
 */
export async function acharPacienteResumo(
  id: string,
): Promise<{ id: string; nome: string; dataNascimento: string } | null> {
  const [linha] = await db
    .select({ id: paciente.id, nome: paciente.nome, dataNascimento: paciente.dataNascimento })
    .from(paciente)
    .where(eq(paciente.id, id))
    .limit(1)
  return linha ?? null
}

export interface AlertaDoPaciente {
  readonly id: string
  readonly tipo: string
  readonly descricao: string
  readonly severidade: 'informativo' | 'atencao' | 'critico'
}

/**
 * Alertas clínicos ativos. Aparecem no topo de TODA tela do paciente —
 * alergia e uso de anticoagulante precisam estar visíveis antes de qualquer
 * procedimento. A recepção também vê, por segurança do paciente na cadeira.
 */
export async function alertasDoPaciente(pacienteId: string): Promise<readonly AlertaDoPaciente[]> {
  return db
    .select({
      id: alertaClinico.id,
      tipo: alertaClinico.tipo,
      descricao: alertaClinico.descricao,
      severidade: alertaClinico.severidade,
    })
    .from(alertaClinico)
    .where(and(eq(alertaClinico.pacienteId, pacienteId), eq(alertaClinico.ativo, true)))
    .orderBy(desc(alertaClinico.severidade), asc(alertaClinico.criadoEm))
}

/** Candidatos a responsável legal: pacientes maiores de idade, para o seletor. */
export async function buscarResponsaveis(
  termo: string,
  excluirId?: string,
): Promise<readonly { id: string; nome: string; cpf: string | null }[]> {
  const t = termo.trim()
  if (t.length < 3) return []

  const condicoes: SQL[] = [eq(paciente.status, 'ativo'), ilike(paciente.nome, `%${t}%`)]
  if (excluirId) condicoes.push(sql`${paciente.id} <> ${excluirId}`)
  // Maior de 18: quem responde legalmente por outro.
  condicoes.push(sql`${paciente.dataNascimento} <= (current_date - interval '18 years')`)

  return db
    .select({ id: paciente.id, nome: paciente.nome, cpf: paciente.cpf })
    .from(paciente)
    .where(and(...condicoes))
    .orderBy(asc(sql`lower(${paciente.nome})`))
    .limit(10)
}
