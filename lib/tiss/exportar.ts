import { createHash } from 'node:crypto'

/**
 * Exportação da guia para a operadora.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  O QUE ESTÁ PROVADO E O QUE NÃO ESTÁ
 *
 *  ✅ **O XML valida contra o XSD oficial da ANS**, versão 3.05.00, baixado de
 *     `http://www.ans.gov.br/padroes/tiss/schemas/` e versionado em
 *     `dados/tiss-xsd-3.05.00/` com procedência e hashes. Rode
 *     `npm run tiss:validar` — ele valida e **prova que reprova** documento
 *     quebrado, senão "validou" não significaria nada.
 *
 *  ⚠️ **Validar contra o XSD não é ser aceito pela operadora.** São duas coisas
 *     diferentes, e a segunda continua não verificada:
 *
 *      - o XSD confere ESTRUTURA (ordem, tipo, obrigatoriedade, domínio). Ele não
 *        sabe se o `codigoProcedimento` corresponde ao que foi feito, se o valor
 *        está na tabela negociada, nem se a operadora aceita aquele lote;
 *      - cada operadora acrescenta regras próprias fora do XSD, e algumas exigem
 *        assinatura digital (`assinaturaDigitalGuia`, que **não emitimos**);
 *      - cada operadora aceita um conjunto próprio de versões do padrão.
 *
 *  Consequência prática: o caminho que fatura hoje continua sendo a
 *  `folhaDeConferencia`, que a recepção digita no portal da operadora. O XML deixou
 *  de ser "estrutura plausível" e passou a ser "estrutura conferida contra o
 *  schema oficial" — o que é um degrau real, e não o último.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Tipo de atendimento odontológico — `dm_tipoAtendimentoOdonto` do XSD.
 *
 * Os significados vêm de um comentário DENTRO do próprio schema da ANS, não de
 * dedução nossa. Guardo aqui porque escolher errado é glosa, e o número sozinho
 * não diz nada a quem lê o código depois.
 */
export const TIPO_ATENDIMENTO = {
  tratamento: '1',
  exameRadiologico: '2',
  ortodontia: '3',
  urgencia: '4',
  auditoria: '5',
} as const
export type TipoAtendimentoOdonto = (typeof TIPO_ATENDIMENTO)[keyof typeof TIPO_ATENDIMENTO]

/** `dm_tipoFaturamentoOdonto`: 1 parcial, 4 total. Também documentado no XSD. */
export const TIPO_FATURAMENTO = { parcial: '1', total: '4' } as const
export type TipoFaturamentoOdonto = (typeof TIPO_FATURAMENTO)[keyof typeof TIPO_FATURAMENTO]

/**
 * Tabela do código do procedimento — `dm_tabela`. **22** é a única correta aqui:
 * o comentário do XSD a descreve como "TUSS — Procedimentos e eventos em saúde
 * (medicina, odonto e demais áreas)", e é dela que sai `dados/tuss22-odontologia.csv`.
 */
const CODIGO_TABELA_TUSS = '22'

/**
 * Dados de cadastro que o XSD exige e que **não estão no banco hoje**.
 *
 * Não são detalhe de formato: são campos obrigatórios (`minOccurs` implícito 1) de
 * `cto_guiaOdontologia`. Sem eles não existe XML válido — e é por isso que estão
 * aqui como tipo, e não com um valor inventado como padrão:
 *
 *  - `codigoPrestadorNaOperadora` — o código que a operadora dá à clínica no
 *    contrato. Cada operadora tem o seu; não há como derivar.
 *  - `cnes` — Cadastro Nacional de Estabelecimentos de Saúde da clínica.
 *  - `cbos` — ocupação do profissional (a faixa 2232xx é cirurgião-dentista).
 *  - `planoBeneficiario` — nome do plano do paciente, que vem da carteirinha.
 *
 * Preencher qualquer um deles com um valor plausível seria o mesmo erro que
 * inventar código TUSS: passa no schema e volta como glosa semanas depois. Falta
 * coluna no cadastro da clínica, do convênio e da carteirinha — está anotado no
 * relatório da fase; até então `conferirAntesDeEnviar` acusa o que falta.
 */
export interface CadastroParaTiss {
  readonly codigoPrestadorNaOperadora: string | null
  readonly cnes: string | null
  readonly cbos: string | null
  readonly planoBeneficiario: string | null
  readonly tipoAtendimento: TipoAtendimentoOdonto
  readonly tipoFaturamento: TipoFaturamentoOdonto
  /**
   * Atendimento a recém-nascido usando a carteirinha da mãe (`dm_simNao`).
   * Obrigatório no XSD, e o padrão do caso comum é 'N'.
   */
  readonly atendimentoRecemNascido: 'S' | 'N'
}

export interface DadosGuiaParaExportar {
  readonly numero: string
  readonly registroAns: string | null
  readonly convenioNome: string
  readonly numeroLote: string | null
  readonly pacienteNome: string
  readonly pacienteCpf: string | null
  readonly pacienteNascimento: string
  readonly numeroCarteirinha: string
  readonly profissionalNome: string
  readonly cro: string
  readonly ufCro: string
  readonly clinicaNome: string
  readonly clinicaCnpj: string | null
  readonly emitidaEm: Date
  readonly valorApresentado: string
  /** Ver `CadastroParaTiss`. Ausente enquanto o cadastro não tiver os campos. */
  readonly cadastro?: CadastroParaTiss
  readonly itens: readonly {
    readonly codigoTuss: string | null
    readonly descricao: string
    readonly denteFdi: number | null
    readonly faces: string | null
    readonly quantidade: number
    readonly dataExecucao: string
    readonly valorApresentado: string
  }[]
}

// ── Folha de conferência ─────────────────────────────────────────────────────

/**
 * Folha de conferência, em texto.
 *
 * É o artefato que a clínica realmente usa: a recepção abre o portal da operadora
 * e digita a partir daqui, ou imprime e confere item por item antes de enviar. Cada
 * linha traz o que os campos obrigatórios da guia pedem, na ordem em que os portais
 * costumam apresentar.
 *
 * Item **sem código TUSS** aparece marcado com `!!`, porque é o que vai ser glosado
 * na entrada — melhor descobrir na conferência que no demonstrativo.
 */
export function folhaDeConferencia(g: DadosGuiaParaExportar): string {
  const linhas: string[] = []
  const risco = '='.repeat(76)

  linhas.push(risco)
  linhas.push(`GUIA ${g.numero}  ·  ${g.convenioNome}`)
  if (g.registroAns) linhas.push(`Registro ANS: ${g.registroAns}`)
  if (g.numeroLote) linhas.push(`Lote: ${g.numeroLote}`)
  linhas.push(risco)
  linhas.push('')

  linhas.push('BENEFICIÁRIO')
  linhas.push(`  Nome ............. ${g.pacienteNome}`)
  linhas.push(`  Carteirinha ...... ${g.numeroCarteirinha}`)
  linhas.push(`  Nascimento ....... ${formatarBr(g.pacienteNascimento)}`)
  if (g.pacienteCpf) linhas.push(`  CPF .............. ${g.pacienteCpf}`)
  linhas.push('')

  linhas.push('CONTRATADO')
  linhas.push(`  Clínica .......... ${g.clinicaNome}`)
  if (g.clinicaCnpj) linhas.push(`  CNPJ ............. ${g.clinicaCnpj}`)
  linhas.push('')

  linhas.push('PROFISSIONAL EXECUTANTE')
  linhas.push(`  Nome ............. ${g.profissionalNome}`)
  // Maiúscula aqui também, não só no XML: é esta folha que a recepção digita no
  // portal da operadora, e "sp" digitado é campo recusado.
  linhas.push(`  CRO .............. ${g.ufCro.toUpperCase()} ${g.cro}`)
  linhas.push('')

  linhas.push('PROCEDIMENTOS')
  linhas.push('  TUSS       Data        Dente  Faces          Qtd  Valor        Descrição')
  linhas.push(`  ${'-'.repeat(72)}`)

  let semTuss = 0
  for (const i of g.itens) {
    if (!i.codigoTuss) semTuss++
    const tuss = (i.codigoTuss ?? '!! SEM TUSS').padEnd(10)
    const data = formatarBr(i.dataExecucao).padEnd(11)
    const dente = (i.denteFdi ? String(i.denteFdi) : '—').padEnd(6)
    const faces = (i.faces ?? '—').slice(0, 14).padEnd(14)
    const qtd = String(i.quantidade).padStart(3)
    const valor = `R$ ${i.valorApresentado}`.padEnd(12)
    linhas.push(`  ${tuss} ${data} ${dente} ${faces} ${qtd}  ${valor} ${i.descricao}`)
  }

  linhas.push(`  ${'-'.repeat(72)}`)
  linhas.push(`  ${' '.repeat(50)}TOTAL: R$ ${g.valorApresentado}`)
  linhas.push('')

  if (semTuss > 0) {
    linhas.push('⚠ ATENÇÃO')
    linhas.push(
      `  ${semTuss} procedimento(s) sem código TUSS. A operadora glosa item sem código na`,
    )
    linhas.push('  entrada. Importe a Tabela 22 da ANS antes de faturar (ver README).')
    linhas.push('')
  }

  linhas.push(`Emitida em ${g.emitidaEm.toLocaleString('pt-BR')}`)
  linhas.push(risco)

  return linhas.join('\n')
}

// ── XML TISS ─────────────────────────────────────────────────────────────────

/** Versão do padrão declarada no XML. Cada operadora aceita um conjunto. */
export const VERSAO_TISS = '3.05.00'

function esc(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * UF em código IBGE, que é o que `dm_UF` do XSD aceita.
 *
 * **O padrão não usa sigla.** `dm_UF` enumera 11…53 (mais `2` e `98`), e um `<ans:UF>SP</ans:UF>`
 * é recusado pelo schema — foi um dos erros que a validação encontrou. A sigla
 * continua sendo o que a clínica digita e o que a folha de conferência mostra; a
 * tradução acontece só na fronteira do XML.
 */
const UF_IBGE: Readonly<Record<string, string>> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
}

/**
 * Faces em código curto, porque `denteFace` é `st_texto5` — cinco caracteres.
 *
 * "oclusal e mesial" tem 16 e era recusado pelo schema. O XSD **não enumera** os
 * códigos (é texto livre), então a convenção usada aqui é a inicial de cada face,
 * que é a praticada nos portais. ⚠️ Como não vem do padrão, é o tipo de campo que
 * uma operadora específica pode querer diferente — se aparecer glosa de face, é
 * aqui que se olha.
 */
const FACE_INICIAL: Readonly<Record<string, string>> = {
  mesial: 'M', distal: 'D', vestibular: 'V', lingual: 'L',
  palatina: 'P', oclusal: 'O', incisal: 'I', cervical: 'C',
}

function facesParaCodigo(faces: string): string {
  const achadas = Object.keys(FACE_INICIAL)
    .filter((nome) => faces.toLowerCase().includes(nome))
    .map((nome) => FACE_INICIAL[nome])
  return achadas.join('').slice(0, 5)
}

/** `HH:MM:SS` — `st_hora` é `xs:time`, e o campo é obrigatório no cabeçalho. */
function hora(d: Date): string {
  return d.toISOString().slice(11, 19)
}

/**
 * XML da Guia de Tratamento Odontológico, na estrutura de `cto_guiaOdontologia`.
 *
 * **A ordem dos elementos não é estilo: é requisito.** O XSD usa `xs:sequence` em
 * toda a árvore, então trocar dois elementos de lugar torna o documento inválido —
 * e é o erro mais fácil de cometer editando esta função. Se você mexer aqui, rode
 * `npm run tiss:validar`.
 *
 * O `hash` do epílogo é MD5 do conteúdo da mensagem sem o próprio epílogo. MD5 aqui
 * não é escolha de segurança: é o que o padrão manda, como dígito verificador de
 * transmissão. Onde MD5 seria inadequado — senha, integridade de arquivo — o
 * projeto usa scrypt e SHA-256.
 *
 * **Estoura quando falta cadastro obrigatório**, em vez de emitir XML inválido. Ver
 * `CadastroParaTiss`: gerar um documento que a operadora vai recusar é pior que
 * falhar aqui, porque a recusa chega semanas depois e sem dizer o motivo.
 */
export function xmlGuiaOdontologica(g: DadosGuiaParaExportar): string {
  const c = g.cadastro
  const faltando = !c
    ? ['cadastro TISS (código na operadora, CNES, CBOS, plano)']
    : [
        !g.registroAns && 'registro ANS do convênio',
        !g.clinicaCnpj && 'CNPJ da clínica',
        !c.codigoPrestadorNaOperadora && 'código do prestador na operadora',
        !c.cnes && 'CNES da clínica',
        !c.cbos && 'CBOS do profissional',
        !c.planoBeneficiario && 'plano do beneficiário',
      ].filter((x): x is string => typeof x === 'string')

  if (faltando.length > 0 || !c) {
    throw new Error(
      `Não é possível gerar o XML TISS: falta ${faltando.join(', ')}. ` +
        'Use folhaDeConferencia() enquanto o cadastro não estiver completo — ' +
        'XML com campo inventado passa no schema e volta como glosa.',
    )
  }

  const ufExec = UF_IBGE[g.ufCro.toUpperCase()]
  if (!ufExec) {
    throw new Error(`UF "${g.ufCro}" não tem código IBGE — dm_UF do TISS não aceita sigla.`)
  }

  const corpo = [
    `  <ans:prestadorParaOperadora>`,
    `    <ans:loteGuias>`,
    // st_texto12: o lote é o número da guia quando não há lote aberto.
    `      <ans:numeroLote>${esc((g.numeroLote ?? g.numero).slice(0, 12))}</ans:numeroLote>`,
    `      <ans:guiasTISS>`,
    `        <ans:guiaOdonto>`,
    // A ordem daqui para baixo é a de `cto_guiaOdontologia`. Não reordene.
    `          <ans:registroANS>${esc(g.registroAns)}</ans:registroANS>`,
    `          <ans:numeroGuiaPrestador>${esc(g.numero)}</ans:numeroGuiaPrestador>`,
    `          <ans:dadosBeneficiario>`,
    `            <ans:numeroCarteira>${esc(g.numeroCarteirinha)}</ans:numeroCarteira>`,
    `            <ans:atendimentoRN>${esc(c.atendimentoRecemNascido)}</ans:atendimentoRN>`,
    `            <ans:nomeBeneficiario>${esc(g.pacienteNome)}</ans:nomeBeneficiario>`,
    `          </ans:dadosBeneficiario>`,
    `          <ans:planoBeneficiario>${esc(c.planoBeneficiario)}</ans:planoBeneficiario>`,
    `          <ans:dadosProfissionaisResponsaveis>`,
    `            <ans:codigoProfExec>${esc(c.codigoPrestadorNaOperadora)}</ans:codigoProfExec>`,
    `            <ans:nomeProfExec>${esc(g.profissionalNome)}</ans:nomeProfExec>`,
    `            <ans:croExec>${esc(g.cro)}</ans:croExec>`,
    `            <ans:ufExec>${ufExec}</ans:ufExec>`,
    `            <ans:cnesExec>${esc(c.cnes)}</ans:cnesExec>`,
    // `cbosExec2` é obrigatório no XSD 3.05.00 embora `nomeProfExec2` seja opcional.
    // Parece descuido do schema, mas o schema é a autoridade: sem ele não valida.
    `            <ans:cbosExec2>${esc(c.cbos)}</ans:cbosExec2>`,
    `          </ans:dadosProfissionaisResponsaveis>`,
    // `procedimentosExecutados` é o elemento REPETIDO (maxOccurs unbounded), não um
    // container com filhos. A versão anterior o usava como invólucro — invalidez
    // estrutural que só o XSD revela.
    ...g.itens.flatMap((i, indice) => {
      const face = i.faces ? facesParaCodigo(i.faces) : ''
      return [
        `          <ans:procedimentosExecutados>`,
        `            <ans:sequencialItem>${indice + 1}</ans:sequencialItem>`,
        `            <ans:procSolic>`,
        `              <ans:codigoTabela>${CODIGO_TABELA_TUSS}</ans:codigoTabela>`,
        `              <ans:codigoProcedimento>${esc(i.codigoTuss)}</ans:codigoProcedimento>`,
        `              <ans:descricaoProcedimento>${esc(i.descricao.slice(0, 150))}</ans:descricaoProcedimento>`,
        `            </ans:procSolic>`,
        ...(i.denteFdi
          ? [
              `            <ans:denteRegiao>`,
              `              <ans:codDente>${esc(i.denteFdi)}</ans:codDente>`,
              `            </ans:denteRegiao>`,
            ]
          : []),
        ...(face ? [`            <ans:denteFace>${esc(face)}</ans:denteFace>`] : []),
        `            <ans:qtdProc>${esc(i.quantidade)}</ans:qtdProc>`,
        `            <ans:valorProc>${esc(i.valorApresentado)}</ans:valorProc>`,
        // `autorizado` é `xs:boolean`. Item que a clínica está apresentando para
        // pagamento vai como executado e autorizado; glosa é decisão da operadora,
        // não declaração nossa.
        `            <ans:autorizado>true</ans:autorizado>`,
        `            <ans:dataRealizacao>${esc(i.dataExecucao)}</ans:dataRealizacao>`,
        `          </ans:procedimentosExecutados>`,
      ]
    }),
    `          <ans:tipoAtendimento>${esc(c.tipoAtendimento)}</ans:tipoAtendimento>`,
    `          <ans:tipoFaturamento>${esc(c.tipoFaturamento)}</ans:tipoFaturamento>`,
    `          <ans:valorTotalProc>${esc(g.valorApresentado)}</ans:valorTotalProc>`,
    `        </ans:guiaOdonto>`,
    `      </ans:guiasTISS>`,
    `    </ans:loteGuias>`,
    `  </ans:prestadorParaOperadora>`,
  ].join('\n')

  // O epílogo carrega o hash do conteúdo. Calculado ANTES de o epílogo existir,
  // como o padrão define — incluir o próprio hash no cálculo seria circular.
  const hash = createHash('md5').update(corpo, 'utf8').digest('hex')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ans:mensagemTISS xmlns:ans="http://www.ans.gov.br/padroes/tiss/schemas">',
    `  <ans:cabecalho>`,
    `    <ans:identificacaoTransacao>`,
    `      <ans:tipoTransacao>ENVIO_LOTE_GUIAS</ans:tipoTransacao>`,
    `      <ans:sequencialTransacao>${esc(g.numero.slice(0, 12))}</ans:sequencialTransacao>`,
    `      <ans:dataRegistroTransacao>${g.emitidaEm.toISOString().slice(0, 10)}</ans:dataRegistroTransacao>`,
    // Obrigatório e faltava por completo.
    `      <ans:horaRegistroTransacao>${hora(g.emitidaEm)}</ans:horaRegistroTransacao>`,
    `    </ans:identificacaoTransacao>`,
    // `origem`/`destino` são obrigatórios e faltavam. Prestador → operadora: a
    // origem se identifica pelo CNPJ, o destino pelo registro ANS.
    `    <ans:origem>`,
    `      <ans:identificacaoPrestador>`,
    `        <ans:CNPJ>${esc(g.clinicaCnpj)}</ans:CNPJ>`,
    `      </ans:identificacaoPrestador>`,
    `    </ans:origem>`,
    `    <ans:destino>`,
    `      <ans:registroANS>${esc(g.registroAns)}</ans:registroANS>`,
    `    </ans:destino>`,
    // O elemento chama `Padrao`, com maiúscula, não `versaoPadrao`.
    `    <ans:Padrao>${VERSAO_TISS}</ans:Padrao>`,
    `  </ans:cabecalho>`,
    corpo,
    `  <ans:epilogo>`,
    `    <ans:hash>${hash}</ans:hash>`,
    `  </ans:epilogo>`,
    '</ans:mensagemTISS>',
  ].join('\n')
}

/**
 * Problemas que impedem faturar, encontrados antes de exportar.
 *
 * Rodar isto antes de enviar é mais barato que descobrir no demonstrativo um mês
 * depois. Devolve lista vazia quando está tudo pronto.
 */
export function conferirAntesDeEnviar(g: DadosGuiaParaExportar): readonly string[] {
  const problemas: string[] = []

  if (!g.registroAns) {
    problemas.push('O convênio está sem registro ANS. A guia é rejeitada sem ele.')
  }
  if (!g.clinicaCnpj) {
    problemas.push('A clínica está sem CNPJ cadastrado (Configurações).')
  }
  if (g.itens.length === 0) {
    problemas.push('A guia não tem procedimento.')
  }

  const semTuss = g.itens.filter((i) => !i.codigoTuss).length
  if (semTuss > 0) {
    problemas.push(
      `${semTuss} procedimento(s) sem código TUSS. Importe a Tabela 22 da ANS — código inventado gera glosa.`,
    )
  }

  const semData = g.itens.filter((i) => !i.dataExecucao).length
  if (semData > 0) problemas.push(`${semData} procedimento(s) sem data de execução.`)

  /**
   * Cadastro que o XSD exige e que o banco ainda não guarda.
   *
   * Aparece como pendência aqui — e não como campo preenchido com um valor
   * plausível — pelo mesmo motivo dos 13 códigos TUSS em branco: dado inventado
   * passa no schema e volta como glosa semanas depois, sem dizer o motivo.
   *
   * Enquanto isto estiver na lista, o caminho é a `folhaDeConferencia`. O XML só
   * sai completo quando a clínica cadastrar estes campos.
   */
  const c = g.cadastro
  if (!c) {
    problemas.push(
      'Falta o cadastro TISS (código do prestador na operadora, CNES, CBOS, plano do ' +
        'beneficiário). Sem ele o XML não é válido — use a folha de conferência.',
    )
  } else {
    if (!c.codigoPrestadorNaOperadora) {
      problemas.push('Falta o código do prestador na operadora (vem do contrato com ela).')
    }
    if (!c.cnes) problemas.push('Falta o CNES da clínica.')
    if (!c.cbos) problemas.push('Falta o CBOS do profissional (cirurgião-dentista: faixa 2232xx).')
    if (!c.planoBeneficiario) problemas.push('Falta o nome do plano do beneficiário (carteirinha).')
  }

  if (!UF_IBGE[g.ufCro.toUpperCase()]) {
    problemas.push(`UF do CRO ("${g.ufCro}") não é uma sigla reconhecida.`)
  }

  const somaItens = g.itens.reduce((acc, i) => acc + Math.round(Number(i.valorApresentado) * 100), 0)
  const total = Math.round(Number(g.valorApresentado) * 100)
  if (somaItens !== total) {
    problemas.push(
      `A soma dos itens (${(somaItens / 100).toFixed(2)}) não fecha com o total da guia (${g.valorApresentado}).`,
    )
  }

  return problemas
}

function formatarBr(iso: string): string {
  return iso.split('-').reverse().join('/')
}
