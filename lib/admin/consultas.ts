import { db } from '@/lib/db'
import { cadeira, clinica, profissional, usuario } from '@/lib/db/schema'
import type { Perfil } from '@/lib/authz/politicas'
import type { HorarioFuncionamento } from '@/lib/domain/horario'
import { DA_CLINICA_ATUAL } from '@/lib/tenant/sql'
import { asc, eq, sql } from 'drizzle-orm'

/**
 * Leituras da administração.
 *
 * Nenhuma consulta aqui devolve `mfa_secret` nem `senha_hash`. Não é descuido
 * evitado: é a regra. Uma tela de administração que carrega o segredo TOTP no
 * HTML entrega o segundo fator de todo mundo a quem inspecionar a página — e o
 * `senha_hash` num payload de servidor vira alvo de força bruta offline.
 * O que a tela mostra é **se** o MFA está configurado, não qual é o segredo.
 */

export interface UsuarioNaTela {
  readonly id: string
  readonly nome: string
  readonly email: string
  readonly perfil: Perfil
  readonly ativo: boolean
  readonly mfaAtivo: boolean
  readonly senhaTemporaria: boolean
  readonly ultimoLoginEm: Date | null
  readonly criadoEm: Date
  readonly profissionalId: string | null
  readonly cro: string | null
  readonly ufCro: string | null
  readonly especialidade: string | null
  readonly comissaoPct: string | null
  readonly profissionalAtivo: boolean | null
}

export async function usuarios(): Promise<readonly UsuarioNaTela[]> {
  return db
    .select({
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
      ativo: usuario.ativo,
      mfaAtivo: usuario.mfaAtivo,
      senhaTemporaria: usuario.senhaTemporaria,
      ultimoLoginEm: usuario.ultimoLoginEm,
      criadoEm: usuario.criadoEm,
      profissionalId: profissional.id,
      cro: profissional.cro,
      ufCro: profissional.ufCro,
      especialidade: profissional.especialidade,
      comissaoPct: profissional.comissaoPct,
      profissionalAtivo: profissional.ativo,
    })
    .from(usuario)
    .leftJoin(profissional, eq(profissional.usuarioId, usuario.id))
    .orderBy(sql`${usuario.ativo} desc`, asc(usuario.nome))
}

export async function acharUsuario(id: string): Promise<UsuarioNaTela | null> {
  const todos = await usuarios()
  return todos.find((u) => u.id === id) ?? null
}

export interface ConfiguracaoDaClinica {
  readonly razaoSocial: string
  readonly nomeFantasia: string | null
  readonly cnpj: string | null
  readonly croResponsavel: string | null
  readonly ufCroResponsavel: string | null
  readonly telefone: string | null
  readonly email: string | null
  readonly cep: string | null
  readonly logradouro: string | null
  readonly numero: string | null
  readonly complemento: string | null
  readonly bairro: string | null
  readonly cidade: string | null
  readonly uf: string | null
  readonly baseComissao: string
  readonly fusoHorario: string
  readonly horarioFuncionamento: HorarioFuncionamento
  readonly passoAgendaMinutos: number
  readonly atualizadoEm: Date
}

export async function configuracaoDaClinica(): Promise<ConfiguracaoDaClinica | null> {
  // Décimo-primeiro caso do mesmo problema, que não estava na lista: a TELA DE
  // CONFIGURAÇÃO lia "alguma" clínica. Editar a configuração da clínica errada é
  // pior que ler — e o formulário de salvar já usa a clínica do contexto.
  const [linha] = await db.select().from(clinica).where(DA_CLINICA_ATUAL)
  if (!linha) return null
  return {
    ...linha,
    horarioFuncionamento: linha.horarioFuncionamento as HorarioFuncionamento,
  }
}

export interface CadeiraNaTela {
  readonly id: string
  readonly nome: string
  readonly ordem: number
  readonly ativo: boolean
  readonly agendamentosFuturos: number
}

export async function cadeiras(): Promise<readonly CadeiraNaTela[]> {
  return db
    .select({
      id: cadeira.id,
      nome: cadeira.nome,
      ordem: cadeira.ordem,
      ativo: cadeira.ativo,
      agendamentosFuturos: sql<number>`(
        select count(*)::int from agendamento a
         where a.cadeira_id = ${cadeira.id}
           and a.inicio >= now()
           and a.status not in ('cancelado', 'faltou')
      )`,
    })
    .from(cadeira)
    .orderBy(sql`${cadeira.ativo} desc`, asc(cadeira.ordem), asc(cadeira.nome))
}

/**
 * O que falta configurar para a clínica operar.
 *
 * Aparece como lista no topo da tela de configurações. É a diferença entre um
 * sistema que "está pronto" e um que diz o que falta nele: sem CNPJ o orçamento
 * sai sem cabeçalho fiscal, sem CRO o atestado sai sem assinatura válida, e sem
 * dentista cadastrado ninguém assina evolução.
 */
export interface Pendencia {
  readonly o_que: string
  readonly porque: string
  readonly onde: string
}

export async function pendenciasDeConfiguracao(): Promise<readonly Pendencia[]> {
  const [config, listaUsuarios, listaCadeiras] = await Promise.all([
    configuracaoDaClinica(),
    usuarios(),
    cadeiras(),
  ])

  const p: Pendencia[] = []

  if (!config || config.razaoSocial.includes('(configurar)')) {
    p.push({
      o_que: 'Razão social da clínica',
      porque: 'Sai no cabeçalho do orçamento, do atestado e da receita.',
      onde: '/configuracoes',
    })
  }
  if (!config?.cnpj) {
    p.push({
      o_que: 'CNPJ',
      porque: 'Obrigatório no XML TISS e no cabeçalho fiscal do orçamento.',
      onde: '/configuracoes',
    })
  }
  if (!config?.croResponsavel) {
    p.push({
      o_que: 'CRO do responsável técnico',
      porque: 'Atestado e receita sem CRO não têm valor legal.',
      onde: '/configuracoes',
    })
  }
  if (!config?.telefone) {
    p.push({
      o_que: 'Telefone da clínica',
      porque: 'O paciente que recebe o lembrete precisa de um número para responder.',
      onde: '/configuracoes',
    })
  }

  const dentistas = listaUsuarios.filter((u) => u.perfil === 'dentista' && u.ativo)
  if (dentistas.length === 0) {
    p.push({
      o_que: 'Nenhum dentista cadastrado',
      porque: 'Sem profissional não há como agendar, executar nem assinar evolução.',
      onde: '/usuarios',
    })
  }
  if (dentistas.some((d) => d.comissaoPct === '0.00')) {
    p.push({
      o_que: 'Dentista com comissão 0%',
      porque: 'Se o combinado é comissionado, a apuração vai sair zerada.',
      onde: '/usuarios',
    })
  }

  const soAdminInicial =
    listaUsuarios.filter((u) => u.ativo).length === 1 &&
    listaUsuarios.some((u) => u.ativo && u.email === 'admin@local')
  if (soAdminInicial) {
    p.push({
      o_que: 'Só existe o usuário inicial de desenvolvimento',
      porque: 'admin@local nasceu com senha pública no seed. Crie os usuários reais e desative-o.',
      onde: '/usuarios',
    })
  }

  if (listaCadeiras.filter((c) => c.ativo).length === 0) {
    p.push({
      o_que: 'Nenhuma cadeira ativa',
      porque: 'A agenda precisa de pelo menos uma cadeira para oferecer horário.',
      onde: '/configuracoes',
    })
  }

  return p
}
