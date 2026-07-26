import { formatarCpf } from './cpf'
import { erro } from './erros'

/**
 * Conteúdo dos impressos clínicos: atestado e receita.
 *
 * Puro e testado porque o que está escrito aqui tem consequência fora do
 * software. Três regras que não são de programação:
 *
 * 1. **CID só com autorização do paciente.** O código do diagnóstico é dado de
 *    saúde e o atestado costuma ir para o RH da empresa. Incluir CID sem
 *    autorização expressa é quebra de sigilo — o padrão é NÃO incluir. Quem
 *    precisa é o paciente, e ele decide.
 *
 * 2. **Atestado odontológico não afasta de tudo.** Ele declara o atendimento e,
 *    quando for o caso, o repouso. Fica no vocabulário do que o CD pode atestar:
 *    o atendimento que ele prestou.
 *
 * 3. **Receita precisa de dose, via e duração.** "Amoxicilina 500mg" não é
 *    receita: falta quantas, de quantas em quantas horas e por quantos dias. Sem
 *    isso a farmácia não dispensa e o paciente inventa.
 */

// ── Atestado ─────────────────────────────────────────────────────────────────

export interface DadosAtestado {
  readonly pacienteNome: string
  readonly pacienteCpf?: string | null
  readonly profissionalNome: string
  readonly cro: string
  readonly ufCro: string
  readonly clinicaNome: string
  readonly cidade: string
  /** Data do atendimento que está sendo atestado. */
  readonly atendidoEm: Date
  /** Dias de repouso, quando houver. Ausente = atestado de comparecimento. */
  readonly diasAfastamento?: number
  /** CID-10. Só entra no papel se `cidAutorizadoPeloPaciente` for verdadeiro. */
  readonly cid?: string | null
  readonly cidAutorizadoPeloPaciente?: boolean
  readonly observacao?: string | null
  readonly fuso?: string
}

export interface Impresso {
  readonly titulo: string
  /** Parágrafos do corpo, na ordem. */
  readonly paragrafos: readonly string[]
  /** Linhas do rodapé: local, data e identificação profissional. */
  readonly rodape: readonly string[]
  /** Avisos para a tela — não vão para o papel. */
  readonly avisos: readonly string[]
}

const CID_ODONTOLOGICO = /^K(0[0-9]|1[0-4])(\.\d)?$/

export function montarAtestado(d: DadosAtestado): Impresso {
  if (d.pacienteNome.trim().length === 0) {
    erro('PACIENTE_OBRIGATORIO', 'Atestado sem nome do paciente não vale nada.')
  }
  if (d.profissionalNome.trim().length === 0 || d.cro.trim().length === 0) {
    erro('PROFISSIONAL_OBRIGATORIO', 'Atestado exige nome e CRO do profissional.')
  }
  if (Number.isNaN(d.atendidoEm.getTime())) {
    erro('DATA_INVALIDA', 'Data de atendimento inválida.')
  }
  if (d.diasAfastamento !== undefined) {
    if (!Number.isInteger(d.diasAfastamento) || d.diasAfastamento < 1 || d.diasAfastamento > 90) {
      erro(
        'AFASTAMENTO_INVALIDO',
        `Dias de afastamento fora da faixa aceitável (1 a 90): ${d.diasAfastamento}.`,
        { diasAfastamento: d.diasAfastamento },
      )
    }
  }

  const avisos: string[] = []
  const cidLimpo = (d.cid ?? '').trim().toUpperCase()
  let cidNoPapel: string | null = null

  if (cidLimpo.length > 0) {
    if (!CID_ODONTOLOGICO.test(cidLimpo)) {
      erro(
        'CID_INVALIDO',
        `"${cidLimpo}" não é um CID-10 odontológico (K00 a K14). O CD atesta o que trata.`,
        { cid: cidLimpo },
      )
    }
    if (d.cidAutorizadoPeloPaciente === true) {
      cidNoPapel = cidLimpo
      avisos.push(
        'O CID vai impresso porque o paciente autorizou. Sem essa autorização, seria quebra de sigilo.',
      )
    } else {
      // Não é erro: é o comportamento correto por omissão.
      avisos.push(
        `O CID ${cidLimpo} NÃO foi impresso — falta autorização expressa do paciente. O atestado vale sem ele.`,
      )
    }
  }

  const dataAtendimento = dataLonga(d.atendidoEm, d.fuso)
  const paciente = d.pacienteNome.trim()
  const cpf = (d.pacienteCpf ?? '').replace(/\D/g, '')

  const paragrafos: string[] = []

  paragrafos.push(
    `Atesto, para os devidos fins, que ${paciente}${cpf.length === 11 ? `, CPF ${formatarCpf(cpf)}` : ''}, ` +
      `esteve sob meus cuidados profissionais em atendimento odontológico realizado no dia ${dataAtendimento}.`,
  )

  if (d.diasAfastamento !== undefined) {
    const dias = d.diasAfastamento
    paragrafos.push(
      `Em razão do tratamento realizado, recomendo o afastamento de suas atividades habituais ` +
        `por ${dias} (${numeroEmPalavras(dias)}) ${dias === 1 ? 'dia' : 'dias'}, a contar de ${dataCurta(d.atendidoEm, d.fuso)}.`,
    )
  }

  if (cidNoPapel) {
    paragrafos.push(`CID-10: ${cidNoPapel} (informado com autorização expressa do paciente).`)
  }

  if ((d.observacao ?? '').trim().length > 0) {
    paragrafos.push(d.observacao!.trim())
  }

  return {
    titulo: 'ATESTADO ODONTOLÓGICO',
    paragrafos,
    rodape: montarRodape(d),
    avisos,
  }
}

// ── Receita ──────────────────────────────────────────────────────────────────

export interface Medicamento {
  /** Princípio ativo e concentração. Ex.: 'Amoxicilina 500 mg'. */
  readonly nome: string
  /** Apresentação. Ex.: 'cápsulas', 'comprimidos', 'solução oral'. */
  readonly apresentacao?: string
  /** Quantidade a dispensar. Ex.: '21 cápsulas', '1 frasco'. */
  readonly quantidade: string
  /** Posologia completa: dose, via, intervalo e duração. */
  readonly posologia: string
}

export interface DadosReceita {
  readonly pacienteNome: string
  readonly pacienteCpf?: string | null
  readonly profissionalNome: string
  readonly cro: string
  readonly ufCro: string
  readonly clinicaNome: string
  readonly cidade: string
  readonly emitidaEm: Date
  readonly medicamentos: readonly Medicamento[]
  readonly orientacoes?: string | null
  readonly fuso?: string
}

/**
 * Termos que indicam medicamento sob controle especial (Portaria 344/98).
 *
 * Receita de controlado exige formulário próprio, numerado e em duas vias — não
 * é este papel. O sistema não bloqueia (o CD é quem sabe o que prescreve), mas
 * avisa, porque a farmácia recusaria e o paciente voltaria.
 */
const CONTROLADOS = [
  'diazepam',
  'midazolam',
  'alprazolam',
  'clonazepam',
  'codeina',
  'codeína',
  'tramadol',
  'morfina',
  'metilfenidato',
  'fenobarbital',
  'zolpidem',
  'petidina',
  'oxicodona',
]

export function montarReceita(d: DadosReceita): Impresso {
  if (d.pacienteNome.trim().length === 0) {
    erro('PACIENTE_OBRIGATORIO', 'Receita sem nome do paciente não pode ser dispensada.')
  }
  if (d.profissionalNome.trim().length === 0 || d.cro.trim().length === 0) {
    erro('PROFISSIONAL_OBRIGATORIO', 'Receita exige nome e CRO do profissional.')
  }
  if (d.medicamentos.length === 0) {
    erro('SEM_MEDICAMENTO', 'Receita sem medicamento não existe.')
  }
  if (d.medicamentos.length > 10) {
    erro('MUITOS_MEDICAMENTOS', 'Mais de 10 itens numa receita: revise antes de emitir.')
  }

  const avisos: string[] = []
  const paragrafos: string[] = []

  d.medicamentos.forEach((m, i) => {
    const nome = m.nome.trim()
    if (nome.length === 0) erro('MEDICAMENTO_SEM_NOME', `Item ${i + 1} da receita está sem nome.`)

    const quantidade = m.quantidade.trim()
    if (quantidade.length === 0) {
      erro(
        'MEDICAMENTO_SEM_QUANTIDADE',
        `"${nome}" está sem quantidade — a farmácia precisa saber quanto dispensar.`,
        { item: i + 1 },
      )
    }

    const posologia = m.posologia.trim()
    if (posologia.length < 5) {
      erro(
        'POSOLOGIA_INCOMPLETA',
        `"${nome}" está sem posologia. Diga a dose, o intervalo e por quantos dias.`,
        { item: i + 1 },
      )
    }

    const apresentacao = (m.apresentacao ?? '').trim()
    paragrafos.push(
      `${i + 1}. ${nome}${apresentacao ? ` — ${apresentacao}` : ''} .......... ${quantidade}`,
    )
    paragrafos.push(`    ${posologia}`)

    const emMinusculas = nome.toLowerCase()
    if (CONTROLADOS.some((c) => emMinusculas.includes(c))) {
      avisos.push(
        `"${nome}" parece ser medicamento de controle especial (Portaria 344/98). ` +
          'Esse tipo exige receituário próprio, numerado e em duas vias — não este impresso.',
      )
    }
  })

  if ((d.orientacoes ?? '').trim().length > 0) {
    paragrafos.push('')
    paragrafos.push(`Orientações: ${d.orientacoes!.trim()}`)
  }

  return {
    titulo: 'RECEITUÁRIO ODONTOLÓGICO',
    paragrafos,
    rodape: montarRodape({ ...d, atendidoEm: d.emitidaEm }),
    avisos,
  }
}

// ── Comum ────────────────────────────────────────────────────────────────────

function montarRodape(d: {
  cidade: string
  profissionalNome: string
  cro: string
  ufCro: string
  atendidoEm: Date
  fuso?: string
}): readonly string[] {
  // A data do rodapé é a da EMISSÃO — hoje —, não a do atendimento. Um atestado
  // reimpresso semanas depois continua atestando o mesmo atendimento.
  return [
    `${d.cidade.trim()}, ${dataLonga(new Date(), d.fuso)}.`,
    '',
    '_______________________________________',
    d.profissionalNome.trim(),
    `CRO ${d.ufCro.trim().toUpperCase()} ${d.cro.trim()}`,
  ]
}

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const

/** 'em 26 de julho de 2026' — como se escreve em documento. */
export function dataLonga(d: Date, fuso = 'America/Sao_Paulo'): string {
  const p = partes(d, fuso)
  return `${p.dia} de ${MESES[p.mes - 1]} de ${p.ano}`
}

export function dataCurta(d: Date, fuso = 'America/Sao_Paulo'): string {
  const p = partes(d, fuso)
  return `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}/${p.ano}`
}

function partes(d: Date, fuso: string): { dia: number; mes: number; ano: number } {
  if (Number.isNaN(d.getTime())) erro('DATA_INVALIDA', 'Data inválida no impresso.')
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [ano, mes, dia] = f.format(d).split('-').map(Number)
  return { dia: dia!, mes: mes!, ano: ano! }
}

const PALAVRAS = [
  'zero',
  'um',
  'dois',
  'três',
  'quatro',
  'cinco',
  'seis',
  'sete',
  'oito',
  'nove',
  'dez',
  'onze',
  'doze',
  'treze',
  'quatorze',
  'quinze',
  'dezesseis',
  'dezessete',
  'dezoito',
  'dezenove',
  'vinte',
] as const

/**
 * Número em palavras, para o atestado.
 *
 * Documento com prazo escreve o número duas vezes — "3 (três) dias" — porque
 * dígito sozinho se altera com uma canetada.
 */
export function numeroEmPalavras(n: number): string {
  if (!Number.isInteger(n) || n < 0) erro('NUMERO_INVALIDO', `Número inválido: ${n}.`)
  if (n <= 20) return PALAVRAS[n]!
  if (n <= 90 && n % 10 === 0) {
    const dezenas: Record<number, string> = {
      30: 'trinta',
      40: 'quarenta',
      50: 'cinquenta',
      60: 'sessenta',
      70: 'setenta',
      80: 'oitenta',
      90: 'noventa',
    }
    return dezenas[n]!
  }
  if (n < 100) {
    const dezena = Math.floor(n / 10) * 10
    return `${numeroEmPalavras(dezena)} e ${PALAVRAS[n % 10]}`
  }
  return String(n)
}
