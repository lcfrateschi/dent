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

/**
 * Quem respondeu a anamnese (Fase 19).
 *
 * `clinica` — colhida por profissional, já filtrada pelo julgamento de quem sabe
 * repetir a pergunta de outro jeito.
 * `portal` — autodeclarada pelo paciente antes da consulta. **Precisa de conferência
 * antes de valer clinicamente** (`anamnese.conferida_em`).
 */
export const origemAnamneseEnum = pgEnum('origem_anamnese', ['clinica', 'portal'])

/**
 * ⚖️ Nível da assinatura de um consentimento (Fase 19).
 *
 * Só dois valores, e nenhum deles é "qualificada" — porque este sistema não emite
 * assinatura qualificada. Acrescentar o valor sem ICP-Brasil por trás seria gravar no
 * banco uma afirmação jurídica falsa, e é o tipo de coisa que ninguém revisa depois.
 */
export const nivelAssinaturaEnum = pgEnum('nivel_assinatura', [
  'presencial',
  'eletronica_simples',
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

// ── Fechamento financeiro (Fase 20) ───────────────────────────────────────────
/**
 * Natureza da despesa. **Dois valores, de propósito.**
 *
 * `fixa` é o que vem todo mês independente do movimento; `variavel` acompanha o
 * atendimento. Serve a uma pergunta concreta — "de quanto preciso por mês com zero
 * paciente?" — que é a soma das fixas.
 *
 * Não é plano de contas e não deve virar um: hierarquia, código contábil e amarração
 * fiscal são decisão de quem faz a contabilidade da clínica, e um esboço nosso viraria
 * campo que ninguém preenche.
 */
export const naturezaDespesaEnum = pgEnum('natureza_despesa', ['fixa', 'variavel'])

/**
 * Situação da cobrança Pix.
 *
 * `expirado` é estado próprio, não uma variação de `cancelado`: QR que venceu sem
 * pagamento é normal e não exige explicação, enquanto cancelamento é ato de alguém.
 * Misturar os dois apagaria a diferença entre "o paciente não pagou" e "a recepção
 * desistiu da cobrança".
 */
export const situacaoPixEnum = pgEnum('situacao_pix', [
  'pendente',
  'pago',
  'expirado',
  'cancelado',
])

// ── TISS / convênios (Fase 13) ────────────────────────────────────────────────
/**
 * Ciclo de vida da guia.
 *
 * `glosada_parcial` é estado próprio, não uma variação de `paga`: uma guia paga em
 * parte tem dinheiro a recorrer e não pode desaparecer da fila de cobrança. Tratar
 * como paga é como a clínica perde o que foi glosado.
 */
export const situacaoGuiaEnum = pgEnum('situacao_guia', [
  'rascunho',
  'enviada',
  'em_analise',
  'paga',
  'glosada_parcial',
  'glosada_total',
  'cancelada',
])

export const situacaoItemGuiaEnum = pgEnum('situacao_item_guia', [
  'apresentado',
  'pago',
  'glosado_parcial',
  'glosado_total',
  'em_recurso',
  'reapresentado',
])

/**
 * Classificação OPERACIONAL da glosa: o que fazer a respeito.
 *
 * Não é a Tabela 38 da ANS (motivos oficiais, dezenas de códigos) — o código da
 * operadora vai em `glosa.codigo_operadora`. Esta classificação existe porque a
 * ação é diferente para cada caso: erro de digitação se corrige e recorre;
 * procedimento não coberto passa a ser do paciente. Ver lib/domain/convenio.ts.
 */
export const classeGlosaEnum = pgEnum('classe_glosa', [
  'erro_de_envio',
  'nao_coberto',
  'elegibilidade',
  'valor',
  'falta_documento',
  'prazo',
  'outro',
])

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

// ── Documentos: etapa clínica (Fase 10) ───────────────────────────────────────
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

// ── Estoque ───────────────────────────────────────────────────────────────────
export const categoriaMaterialEnum = pgEnum('categoria_material', [
  'anestesico',
  'restaurador',
  'endodontia',
  'cirurgia',
  'protese',
  'ortodontia',
  'radiologia',
  'descartavel',
  'instrumental',
  'esterilizacao',
  'medicamento',
  'escritorio',
])

/** Unidade de CONSUMO — o que sai do armário, não o que vem do fornecedor. */
export const unidadeMaterialEnum = pgEnum('unidade_material', [
  'unidade',
  'tubete',
  'caixa',
  'frasco',
  'ml',
  'g',
  'par',
  'rolo',
  'folha',
])

/**
 * Tipos de movimento. `ajuste` é o único que vai nos dois sentidos, e exige
 * motivo: sem ele, perda de material e erro de lançamento ficam indistinguíveis
 * — e é justamente essa diferença que a clínica precisa enxergar.
 */
export const tipoMovimentoEstoqueEnum = pgEnum('tipo_movimento_estoque', [
  'entrada',
  'consumo',
  'descarte',
  'devolucao',
  'ajuste',
])

// ── Relacionamento (Fase 18) ─────────────────────────────────────────────────

/**
 * Por que a clínica precisa falar com este paciente.
 *
 * Cada valor corresponde a um gerador em `lib/relacionamento/geradores.ts`, e a
 * ordem aqui é a ordem de urgência de dinheiro: orçamento parado e inadimplência
 * são caixa que não entrou; retorno é caixa que não vai entrar.
 */
export const tipoTarefaRelacionamentoEnum = pgEnum('tipo_tarefa_relacionamento', [
  'orcamento_sem_resposta',
  'inadimplencia',
  'aprovado_nao_executado',
  'falta_sem_remarcar',
  'retorno_programado',
])

/**
 * Situação da tarefa na fila.
 *
 * `dispensada` **não** é o mesmo que `resolvida`, e a diferença é o ponto todo da
 * fase: resolvida é "o paciente marcou"; dispensada é "não insista". Colapsar as
 * duas num `fechada` faria a clínica perder a informação que impede a segunda
 * ligação para quem pediu para não ser incomodado.
 */
export const situacaoTarefaEnum = pgEnum('situacao_tarefa', [
  'aberta',
  'em_andamento',
  'resolvida',
  'dispensada',
])

/** Por onde a recepção falou com o paciente. */
export const canalContatoEnum = pgEnum('canal_contato', [
  'telefone',
  'whatsapp',
  'email',
  'presencial',
])

/**
 * O que aconteceu na tentativa de contato.
 *
 * `nao_atendeu` e `nao_quer` parecem próximos e são opostos operacionais: o
 * primeiro pede outra tentativa, o segundo **encerra** a fila para aquele
 * paciente. Uma lista com só "sem sucesso" faria a recepção ligar de novo para
 * quem disse não.
 */
export const resultadoContatoEnum = pgEnum('resultado_contato', [
  'falou',
  'nao_atendeu',
  'numero_errado',
  'remarcou',
  'nao_quer',
])

/**
 * Natureza do retorno programado. **Não vai na mensagem do paciente** — serve
 * para a clínica organizar a fila e para o relatório separar profilaxia de
 * manutenção ortodôntica. Ver `lib/domain/textoMensagem.ts`: a mensagem não
 * carrega dado clínico.
 */
export const tipoRetornoEnum = pgEnum('tipo_retorno', [
  'exame',
  'profilaxia',
  'periodontal',
  'ortodontia',
  'controle',
])

// ── Fase 21: profundidade clínica ────────────────────────────────────────────

/**
 * Os seis sítios de sondagem, com o lado oral nomeado pela arcada. [PADRÃO]
 *
 * Nove valores, não seis, e é de propósito: superior tem palatina, inferior tem
 * lingual — a mesma regra das faces do odontograma. Um `mesio_oral` genérico
 * deixaria gravar sítio que não existe naquele dente sem nada perceber; com nove
 * valores e o CHECK por arcada da `drizzle/0037`, "palatina no 36" é impossível de
 * gravar, não apenas errado de exibir. Ver `lib/domain/periograma.ts`.
 */
export const sitioPeriogramaEnum = pgEnum('sitio_periograma', [
  'mesio_vestibular',
  'vestibular',
  'disto_vestibular',
  'mesio_palatina',
  'palatina',
  'disto_palatina',
  'mesio_lingual',
  'lingual',
  'disto_lingual',
])

/**
 * Situação da ordem de serviço de prótese.
 *
 * Quatro estados, e nenhum a mais de propósito: prova, ajuste e instalação são
 * ETAPAS do atendimento e já vivem em `execucao` — inventá-las aqui criaria uma
 * segunda máquina de estado para o mesmo fato clínico. Refação de peça não é
 * estado, é ordem nova apontando para a anterior (`refaz_id`), porque quem paga a
 * refação é uma pergunta que precisa de duas linhas para ser respondida.
 */
export const situacaoOrdemLaboratorioEnum = pgEnum('situacao_ordem_laboratorio', [
  'aberta',
  'enviada',
  'recebida',
  'cancelada',
])

/** Indicador químico do ciclo de esterilização: sai na hora, junto com a carga. */
export const resultadoIndicadorEnum = pgEnum('resultado_indicador', ['aprovado', 'reprovado'])

/**
 * Indicador BIOLÓGICO, que é o que certifica o ciclo — e cujo resultado sai dias
 * depois, após incubação.
 *
 * `pendente` é o estado em que o ciclo NASCE, e é a razão de a certificação ser
 * coluna gerada em vez de campo: um ciclo com biológico pendente não está
 * certificado, e deixar isso a cargo de quem digita é como o campo de glosa
 * digitado — divergência esperando acontecer. `negativo` = sem crescimento
 * microbiano = esterilização eficaz.
 */
export const resultadoBiologicoEnum = pgEnum('resultado_biologico', [
  'pendente',
  'negativo',
  'positivo',
])
