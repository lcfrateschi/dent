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
  /**
   * Lembretes de WhatsApp e respostas dos pacientes (Fase 9).
   *
   * Não é recurso clínico: por decisão de projeto a mensagem não carrega
   * procedimento nem diagnóstico, só nome, profissional, data e hora — a tela do
   * celular do paciente é lida por outras pessoas. Ver lib/domain/textoMensagem.ts.
   */
  | 'mensageria'
  | 'orcamento'
  | 'cobranca'
  | 'pagamento'
  | 'convenio'
  | 'documento'
  /**
   * Estoque de materiais (Fase 14).
   *
   * Não é recurso clínico nem financeiro, e por isso tem entrada própria: quem
   * repõe luva e anestésico é a recepção, quem confere nota e custo é o
   * financeiro, e quem dá baixa no que usou é o dentista — três perfis, três
   * ações diferentes sobre a mesma tabela.
   */
  | 'estoque'
  /**
   * Filas de relacionamento ativo (Fase 18): orçamento sem resposta, retorno
   * programado, falta sem remarcar, inadimplência, aprovado e não executado.
   *
   * **Recurso próprio, e não "agenda" nem "mensageria".** Quem trabalha a fila é a
   * recepção, e ela precisa ver que um paciente tem parcela vencida — mas
   * `relatorio_financeiro` continua fechado para ela: a fila diz "há parcela
   * vencida", não quanto a clínica faturou. E o dentista não trabalha fila, então
   * `agenda` (que ele tem) não podia carregar isto de carona.
   *
   * A fila **não** é recurso clínico: por construção ela não carrega procedimento
   * nem diagnóstico — o tipo do retorno fica na tabela e não na tela do paciente,
   * pela mesma decisão que rege `mensageria`.
   */
  | 'relacionamento'
  /**
   * Dinheiro que SAI da clínica (Fase 20): despesa, conta a pagar, fluxo de caixa,
   * conciliação do Pix.
   *
   * **Recurso próprio, e não `pagamento`.** Aquele é o dinheiro do PACIENTE — a
   * recepção o tem, porque recebe na boca do caixa. Se despesa entrasse ali de
   * carona, quem cadastra paciente passaria a poder pagar o aluguel e estornar a
   * conta do laboratório. São confianças diferentes sobre contas bancárias
   * diferentes.
   *
   * Também não é `relatorio_financeiro`: aquele é leitura agregada, e aqui se
   * escreve.
   */
  | 'despesa'
  /**
   * Ordem de serviço de prótese: a peça sai, o laboratório trabalha, a peça volta.
   *
   * Recurso próprio e não `plano_tratamento`, por um motivo operacional que só aparece
   * ao usar: com `plano_tratamento` a **recepção tem apenas `ler`** — e é ela quem liga
   * para o laboratório e registra que a peça chegou. Módulo que a pessoa que o opera não
   * pode editar não é módulo, é relatório.
   *
   * O que ela NÃO ganha com isso: `criar` a ordem (é decisão clínica — que peça, que
   * dente, que material) e `excluir` (refação é ordem nova apontando para a anterior,
   * com motivo, porque "quem paga" precisa das duas linhas).
   */
  | 'laboratorio'
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
    laboratorio: ['ler', 'criar', 'editar'],
    agenda: ['ler', 'criar', 'editar'],
    // Vê se o paciente confirmou; não é quem opera a fila de mensagens.
    mensageria: ['ler'],
    orcamento: ['ler', 'criar', 'editar'],
    // Vê o que foi cobrado do seu paciente, mas não mexe em dinheiro.
    cobranca: ['ler'],
    documento: ['ler', 'criar', 'editar', 'exportar'],
    relatorio_clinico: ['ler', 'exportar'],
    convenio: ['ler'],
    // Dá baixa do que usou no paciente. Não compra e não ajusta contagem —
    // 'criar' é o movimento de consumo; 'editar' seria mexer no inventário.
    estoque: ['ler', 'criar'],
    // Vê a fila do próprio paciente; trabalhar a fila é da recepção.
    relacionamento: ['ler'],
  },

  // ── Recepção: agenda e cadastro. Nada de evolução clínica ────────────────
  recepcao: {
    paciente: ['ler', 'criar', 'editar'],
    // Aplica o questionário, mas o que já foi respondido não é dela para editar.
    anamnese: ['criar'],
    // Precisa VER alergia e anticoagulante — é segurança do paciente na cadeira.
    alerta_clinico: ['ler'],
    agenda: ['ler', 'criar', 'editar', 'excluir'],
    // Dona do canal: envia lembrete, resolve o que a máquina não entendeu.
    mensageria: ['ler', 'criar', 'editar'],
    orcamento: ['ler', 'criar'],
    cobranca: ['ler', 'criar'],
    pagamento: ['ler', 'criar'],
    documento: ['ler', 'criar'],
    convenio: ['ler'],
    // Vê o plano para agendar a sessão certa, sem poder alterá-lo.
    plano_tratamento: ['ler'],
    // A recepção EDITA: é ela quem recebe a peça e registra a volta.
    laboratorio: ['ler', 'editar'],
    // Recebe o pedido do fornecedor, lança a entrada, faz a contagem mensal.
    estoque: ['ler', 'criar', 'editar'],
    // É quem liga. `editar` cobre assumir, registrar contato, resolver e dispensar.
    relacionamento: ['ler', 'editar'],
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
    // Dono do dinheiro que sai: lança, paga, estorna, cancela e exporta para a
    // contabilidade. `excluir` são o cancelamento da despesa e o estorno do
    // pagamento — as duas operações que desfazem, e as duas exigem motivo escrito.
    despesa: ['ler', 'criar', 'editar', 'excluir', 'exportar'],
    agenda: ['ler'],
    // Confere custo e nota fiscal, e exporta o inventário para a contabilidade.
    estoque: ['ler', 'exportar'],
    // Inadimplência é fila dele também: cobra e registra o contato.
    relacionamento: ['ler', 'editar', 'exportar'],
  },

  // ── Admin: configura o sistema. NÃO é superusuário clínico ───────────────
  admin: {
    /**
     * ── Duas ausências deliberadas, escritas porque parecem esquecimento ──────
     *
     * **`plano_tratamento` e `laboratorio` não estão aqui.** O admin não lê o plano de
     * tratamento — é decisão de RBAC do projeto, e a ordem de laboratório é derivada
     * dele: ela nomeia o paciente, o dente e a peça. Conceder `laboratorio` ao admin
     * seria deixar entrar pela porta de serviço o dado clínico que a porta da frente
     * recusa.
     *
     * A consequência é real e assumida: o admin **não vê** o menu de Laboratório. Quem
     * opera aquele módulo é o dentista (que decide a peça) e a recepção (que recebe).
     *
     * E o **financeiro** também não tem `laboratorio`, pelo mesmo motivo em espelho:
     * ele confere a nota do laboratório contra a **despesa** (que ele tem), não contra a
     * ordem clínica. `ordem_laboratorio.despesa_id` liga as duas sem expor dente nem
     * paciente — "financeiro não lê dado clínico" é regra do projeto desde a Fase 3.
     */
    usuario: '*',
    configuracao: '*',
    convenio: '*',
    // Só o admin lê a trilha de auditoria — e não pode alterá-la (o banco impede).
    auditoria: ['ler', 'exportar'],
    paciente: ['ler', 'criar', 'editar', 'excluir'],
    agenda: ['ler', 'editar'],
    // Lê para diagnosticar integração; não confirma consulta por ninguém.
    mensageria: ['ler'],
    relatorio_clinico: ['ler'],
    relatorio_financeiro: ['ler', 'exportar'],
    // Cadastra material e ficha técnica. Não dá baixa: quem consome é quem sabe.
    estoque: ['ler', 'criar', 'editar', 'excluir', 'exportar'],
    // `criar`/`excluir` são as REGRAS de retorno (quantos meses por procedimento).
    relacionamento: ['ler', 'criar', 'editar', 'excluir', 'exportar'],
    /**
     * Configura o módulo — categoria de despesa e regra recorrente — e lê tudo.
     *
     * **Sem `excluir`, de propósito:** cancelar despesa e estornar pagamento são
     * operações sobre dinheiro que já se moveu, e quem responde por elas é o
     * financeiro. Admin que pudesse estornar seria admin capaz de sumir com uma
     * saída de caixa sem ninguém do financeiro saber.
     */
    despesa: ['ler', 'criar', 'editar', 'exportar'],
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
  laboratorio: 'Ordens de laboratório',
  agenda: 'Agenda',
  mensageria: 'WhatsApp',
  orcamento: 'Orçamentos',
  cobranca: 'Cobranças',
  pagamento: 'Pagamentos',
  convenio: 'Convênios',
  estoque: 'Estoque',
  relacionamento: 'Relacionamento',
  despesa: 'Despesas e caixa',
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
