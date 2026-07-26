import { pgEnum } from 'drizzle-orm/pg-core'

// ── Acesso ────────────────────────────────────────────────────────────────────
export const perfilUsuarioEnum = pgEnum('perfil_usuario', [
  'dentista',
  'recepcao',
  'financeiro',
  'admin',
])

// ── Paciente ──────────────────────────────────────────────────────────────────
export const statusPacienteEnum = pgEnum('status_paciente', ['ativo', 'inativo', 'arquivado'])

export const sexoEnum = pgEnum('sexo', ['feminino', 'masculino', 'outro', 'nao_informado'])

// ── LGPD ──────────────────────────────────────────────────────────────────────
export const baseLegalEnum = pgEnum('base_legal', [
  'consentimento',
  'tutela_da_saude',
  'obrigacao_legal',
  'execucao_de_contrato',
])

export const severidadeAlertaEnum = pgEnum('severidade_alerta', ['informativo', 'atencao', 'critico'])

// ── Dentes ────────────────────────────────────────────────────────────────────
export const denticaoEnum = pgEnum('denticao', ['permanente', 'deciduo'])

export const arcadaEnum = pgEnum('arcada', ['superior', 'inferior'])

export const ladoEnum = pgEnum('lado', ['direito', 'esquerdo'])

export const tipoDenteEnum = pgEnum('tipo_dente', [
  'incisivo_central',
  'incisivo_lateral',
  'canino',
  'primeiro_premolar',
  'segundo_premolar',
  'primeiro_molar',
  'segundo_molar',
  'terceiro_molar',
])

/**
 * Estado do dente inteiro, constatado no exame clínico. Sobrepõe o das faces.
 * Não existe 'presente': ausência de linha em `dente_paciente` já significa
 * dente presente e íntegro.
 */
export const estadoDenteEnum = pgEnum('estado_dente', ['ausente', 'coroa', 'implante', 'raiz_residual'])

/**
 * Faces do dente. Quais são válidas depende do tipo e da arcada:
 * anteriores têm `incisal`, posteriores têm `oclusal`;
 * superiores têm `palatina`, inferiores têm `lingual`.
 * A validação vive em lib/domain/faces.ts.
 */
export const faceDenteEnum = pgEnum('face_dente', [
  'mesial',
  'distal',
  'vestibular',
  'lingual',
  'palatina',
  'oclusal',
  'incisal',
  'cervical',
])

// ── Agenda ────────────────────────────────────────────────────────────────────
export const statusAgendamentoEnum = pgEnum('status_agendamento', [
  'agendado',
  'confirmado',
  'em_atendimento',
  'concluido',
  'faltou',
  'cancelado',
])

export const origemAgendamentoEnum = pgEnum('origem_agendamento', [
  'recepcao',
  'telefone',
  'whatsapp',
  'portal',
  'encaixe',
])

export const canalConfirmacaoEnum = pgEnum('canal_confirmacao', [
  'whatsapp',
  'telefone',
  'portal',
  'presencial',
])

// ── Tratamento ────────────────────────────────────────────────────────────────
export const statusPlanoEnum = pgEnum('status_plano', ['rascunho', 'ativo', 'concluido', 'cancelado'])

export const statusItemPlanoEnum = pgEnum('status_item_plano', [
  'proposto',
  'aprovado',
  'recusado',
  'executado',
  'faturado',
  'recebido',
  'glosado',
  'cancelado',
])

export const coberturaEnum = pgEnum('cobertura', ['particular', 'convenio'])

export const statusOrcamentoEnum = pgEnum('status_orcamento', [
  'rascunho',
  'enviado',
  'aprovado',
  'recusado',
  'expirado',
])

// ── Financeiro ────────────────────────────────────────────────────────────────
export const formaPagamentoEnum = pgEnum('forma_pagamento', [
  'dinheiro',
  'pix',
  'debito',
  'credito',
  'boleto',
  'transferencia',
  'convenio',
])

export const statusParcelaEnum = pgEnum('status_parcela', [
  'aberta',
  'parcial',
  'paga',
  'vencida',
  'cancelada',
])

/**
 * Base de cálculo da comissão. A clínica decidiu `valor_recebido` (2026-07-26):
 * comissão sobre o que entrou no caixa, não sobre o que foi executado.
 * `valor_executado` fica no enum porque é a outra prática de mercado e a decisão
 * é por profissional — não é código morto.
 */
export const baseComissaoEnum = pgEnum('base_comissao', ['valor_executado', 'valor_recebido'])

// ── Documentos ────────────────────────────────────────────────────────────────
export const tipoDocumentoEnum = pgEnum('tipo_documento', [
  'atestado',
  'receita',
  'termo_consentimento',
  'orcamento_pdf',
  'radiografia',
  'foto_clinica',
  'exame',
  'documento_pessoal',
  'outro',
])

// ── Mensageria (WhatsApp) ─────────────────────────────────────────────────────
export const tipoMensagemEnum = pgEnum('tipo_mensagem', [
  'lembrete_consulta',
  'confirmacao_recebida',
  'cancelamento_recebido',
  'aviso_geral',
])

/**
 * Ciclo de vida da mensagem de saída.
 *
 * `enviando` é a reivindicação do worker, e **não volta para `pendente`**: se o
 * processo morreu depois de chamar a Meta, ninguém sabe se a mensagem saiu.
 * Reenviar por conta própria arrisca mandar duas vezes, então a linha fica
 * travada e visível para um humano decidir. Ver a trigger de transição em
 * drizzle/0008_mensageria.sql.
 */
export const situacaoMensagemEnum = pgEnum('situacao_mensagem', [
  'pendente',
  'enviando',
  'enviada',
  'entregue',
  'lida',
  'falhou',
  'cancelada',
])

export const provedorMensagemEnum = pgEnum('provedor_mensagem', ['meta', 'simulado'])

/** Espelha o tipo `Interpretacao` de lib/domain/whatsapp.ts. */
export const interpretacaoRespostaEnum = pgEnum('interpretacao_resposta', [
  'confirmou',
  'cancelou',
  'nao_entendido',
])

// ── Documentos ────────────────────────────────────────────────────────────────
/**
 * Momento clínico da imagem, para a comparação antes/depois.
 *
 * Não é o mesmo que a data: duas fotos do mesmo dia podem ser "antes" e "depois"
 * de uma restauração, e um tratamento longo tem várias intermediárias.
 */
export const etapaDocumentoEnum = pgEnum('etapa_documento', ['inicial', 'durante', 'final'])

// ── Auditoria ─────────────────────────────────────────────────────────────────
export const atorTipoEnum = pgEnum('ator_tipo', ['staff', 'paciente', 'sistema'])

export const acaoAuditEnum = pgEnum('acao_audit', [
  'leitura',
  'criacao',
  'atualizacao',
  'exclusao',
  'exportacao',
  'impressao',
  'login',
  'login_falho',
  'logout',
])
