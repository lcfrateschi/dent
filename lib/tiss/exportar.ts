import { createHash } from 'node:crypto'

/**
 * Exportação da guia para a operadora.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ⚠️  LEIA ANTES DE USAR O XML EM PRODUÇÃO
 *
 *  O XML abaixo segue a **estrutura publicada do padrão TISS**, mas:
 *
 *   - **nunca foi validado contra o XSD oficial da ANS** (não temos o arquivo);
 *   - **nunca foi enviado a uma operadora real**;
 *   - a versão do padrão muda (3.05.00, 4.01.00…) e cada operadora aceita um
 *     conjunto próprio de versões;
 *   - **`codigo_tuss` está nulo** enquanto a Tabela 22 da ANS não for importada, e
 *     guia sem código TUSS é glosada na entrada.
 *
 *  Consequência prática: **não conte com o XML para faturar**. O caminho que
 *  funciona hoje é a `folhaDeConferencia`, que a recepção usa para digitar no
 *  portal da operadora — que é como a maioria das clínicas pequenas fatura de
 *  verdade. O XML fica aqui pronto para ser conferido quando houver o XSD e uma
 *  operadora para testar.
 *
 *  Isso não é ressalva de rodapé: é a diferença entre "o módulo está pronto" e
 *  "o módulo fatura". O que está pronto e verificado é o controle interno —
 *  guia, glosa, recurso e conciliação.
 * ══════════════════════════════════════════════════════════════════════════
 */

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
 * XML no formato de Guia de Tratamento Odontológico.
 *
 * ⚠️ **Estruturalmente completo, funcionalmente não verificado.** Ver o aviso no
 * topo do arquivo. O que dá para afirmar: é XML bem formado, com escape correto, e
 * o hash do epílogo é calculado sobre o conteúdo — que é a parte que o padrão
 * especifica de forma verificável.
 *
 * O `hash` do epílogo TISS é definido como MD5 do conteúdo da mensagem sem o
 * próprio epílogo. MD5 aqui não é escolha de segurança: é o que o padrão manda, e
 * serve de dígito verificador de transmissão. Onde MD5 seria inadequado — senha,
 * integridade de arquivo — o projeto usa scrypt e SHA-256.
 */
export function xmlGuiaOdontologica(g: DadosGuiaParaExportar): string {
  const corpo = [
    `  <ans:prestadorParaOperadora>`,
    `    <ans:loteGuias>`,
    `      <ans:numeroLote>${esc(g.numeroLote ?? g.numero)}</ans:numeroLote>`,
    `      <ans:guiasTISS>`,
    `        <ans:guiaOdonto>`,
    `          <ans:cabecalhoGuia>`,
    `            <ans:registroANS>${esc(g.registroAns)}</ans:registroANS>`,
    `            <ans:numeroGuiaPrestador>${esc(g.numero)}</ans:numeroGuiaPrestador>`,
    `          </ans:cabecalhoGuia>`,
    `          <ans:dadosBeneficiario>`,
    `            <ans:numeroCarteira>${esc(g.numeroCarteirinha)}</ans:numeroCarteira>`,
    `            <ans:nomeBeneficiario>${esc(g.pacienteNome)}</ans:nomeBeneficiario>`,
    ...(g.pacienteCpf ? [`            <ans:cpfBeneficiario>${esc(g.pacienteCpf)}</ans:cpfBeneficiario>`] : []),
    `          </ans:dadosBeneficiario>`,
    `          <ans:dadosContratado>`,
    ...(g.clinicaCnpj ? [`            <ans:cnpjContratado>${esc(g.clinicaCnpj)}</ans:cnpjContratado>`] : []),
    `            <ans:nomeContratado>${esc(g.clinicaNome)}</ans:nomeContratado>`,
    `          </ans:dadosContratado>`,
    `          <ans:profissionalExecutante>`,
    `            <ans:nomeProfissional>${esc(g.profissionalNome)}</ans:nomeProfissional>`,
    `            <ans:conselhoProfissional>CRO</ans:conselhoProfissional>`,
    `            <ans:numeroConselhoProfissional>${esc(g.cro)}</ans:numeroConselhoProfissional>`,
    `            <ans:UF>${esc(g.ufCro.toUpperCase())}</ans:UF>`,
    `          </ans:profissionalExecutante>`,
    `          <ans:procedimentosExecutados>`,
    ...g.itens.flatMap((i) => [
      `            <ans:procedimentoExecutado>`,
      `              <ans:dataExecucao>${esc(i.dataExecucao)}</ans:dataExecucao>`,
      `              <ans:procedimento>`,
      `                <ans:codigoProcedimento>${esc(i.codigoTuss)}</ans:codigoProcedimento>`,
      `                <ans:descricaoProcedimento>${esc(i.descricao)}</ans:descricaoProcedimento>`,
      `              </ans:procedimento>`,
      ...(i.denteFdi ? [`              <ans:denteRegiao>${esc(i.denteFdi)}</ans:denteRegiao>`] : []),
      ...(i.faces ? [`              <ans:face>${esc(i.faces)}</ans:face>`] : []),
      `              <ans:quantidade>${esc(i.quantidade)}</ans:quantidade>`,
      `              <ans:valorProcedimento>${esc(i.valorApresentado)}</ans:valorProcedimento>`,
      `            </ans:procedimentoExecutado>`,
    ]),
    `          </ans:procedimentosExecutados>`,
    `          <ans:valorTotal>${esc(g.valorApresentado)}</ans:valorTotal>`,
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
    `      <ans:sequencialTransacao>${esc(g.numero)}</ans:sequencialTransacao>`,
    `      <ans:dataRegistroTransacao>${g.emitidaEm.toISOString().slice(0, 10)}</ans:dataRegistroTransacao>`,
    `    </ans:identificacaoTransacao>`,
    `    <ans:versaoPadrao>${VERSAO_TISS}</ans:versaoPadrao>`,
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
