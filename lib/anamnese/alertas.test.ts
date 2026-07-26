import { describe, expect, it } from 'vitest'
import { derivarAlertas, idsDasRegras, temAlertaCritico } from './alertas'
import { type Respostas, perguntasDe, formularioAtual } from './formulario'

/**
 * Cada regra clínica tem teste próprio. Um alerta que deveria aparecer e não
 * aparece pode significar anestésico errado em paciente alérgico ou extração em
 * paciente anticoagulado — não é o tipo de código que se confia à leitura.
 */

const sim = (detalhe?: string): Respostas[string] =>
  detalhe === undefined
    ? { tipo: 'sim_nao', valor: true }
    : { tipo: 'sim_nao_detalhe', valor: true, detalhe }

const nao: Respostas[string] = { tipo: 'sim_nao', valor: false }

function alertas(respostas: Respostas) {
  return derivarAlertas(respostas)
}

function regras(respostas: Respostas): string[] {
  return alertas(respostas).map((a) => a.regra)
}

describe('paciente sem nada relatado', () => {
  it('não gera alerta nenhum', () => {
    expect(alertas({})).toEqual([])
    expect(
      alertas({
        alergia_medicamento: nao,
        anticoagulante: nao,
        gravida: nao,
        diabetes: { tipo: 'escolha', valor: 'Não' },
      }),
    ).toEqual([])
  })

  it('não confunde "não respondido" com "sim"', () => {
    // null é "não respondeu": não pode gerar alerta nem ser tratado como não.
    expect(alertas({ anticoagulante: { tipo: 'sim_nao_detalhe', valor: null, detalhe: null } })).toEqual([])
  })
})

describe('alergias — os alertas mais críticos da ficha', () => {
  it('reação a anestésico é crítica e cita o agente', () => {
    const a = alertas({ alergia_anestesico: sim('lidocaína, teve taquicardia') })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ regra: 'alergia_anestesico', severidade: 'critico' })
    expect(a[0]!.descricao).toContain('lidocaína')
    expect(a[0]!.descricao).toMatch(/infiltração/i)
  })

  it('alergia medicamentosa é crítica', () => {
    const a = alertas({ alergia_medicamento: sim('penicilina') })
    expect(a[0]).toMatchObject({ regra: 'alergia_medicamento', severidade: 'critico' })
    expect(a[0]!.descricao).toContain('penicilina')
  })

  it('látex é crítico e diz o que trocar', () => {
    const a = alertas({ alergia_latex: sim() })
    expect(a[0]!.severidade).toBe('critico')
    expect(a[0]!.descricao).toMatch(/sem látex/i)
  })

  it('funciona sem o detalhe preenchido', () => {
    const a = alertas({ alergia_medicamento: { tipo: 'sim_nao_detalhe', valor: true, detalhe: null } })
    expect(a).toHaveLength(1)
    expect(a[0]!.descricao).not.toContain(':')
  })
})

describe('sangramento', () => {
  it('anticoagulante é crítico e menciona INR e o médico', () => {
    const a = alertas({ anticoagulante: sim('varfarina') })
    expect(a[0]).toMatchObject({ regra: 'anticoagulante', severidade: 'critico' })
    expect(a[0]!.descricao).toMatch(/INR/)
    expect(a[0]!.descricao).toMatch(/médico/)
  })

  it('distúrbio de coagulação é crítico', () => {
    expect(alertas({ distúrbio_coagulacao: sim() })[0]!.severidade).toBe('critico')
  })

  it('histórico de sangramento é atenção, não crítico', () => {
    const a = alertas({ sangramento_prolongado: sim() })
    expect(a[0]).toMatchObject({ regra: 'sangramento_prolongado', severidade: 'atencao' })
  })
})

describe('gestação', () => {
  it('é crítica e lista o que muda', () => {
    const a = alertas({ gravida: sim() })
    expect(a[0]).toMatchObject({ regra: 'gestante', severidade: 'critico' })
    expect(a[0]!.descricao).toMatch(/radiografia/i)
    expect(a[0]!.descricao).toMatch(/anestésico/i)
  })

  it('registra as semanas quando informadas', () => {
    const a = alertas({ gravida: sim(), semanas_gestacao: { tipo: 'numero', valor: 28 } })
    expect(a[0]!.descricao).toContain('28 semanas')
  })

  it('não dispara quando não está grávida, mesmo com semanas preenchidas', () => {
    // Campo dependente pode ficar preenchido de uma resposta anterior.
    expect(regras({ gravida: nao, semanas_gestacao: { tipo: 'numero', valor: 12 } })).toEqual([])
  })
})

describe('diabetes — severidade depende do controle', () => {
  it('controlada é atenção', () => {
    const a = alertas({ diabetes: { tipo: 'escolha', valor: 'Tipo 2' }, diabetes_controlada: sim() })
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ regra: 'diabetes', severidade: 'atencao' })
    expect(a[0]!.descricao).toContain('controlada')
  })

  it('NÃO controlada sobe a crítico e recomenda adiar', () => {
    const a = alertas({
      diabetes: { tipo: 'escolha', valor: 'Tipo 1' },
      diabetes_controlada: nao,
    })
    const criticos = a.filter((x) => x.severidade === 'critico')
    expect(criticos).toHaveLength(1)
    expect(criticos[0]!.regra).toBe('diabetes_descompensada')
    expect(criticos[0]!.descricao).toMatch(/adiar/i)
  })

  it('controle não respondido fica em atenção, sem afirmar descompensação', () => {
    const a = alertas({ diabetes: { tipo: 'escolha', valor: 'Tipo 2' } })
    expect(a.map((x) => x.regra)).toEqual(['diabetes'])
    expect(a[0]!.descricao).toMatch(/NÃO confirmado/)
  })

  it('"Não" não gera alerta', () => {
    expect(regras({ diabetes: { tipo: 'escolha', valor: 'Não' } })).toEqual([])
  })

  it('pré-diabetes gera atenção mas nunca crítico', () => {
    const a = alertas({ diabetes: { tipo: 'escolha', valor: 'Pré-diabetes' }, diabetes_controlada: nao })
    expect(a.map((x) => x.regra)).toEqual(['diabetes'])
    expect(temAlertaCritico(a)).toBe(false)
  })
})

describe('risco cirúrgico', () => {
  it('bifosfonato é crítico e nomeia osteonecrose', () => {
    const a = alertas({ bifosfonato: sim('alendronato por 4 anos') })
    expect(a[0]).toMatchObject({ regra: 'bifosfonato', severidade: 'critico' })
    expect(a[0]!.descricao).toMatch(/osteonecrose/i)
    expect(a[0]!.descricao).toContain('alendronato')
  })

  it('endocardite é crítica e lembra a profilaxia', () => {
    const a = alertas({ endocardite: sim() })
    expect(a[0]!.severidade).toBe('critico')
    expect(a[0]!.descricao).toMatch(/profilaxia antibiótica/i)
  })

  it('tratamento oncológico é crítico mesmo sem detalhe — para o dentista perguntar', () => {
    const a = alertas({ cancer: { tipo: 'sim_nao_detalhe', valor: true, detalhe: null } })
    expect(a[0]).toMatchObject({ regra: 'radioterapia', severidade: 'critico' })
    expect(a[0]!.descricao).toMatch(/osteorradionecrose/i)
  })
})

describe('cardiovascular e sistêmico', () => {
  it('cardiopatia, marca-passo e hipertensão são atenção', () => {
    for (const [id, regra] of [
      ['cardiaco', 'cardiaco'],
      ['marcapasso', 'marcapasso'],
      ['hipertensao', 'hipertensao'],
    ] as const) {
      const a = alertas({ [id]: sim() })
      expect(a[0], id).toMatchObject({ regra, severidade: 'atencao' })
    }
  })

  it('hipertensão lembra de medir a pressão', () => {
    expect(alertas({ hipertensao: sim() })[0]!.descricao).toMatch(/medir/i)
  })

  it('epilepsia, renal, hepatite e imunossupressão são atenção', () => {
    for (const id of ['epilepsia', 'renal', 'hepatite', 'imunossupressao'] as const) {
      const a = alertas({ [id]: sim() })
      expect(a, id).toHaveLength(1)
      expect(a[0]!.severidade, id).toBe('atencao')
    }
  })
})

describe('informativos — mudam manejo, não segurança', () => {
  it('ansiedade, bruxismo e tabagismo são informativos', () => {
    for (const id of ['medo_dentista', 'bruxismo', 'fumante'] as const) {
      const a = alertas({ [id]: sim() })
      expect(a[0]!.severidade, id).toBe('informativo')
    }
  })

  it('tabagismo registra a quantidade quando informada', () => {
    const a = alertas({ fumante: sim(), cigarros_dia: { tipo: 'numero', valor: 20 } })
    expect(a[0]!.descricao).toContain('20 cigarro')
  })
})

describe('ordenação e agregação', () => {
  it('põe os críticos primeiro, depois atenção, depois informativo', () => {
    const a = alertas({
      fumante: sim(),
      hipertensao: sim(),
      anticoagulante: sim('AAS'),
      bruxismo: sim(),
      cardiaco: sim('arritmia'),
      alergia_latex: sim(),
    })
    const severidades = a.map((x) => x.severidade)
    const ordem = { critico: 0, atencao: 1, informativo: 2 }
    for (let i = 1; i < severidades.length; i++) {
      expect(ordem[severidades[i]!]).toBeGreaterThanOrEqual(ordem[severidades[i - 1]!])
    }
    expect(severidades[0]).toBe('critico')
  })

  it('acumula vários alertas de um paciente complexo', () => {
    const a = alertas({
      alergia_anestesico: sim('articaína'),
      anticoagulante: sim('varfarina'),
      diabetes: { tipo: 'escolha', valor: 'Tipo 2' },
      diabetes_controlada: nao,
      hipertensao: sim(),
      cardiaco: sim('infarto em 2020'),
      fumante: sim(),
      bifosfonato: sim('risedronato'),
    })
    expect(a.length).toBeGreaterThanOrEqual(7)
    expect(a.filter((x) => x.severidade === 'critico').length).toBeGreaterThanOrEqual(4)
    expect(temAlertaCritico(a)).toBe(true)
  })

  it('é determinístico — mesma entrada, mesma saída na mesma ordem', () => {
    const respostas: Respostas = { anticoagulante: sim('AAS'), hipertensao: sim(), fumante: sim() }
    expect(regras(respostas)).toEqual(regras(respostas))
  })

  it('não repete a mesma regra', () => {
    const a = alertas({ anticoagulante: sim('AAS'), hipertensao: sim() })
    expect(new Set(a.map((x) => x.regra)).size).toBe(a.length)
  })
})

describe('integridade das regras', () => {
  it('todo id de regra é único', () => {
    const ids = idsDasRegras()
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('toda regra referencia pergunta que existe no formulário atual', () => {
    // Regra apontando para pergunta removida nunca dispara — falha silenciosa.
    const idsPerguntas = new Set(perguntasDe(formularioAtual()).map((p) => p.id))
    const perguntasUsadas = [
      'alergia_anestesico',
      'alergia_medicamento',
      'alergia_latex',
      'anticoagulante',
      'distúrbio_coagulacao',
      'sangramento_prolongado',
      'gravida',
      'semanas_gestacao',
      'endocardite',
      'bifosfonato',
      'cancer',
      'diabetes',
      'diabetes_controlada',
      'cardiaco',
      'marcapasso',
      'hipertensao',
      'epilepsia',
      'respiratorio',
      'renal',
      'hepatite',
      'imunossupressao',
      'medicamentos',
      'medo_dentista',
      'bruxismo',
      'fumante',
      'cigarros_dia',
      'complicacao_extracao',
    ]
    const ausentes = perguntasUsadas.filter((p) => !idsPerguntas.has(p))
    expect(ausentes, `regras apontam para perguntas inexistentes: ${ausentes.join(', ')}`).toEqual([])
  })

  it('cada resposta positiva isolada dispara ao menos uma regra, ou nenhuma de propósito', () => {
    // Varredura: garante que nenhuma pergunta de sim/não fica órfã por engano.
    const semRegra: string[] = []
    for (const p of perguntasDe(formularioAtual())) {
      if (p.tipo !== 'sim_nao' && p.tipo !== 'sim_nao_detalhe') continue
      if (derivarAlertas({ [p.id]: sim('x') }).length === 0) semRegra.push(p.id)
    }
    // Estas são deliberadamente sem alerta: não mudam conduta por si.
    const esperadoSemRegra = [
      'tratamento_medico',
      'cirurgia_recente',
      'internacao',
      'alergia_outra',
      'hipotensao',
      'anemia',
      'tireoide',
      'artrite',
      'amamentando',
      'alcool',
      'roer_unhas',
      'sangramento_gengival',
      'dor_dente',
      'sensibilidade',
      'mau_halito',
      'usou_aparelho',
      'fio_dental',
      'diabetes_controlada',
    ]
    expect(semRegra.sort()).toEqual(esperadoSemRegra.sort())
  })
})
