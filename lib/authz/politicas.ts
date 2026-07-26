/**
 * RBAC. **Fonte única de verdade das permissões.**
 *
 * A regra mais importante deste arquivo é sobre o arquivo: permissão espalhada
 * em 40 telas é como se vaza prontuário. Toda decisão de acesso passa por aqui,
 * e a matriz abaixo é auditável de uma olhada — inclusive por quem não programa.
 *
 * As três separações que a clínica pediu:
 *   - recepção NÃO lê evolução clínica nem anamnese
 *   - financeiro NÃO lê dado clínico
 *   - dentista NÃO altera cobrança nem pagamento
 */

export type Perfil = 'dentista' | 'recepcao' | 'financeiro' | 'admin'

export type Recurso =
  | 'paciente'
  | 'anamnese'
  | 'alerta_clinico'
  | 'prontuario' // evoluções — o dado mais sensível
  | 'odontograma'
  | 'plano_tratamento'
  | 'agenda'
  | 'orcamento'
  | 'cobranca'
  | 'pagamento'
  | 'convenio'
  | 'documento'
  | 'relatorio_clinico'
  | 'relatorio_financeiro'
  | 'usuario'
  | 'configuracao'
  | 'auditoria'

export type Acao = 'ler' | 'criar' | 'editar' | 'excluir' | 'assinar' | 'exportar'

export const ACOES: readonly Acao[] = ['ler', 'criar', 'editar', 'excluir', 'assinar', 'exportar']

/** `'*'` = todas as ações. Recurso ausente para um perfil = nenhum acesso. */
type Concessao = readonly Acao[] | '*'

type Matriz = Readonly<Record<Perfil, Partial<Record<Recurso, Concessao>>>>

/**
 * A matriz. Ler de cima para baixo responde "o que este perfil pode fazer?";
 * ler uma coluna responde "quem toca neste recurso?".
 */
const MATRIZ: Matriz = {
  // ── Dentista: dono do dado clínico, sem acesso ao caixa ───────────────────
  dentista: {
    paciente: ['ler', 'criar', 'editar'],
    anamnese: ['ler', 'criar', 'editar'],
    alerta_clinico: ['ler', 'criar', 'editar', 'excluir'],
    prontuario: ['ler', 'criar', 'assinar', 'exportar'],
    odontograma: ['ler', 'criar', 'editar'],
    plano_tratamento: ['ler', 'criar', 'editar', 'excluir'],
    agenda: ['ler', 'criar', 'editar'],
    orcamento: ['ler', 'criar', 'editar'],
    // Vê o que foi cobrado do seu paciente, mas não mexe em dinheiro.
    cobranca: ['ler'],
    documento: ['ler', 'criar', 'editar', 'exportar'],
    relatorio_clinico: ['ler', 'exportar'],
    convenio: ['ler'],
  },

  // ── Recepção: agenda e cadastro. Nada de evolução clínica ────────────────
  recepcao: {
    paciente: ['ler', 'criar', 'editar'],
    // Aplica o questionário, mas o que já foi respondido não é dela para editar.
    anamnese: ['criar'],
    // Precisa VER alergia e anticoagulante — é segurança do paciente na cadeira.
    alerta_clinico: ['ler'],
    agenda: ['ler', 'criar', 'editar', 'excluir'],
    orcamento: ['ler', 'criar'],
    cobranca: ['ler', 'criar'],
    pagamento: ['ler', 'criar'],
    documento: ['ler', 'criar'],
    convenio: ['ler'],
    // Vê o plano para agendar a sessão certa, sem poder alterá-lo.
    plano_tratamento: ['ler'],
  },

  // ── Financeiro: dinheiro. Zero dado clínico ──────────────────────────────
  financeiro: {
    // Só o cadastro — quem é o paciente, para emitir cobrança e nota.
    paciente: ['ler'],
    orcamento: ['ler', 'criar', 'editar'],
    cobranca: ['ler', 'criar', 'editar', 'excluir'],
    pagamento: ['ler', 'criar', 'editar', 'excluir'],
    convenio: ['ler', 'criar', 'editar'],
    relatorio_financeiro: ['ler', 'exportar'],
    agenda: ['ler'],
  },

  // ── Admin: configura o sistema. NÃO é superusuário clínico ───────────────
  admin: {
    usuario: '*',
    configuracao: '*',
    convenio: '*',
    // Só o admin lê a trilha de auditoria — e não pode alterá-la (o banco impede).
    auditoria: ['ler', 'exportar'],
    paciente: ['ler', 'criar', 'editar', 'excluir'],
    agenda: ['ler', 'editar'],
    relatorio_clinico: ['ler'],
    relatorio_financeiro: ['ler', 'exportar'],
  },
}

/**
 * Recursos que contêm dado clínico do paciente.
 *
 * Quem tem acesso a qualquer um deles precisa aparecer na trilha de auditoria
 * até em LEITURA — dado de saúde é dado sensível na LGPD.
 */
export const RECURSOS_CLINICOS: readonly Recurso[] = [
  'anamnese',
  'alerta_clinico',
  'prontuario',
  'odontograma',
  'plano_tratamento',
  'relatorio_clinico',
]

export function ehRecursoClinico(recurso: Recurso): boolean {
  return RECURSOS_CLINICOS.includes(recurso)
}

/** A pergunta central. Recurso não listado para o perfil = negado. */
export function pode(perfil: Perfil, recurso: Recurso, acao: Acao): boolean {
  const concessao = MATRIZ[perfil][recurso]
  if (concessao === undefined) return false
  if (concessao === '*') return true
  return concessao.includes(acao)
}

/** Ações permitidas de um perfil sobre um recurso — usado para montar menus. */
export function acoesPermitidas(perfil: Perfil, recurso: Recurso): readonly Acao[] {
  const concessao = MATRIZ[perfil][recurso]
  if (concessao === undefined) return []
  if (concessao === '*') return ACOES
  return concessao
}

/** Se o perfil enxerga o recurso de alguma forma — decide se o item de menu aparece. */
export function podeVer(perfil: Perfil, recurso: Recurso): boolean {
  return acoesPermitidas(perfil, recurso).length > 0
}

export const ROTULO_PERFIL: Readonly<Record<Perfil, string>> = {
  dentista: 'Dentista',
  recepcao: 'Recepção',
  financeiro: 'Financeiro',
  admin: 'Administrador',
}

export const ROTULO_RECURSO: Readonly<Record<Recurso, string>> = {
  paciente: 'Pacientes',
  anamnese: 'Anamnese',
  alerta_clinico: 'Alertas clínicos',
  prontuario: 'Prontuário',
  odontograma: 'Odontograma',
  plano_tratamento: 'Planos de tratamento',
  agenda: 'Agenda',
  orcamento: 'Orçamentos',
  cobranca: 'Cobranças',
  pagamento: 'Pagamentos',
  convenio: 'Convênios',
  documento: 'Documentos',
  relatorio_clinico: 'Relatórios clínicos',
  relatorio_financeiro: 'Relatórios financeiros',
  usuario: 'Usuários',
  configuracao: 'Configurações',
  auditoria: 'Auditoria',
}

/** Exporta a matriz só para leitura — a tela de permissões a renderiza. */
export function matrizCompleta(): Readonly<
  Record<Perfil, Partial<Record<Recurso, readonly Acao[]>>>
> {
  const saida: Record<string, Partial<Record<Recurso, readonly Acao[]>>> = {}
  for (const perfil of Object.keys(MATRIZ) as Perfil[]) {
    const doPerfil: Partial<Record<Recurso, readonly Acao[]>> = {}
    for (const recurso of Object.keys(MATRIZ[perfil]) as Recurso[]) {
      doPerfil[recurso] = acoesPermitidas(perfil, recurso)
    }
    saida[perfil] = doPerfil
  }
  return saida as Readonly<Record<Perfil, Partial<Record<Recurso, readonly Acao[]>>>>
}
