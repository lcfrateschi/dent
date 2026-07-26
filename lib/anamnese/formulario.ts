/**
 * Formulário de anamnese, **versionado**.
 *
 * A definição vive em código, não em tabela. Motivo: as respostas ficam em
 * JSONB com a versão do formulário que as gerou, e renderizar o histórico exige
 * ter a definição ANTIGA disponível. Formulário em banco, editável, tornaria
 * impossível reexibir uma anamnese de 2027 como ela foi respondida.
 *
 * Ao mudar perguntas: crie uma versão nova e **mantenha a antiga aqui**. Nunca
 * edite uma versão publicada — o prontuário passado tem que continuar legível.
 */

export type TipoPergunta = 'sim_nao' | 'sim_nao_detalhe' | 'texto' | 'escolha' | 'numero'

export interface Pergunta {
  readonly id: string
  readonly texto: string
  readonly tipo: TipoPergunta
  /** Para `escolha`. */
  readonly opcoes?: readonly string[]
  /** Rótulo do campo de detalhe em `sim_nao_detalhe`. */
  readonly rotuloDetalhe?: string
  /** Aparece só quando esta outra pergunta foi respondida "sim". */
  readonly dependeDe?: string
  readonly ajuda?: string
}

export interface Secao {
  readonly id: string
  readonly titulo: string
  readonly descricao?: string
  readonly perguntas: readonly Pergunta[]
}

export interface VersaoFormulario {
  readonly versao: string
  readonly secoes: readonly Secao[]
}

const sn = (id: string, texto: string, extra: Partial<Pergunta> = {}): Pergunta => ({
  id,
  texto,
  tipo: 'sim_nao',
  ...extra,
})

const snd = (
  id: string,
  texto: string,
  rotuloDetalhe = 'Qual?',
  extra: Partial<Pergunta> = {},
): Pergunta => ({ id, texto, tipo: 'sim_nao_detalhe', rotuloDetalhe, ...extra })

/**
 * Versão 1. Cobre o que muda a conduta clínica num consultório odontológico.
 *
 * Não é questionário de triagem geral: cada pergunta aqui existe porque a
 * resposta altera anestésico, prescrição, necessidade de profilaxia
 * antibiótica, risco de sangramento ou posicionamento na cadeira.
 */
export const FORMULARIO_V1: VersaoFormulario = {
  versao: '1',
  secoes: [
    {
      id: 'geral',
      titulo: 'Saúde geral',
      descricao: 'Estas respostas mudam anestésico, prescrição e conduta.',
      perguntas: [
        snd('tratamento_medico', 'Está em tratamento médico atualmente?', 'De quê?'),
        snd('medicamentos', 'Toma algum medicamento de uso contínuo?', 'Quais?'),
        snd('cirurgia_recente', 'Fez alguma cirurgia nos últimos 12 meses?', 'Qual?'),
        snd('internacao', 'Esteve internado nos últimos 2 anos?', 'Por quê?'),
      ],
    },
    {
      id: 'alergias',
      titulo: 'Alergias',
      descricao: 'Reação a anestésico local é a informação mais crítica desta ficha.',
      perguntas: [
        snd('alergia_medicamento', 'Tem alergia a algum medicamento?', 'Qual medicamento?'),
        snd('alergia_anestesico', 'Já tive reação a anestesia local?', 'Como foi a reação?'),
        sn('alergia_latex', 'Tem alergia a látex?'),
        snd('alergia_outra', 'Tem outra alergia?', 'A quê?'),
      ],
    },
    {
      id: 'cardio',
      titulo: 'Coração e circulação',
      perguntas: [
        snd('cardiaco', 'Tem problema cardíaco?', 'Qual? (sopro, arritmia, infarto)'),
        sn('marcapasso', 'Usa marca-passo?'),
        sn('endocardite', 'Já teve endocardite ou tem prótese valvar?', {
          ajuda: 'Pode exigir profilaxia antibiótica antes de procedimento invasivo.',
        }),
        sn('hipertensao', 'Tem pressão alta?'),
        sn('hipotensao', 'Tem pressão baixa ou desmaia com facilidade?'),
      ],
    },
    {
      id: 'sangramento',
      titulo: 'Sangramento e coagulação',
      perguntas: [
        snd('anticoagulante', 'Usa anticoagulante?', 'Qual? (varfarina, rivaroxabana, AAS)', {
          ajuda: 'Suspender por conta própria é perigoso — a conduta é combinada com o médico.',
        }),
        sn('distúrbio_coagulacao', 'Tem distúrbio de coagulação (hemofilia, plaquetopenia)?'),
        sn('sangramento_prolongado', 'Já teve sangramento difícil de parar após extração ou corte?'),
        sn('anemia', 'Tem anemia?'),
      ],
    },
    {
      id: 'metabolico',
      titulo: 'Metabolismo e endócrino',
      perguntas: [
        {
          id: 'diabetes',
          texto: 'Tem diabetes?',
          tipo: 'escolha',
          opcoes: ['Não', 'Tipo 1', 'Tipo 2', 'Gestacional', 'Pré-diabetes'],
        },
        sn('diabetes_controlada', 'A diabetes está controlada?', { dependeDe: 'diabetes' }),
        sn('tireoide', 'Tem problema de tireoide?'),
        snd('bifosfonato', 'Usa ou usou bifosfonato para osteoporose?', 'Qual e por quanto tempo?', {
          ajuda: 'Risco de osteonecrose de mandíbula em extração — muda o planejamento cirúrgico.',
        }),
      ],
    },
    {
      id: 'sistemico',
      titulo: 'Outras condições',
      perguntas: [
        snd('respiratorio', 'Tem problema respiratório?', 'Qual? (asma, bronquite, DPOC)'),
        sn('epilepsia', 'Tem epilepsia ou já teve convulsão?'),
        snd('renal', 'Tem doença renal?', 'Qual? Faz diálise?'),
        snd('hepatite', 'Já teve hepatite?', 'Qual tipo?'),
        sn('imunossupressao', 'Tem alguma condição que baixe a imunidade?'),
        snd('cancer', 'Fez ou faz tratamento para câncer?', 'Qual? Quimio ou radioterapia?', {
          ajuda: 'Radioterapia de cabeça e pescoço muda radicalmente a conduta cirúrgica.',
        }),
        sn('artrite', 'Tem artrite ou problema articular?'),
      ],
    },
    {
      id: 'gestacao',
      titulo: 'Gestação e amamentação',
      perguntas: [
        sn('gravida', 'Está grávida?', {
          ajuda: 'Muda radiografia, anestésico, prescrição e posição na cadeira.',
        }),
        { id: 'semanas_gestacao', texto: 'Quantas semanas?', tipo: 'numero', dependeDe: 'gravida' },
        sn('amamentando', 'Está amamentando?'),
      ],
    },
    {
      id: 'habitos',
      titulo: 'Hábitos',
      perguntas: [
        sn('fumante', 'Fuma?'),
        { id: 'cigarros_dia', texto: 'Quantos por dia?', tipo: 'numero', dependeDe: 'fumante' },
        sn('alcool', 'Consome bebida alcoólica com frequência?'),
        sn('bruxismo', 'Aperta ou range os dentes?'),
        sn('roer_unhas', 'Tem hábito de roer unhas ou morder objetos?'),
      ],
    },
    {
      id: 'odontologico',
      titulo: 'Histórico odontológico',
      perguntas: [
        {
          id: 'ultima_visita',
          texto: 'Quando foi a última visita ao dentista?',
          tipo: 'escolha',
          opcoes: ['Menos de 6 meses', '6 meses a 1 ano', '1 a 3 anos', 'Mais de 3 anos', 'Nunca fui'],
        },
        sn('sangramento_gengival', 'A gengiva sangra ao escovar?'),
        sn('dor_dente', 'Sente dor em algum dente?'),
        sn('sensibilidade', 'Tem sensibilidade a frio, calor ou doce?'),
        sn('mau_halito', 'Tem mau hálito com frequência?'),
        snd('complicacao_extracao', 'Já teve complicação em extração?', 'O que aconteceu?'),
        sn('usou_aparelho', 'Já usou aparelho ortodôntico?'),
        sn('medo_dentista', 'Sente muito medo ou ansiedade em tratamento dentário?', {
          ajuda: 'Muda o manejo: sessões mais curtas, explicação antes de cada passo.',
        }),
        {
          id: 'escovacoes_dia',
          texto: 'Quantas vezes escova os dentes por dia?',
          tipo: 'escolha',
          opcoes: ['1', '2', '3 ou mais', 'Menos de 1'],
        },
        sn('fio_dental', 'Usa fio dental diariamente?'),
      ],
    },
    {
      id: 'observacoes',
      titulo: 'Observações',
      perguntas: [
        {
          id: 'observacoes_paciente',
          texto: 'Algo mais que o dentista deva saber?',
          tipo: 'texto',
        },
      ],
    },
  ],
}

/** Todas as versões já publicadas. A chave é a versão. */
export const VERSOES: Readonly<Record<string, VersaoFormulario>> = {
  '1': FORMULARIO_V1,
}

/** Versão em uso para novas anamneses. */
export const VERSAO_ATUAL = '1'

export function formularioDaVersao(versao: string): VersaoFormulario | undefined {
  return VERSOES[versao]
}

export function formularioAtual(): VersaoFormulario {
  return VERSOES[VERSAO_ATUAL]!
}

/** Todas as perguntas de uma versão, achatadas. */
export function perguntasDe(versao: VersaoFormulario): readonly Pergunta[] {
  return versao.secoes.flatMap((s) => s.perguntas)
}

export function acharPergunta(versao: VersaoFormulario, id: string): Pergunta | undefined {
  return perguntasDe(versao).find((p) => p.id === id)
}

// ── Formato das respostas ────────────────────────────────────────────────────

/**
 * Uma resposta. `sim_nao_detalhe` guarda os dois campos juntos para que o
 * detalhe nunca se separe do "sim" que o justifica.
 */
export type Resposta =
  | { readonly tipo: 'sim_nao'; readonly valor: boolean | null }
  | { readonly tipo: 'sim_nao_detalhe'; readonly valor: boolean | null; readonly detalhe: string | null }
  | { readonly tipo: 'texto'; readonly valor: string | null }
  | { readonly tipo: 'escolha'; readonly valor: string | null }
  | { readonly tipo: 'numero'; readonly valor: number | null }

export type Respostas = Readonly<Record<string, Resposta>>

/** `true` só quando a resposta é positiva de forma explícita. */
export function respondeuSim(respostas: Respostas, id: string): boolean {
  const r = respostas[id]
  if (!r) return false
  if (r.tipo === 'sim_nao' || r.tipo === 'sim_nao_detalhe') return r.valor === true
  return false
}

export function detalheDe(respostas: Respostas, id: string): string | null {
  const r = respostas[id]
  if (r?.tipo === 'sim_nao_detalhe') return r.detalhe?.trim() || null
  if (r?.tipo === 'texto' || r?.tipo === 'escolha') return r.valor?.trim() || null
  return null
}

export function escolhaDe(respostas: Respostas, id: string): string | null {
  const r = respostas[id]
  return r?.tipo === 'escolha' ? r.valor : null
}

export function numeroDe(respostas: Respostas, id: string): number | null {
  const r = respostas[id]
  return r?.tipo === 'numero' ? r.valor : null
}
