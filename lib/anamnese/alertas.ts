import {
  type Respostas,
  detalheDe,
  escolhaDe,
  numeroDe,
  respondeuSim,
} from './formulario'

/**
 * Derivação de alertas clínicos a partir da anamnese.
 *
 * **Este é o arquivo com consequência clínica do projeto.** Um alerta que
 * deveria aparecer e não aparece pode significar anestésico errado em paciente
 * alérgico, extração em paciente anticoagulado, ou radiografia em gestante.
 *
 * Três decisões de projeto:
 *
 * 1. **Severidade conservadora.** Na dúvida entre `atencao` e `critico`, é
 *    `critico`. O custo de um alerta a mais é ruído; o de um a menos é dano.
 *
 * 2. **A regra carrega o MOTIVO, não só o rótulo.** "Anticoagulante" sozinho não
 *    diz nada a quem está com o fórceps na mão. A descrição diz o que muda.
 *
 * 3. **Derivação é sugestão, não decisão.** O dentista confirma antes de gravar.
 *    Automação que grava direto no prontuário sem revisão humana é o tipo de
 *    coisa que faz sistema clínico perder confiança.
 */

export type Severidade = 'informativo' | 'atencao' | 'critico'

export interface AlertaDerivado {
  /** Identidade estável da regra — evita duplicar alerta ao refazer a anamnese. */
  readonly regra: string
  readonly tipo: string
  readonly descricao: string
  readonly severidade: Severidade
}

interface Regra {
  readonly id: string
  readonly tipo: string
  readonly severidade: Severidade
  /** `null` = a regra não se aplica. String = descrição do alerta. */
  readonly avaliar: (r: Respostas) => string | null
}

const comDetalhe = (base: string, detalhe: string | null): string =>
  detalhe ? `${base}: ${detalhe}` : base

const REGRAS: readonly Regra[] = [
  // ── Crítico: muda anestésico ou pode causar reação grave ──────────────────
  {
    id: 'alergia_anestesico',
    tipo: 'Alergia a anestésico',
    severidade: 'critico',
    avaliar: (r) =>
      respondeuSim(r, 'alergia_anestesico')
        ? comDetalhe(
            'Reação prévia a anestesia local — confirmar o agente antes de qualquer infiltração',
            detalheDe(r, 'alergia_anestesico'),
          )
        : null,
  },
  {
    id: 'alergia_medicamento',
    tipo: 'Alergia',
    severidade: 'critico',
    avaliar: (r) =>
      respondeuSim(r, 'alergia_medicamento')
        ? comDetalhe('Alergia medicamentosa — verificar antes de prescrever', detalheDe(r, 'alergia_medicamento'))
        : null,
  },
  {
    id: 'alergia_latex',
    tipo: 'Alergia a látex',
    severidade: 'critico',
    avaliar: (r) =>
      respondeuSim(r, 'alergia_latex')
        ? 'Usar luva e lençol de borracha sem látex'
        : null,
  },

  // ── Crítico: risco de sangramento ────────────────────────────────────────
  {
    id: 'anticoagulante',
    tipo: 'Anticoagulante',
    severidade: 'critico',
    avaliar: (r) =>
      respondeuSim(r, 'anticoagulante')
        ? comDetalhe(
            'Uso de anticoagulante — avaliar INR e alinhar com o médico antes de procedimento cirúrgico',
            detalheDe(r, 'anticoagulante'),
          )
        : null,
  },
  {
    id: 'coagulacao',
    tipo: 'Distúrbio de coagulação',
    severidade: 'critico',
    avaliar: (r) =>
      respondeuSim(r, 'distúrbio_coagulacao')
        ? 'Distúrbio de coagulação — planejar hemostasia antes de extração'
        : null,
  },
  {
    id: 'sangramento_prolongado',
    tipo: 'Histórico de sangramento',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'sangramento_prolongado')
        ? 'Já teve sangramento difícil de conter — reforçar hemostasia local'
        : null,
  },

  // ── Crítico: gestação ────────────────────────────────────────────────────
  {
    id: 'gestante',
    tipo: 'Gestante',
    severidade: 'critico',
    avaliar: (r) => {
      if (!respondeuSim(r, 'gravida')) return null
      const semanas = numeroDe(r, 'semanas_gestacao')
      const base =
        'Gestante — evitar radiografia sem necessidade, revisar anestésico e prescrição, e não deitar totalmente no 3º trimestre'
      return semanas ? `${base}. ${semanas} semanas na data da anamnese` : base
    },
  },

  // ── Crítico: profilaxia antibiótica ──────────────────────────────────────
  {
    id: 'endocardite',
    tipo: 'Risco de endocardite',
    severidade: 'critico',
    avaliar: (r) =>
      respondeuSim(r, 'endocardite')
        ? 'Histórico de endocardite ou prótese valvar — avaliar profilaxia antibiótica antes de procedimento invasivo'
        : null,
  },

  // ── Crítico: osteonecrose ────────────────────────────────────────────────
  {
    id: 'bifosfonato',
    tipo: 'Bifosfonato',
    severidade: 'critico',
    avaliar: (r) =>
      respondeuSim(r, 'bifosfonato')
        ? comDetalhe(
            'Uso de bifosfonato — risco de osteonecrose dos maxilares; evitar procedimento cirúrgico sem avaliação',
            detalheDe(r, 'bifosfonato'),
          )
        : null,
  },
  {
    id: 'radioterapia',
    tipo: 'Oncológico',
    severidade: 'critico',
    avaliar: (r) => {
      if (!respondeuSim(r, 'cancer')) return null
      const detalhe = detalheDe(r, 'cancer')
      // Radioterapia de cabeça e pescoço é o caso que muda tudo; sem detalhe,
      // o alerta ainda sobe como crítico para o dentista perguntar.
      return comDetalhe(
        'Tratamento oncológico — se houve radioterapia de cabeça e pescoço, risco de osteorradionecrose',
        detalhe,
      )
    },
  },

  // ── Atenção: manejo e monitoramento ──────────────────────────────────────
  {
    id: 'diabetes',
    tipo: 'Diabetes',
    severidade: 'atencao',
    avaliar: (r) => {
      const tipo = escolhaDe(r, 'diabetes')
      if (!tipo || tipo === 'Não') return null
      // Descompensada é mais grave: cicatrização e risco de infecção.
      const controlada = respondeuSim(r, 'diabetes_controlada')
      return controlada
        ? `${tipo}, referida como controlada — atenção à cicatrização`
        : `${tipo}, controle NÃO confirmado — risco de infecção e cicatrização lenta`
    },
  },
  {
    id: 'diabetes_descompensada',
    tipo: 'Diabetes descompensada',
    severidade: 'critico',
    avaliar: (r) => {
      const tipo = escolhaDe(r, 'diabetes')
      if (!tipo || tipo === 'Não' || tipo === 'Pré-diabetes') return null
      // Só sobe a crítico quando o paciente afirma que NÃO está controlada.
      const resposta = r.diabetes_controlada
      const negou =
        resposta && (resposta.tipo === 'sim_nao' || resposta.tipo === 'sim_nao_detalhe') && resposta.valor === false
      return negou
        ? 'Diabetes referida como não controlada — adiar procedimento eletivo cirúrgico e encaminhar'
        : null
    },
  },
  {
    id: 'cardiaco',
    tipo: 'Cardiopatia',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'cardiaco')
        ? comDetalhe('Cardiopatia — limitar vasoconstritor e monitorar', detalheDe(r, 'cardiaco'))
        : null,
  },
  {
    id: 'marcapasso',
    tipo: 'Marca-passo',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'marcapasso')
        ? 'Usa marca-passo — cautela com equipamento eletrônico (ultrassom, bisturi elétrico)'
        : null,
  },
  {
    id: 'hipertensao',
    tipo: 'Hipertensão',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'hipertensao')
        ? 'Pressão alta — medir antes do procedimento e limitar vasoconstritor'
        : null,
  },
  {
    id: 'epilepsia',
    tipo: 'Epilepsia',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'epilepsia')
        ? 'Histórico de convulsão — sessões curtas e ambiente sem estímulo excessivo'
        : null,
  },
  {
    id: 'respiratorio',
    tipo: 'Problema respiratório',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'respiratorio')
        ? comDetalhe(
            'Condição respiratória — atenção ao lençol de borracha e à posição na cadeira',
            detalheDe(r, 'respiratorio'),
          )
        : null,
  },
  {
    id: 'renal',
    tipo: 'Doença renal',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'renal')
        ? comDetalhe('Doença renal — ajustar dose de medicamento', detalheDe(r, 'renal'))
        : null,
  },
  {
    id: 'hepatite',
    tipo: 'Hepatite',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'hepatite')
        ? comDetalhe(
            'Histórico de hepatite — atenção a metabolismo de anestésico e coagulação',
            detalheDe(r, 'hepatite'),
          )
        : null,
  },
  {
    id: 'imunossupressao',
    tipo: 'Imunossupressão',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'imunossupressao')
        ? 'Imunidade reduzida — maior risco de infecção pós-operatória'
        : null,
  },
  {
    id: 'medicamentos_continuos',
    tipo: 'Medicação contínua',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'medicamentos')
        ? comDetalhe('Uso contínuo — checar interação antes de prescrever', detalheDe(r, 'medicamentos'))
        : null,
  },

  // ── Informativo: muda manejo, não segurança ──────────────────────────────
  {
    id: 'ansiedade',
    tipo: 'Ansiedade odontológica',
    severidade: 'informativo',
    avaliar: (r) =>
      respondeuSim(r, 'medo_dentista')
        ? 'Medo relatado — sessões mais curtas e explicar cada passo antes'
        : null,
  },
  {
    id: 'bruxismo',
    tipo: 'Bruxismo',
    severidade: 'informativo',
    avaliar: (r) =>
      respondeuSim(r, 'bruxismo') ? 'Aperta ou range os dentes — avaliar placa e desgaste' : null,
  },
  {
    id: 'fumante',
    tipo: 'Fumante',
    severidade: 'informativo',
    avaliar: (r) => {
      if (!respondeuSim(r, 'fumante')) return null
      const qtd = numeroDe(r, 'cigarros_dia')
      const base = 'Fumante — cicatrização mais lenta e risco periodontal aumentado'
      return qtd ? `${base}. ${qtd} cigarro(s) por dia` : base
    },
  },
  {
    id: 'complicacao_extracao',
    tipo: 'Complicação prévia',
    severidade: 'atencao',
    avaliar: (r) =>
      respondeuSim(r, 'complicacao_extracao')
        ? comDetalhe('Já teve complicação em extração', detalheDe(r, 'complicacao_extracao'))
        : null,
  },
]

const PESO: Readonly<Record<Severidade, number>> = { critico: 0, atencao: 1, informativo: 2 }

/**
 * Alertas sugeridos pelas respostas, do mais grave para o menos.
 *
 * Não grava nada: quem decide é o dentista, na tela de revisão.
 */
export function derivarAlertas(respostas: Respostas): readonly AlertaDerivado[] {
  const alertas: AlertaDerivado[] = []

  for (const regra of REGRAS) {
    const descricao = regra.avaliar(respostas)
    if (descricao) {
      alertas.push({
        regra: regra.id,
        tipo: regra.tipo,
        descricao,
        severidade: regra.severidade,
      })
    }
  }

  return alertas.sort(
    (a, b) => PESO[a.severidade] - PESO[b.severidade] || a.tipo.localeCompare(b.tipo),
  )
}

/** Ids de todas as regras — usado no teste de cobertura e na desativação. */
export function idsDasRegras(): readonly string[] {
  return REGRAS.map((r) => r.id)
}

export function temAlertaCritico(alertas: readonly AlertaDerivado[]): boolean {
  return alertas.some((a) => a.severidade === 'critico')
}
