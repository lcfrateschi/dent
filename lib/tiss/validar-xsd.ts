import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TIPO_ATENDIMENTO,
  TIPO_FATURAMENTO,
  VERSAO_TISS,
  xmlGuiaOdontologica,
  type DadosGuiaParaExportar,
} from './exportar'

/**
 * Valida o XML TISS que o sistema gera contra o **XSD oficial da ANS**.
 *
 *   npm run tiss:validar
 *
 * ── Por que este script existe ──────────────────────────────────────────────
 * Durante quatro fases o `CLAUDE.md` dizia, com estas palavras: *"O XML TISS NUNCA
 * foi validado contra o XSD da ANS"*. Era XML bem formado, e isso era tudo o que se
 * podia afirmar. Quando o XSD foi finalmente carregado, a estrutura estava **errada
 * em seis pontos** — nenhum deles visível a um parser, todos fatais para a operadora.
 *
 * Então isto não é teste de regressão de rotina: é a única coisa entre "editei o
 * gerador" e "a operadora recusou o lote seis semanas depois, sem dizer por quê".
 *
 * ── A parte que dá valor ao resto ───────────────────────────────────────────
 * O script **não se limita a validar**. Ele quebra o documento de seis maneiras e
 * exige que o validador **reprove** cada uma. Sem isso, "validou" não significa
 * nada: um `schemaLocation` errado, um import silenciosamente não resolvido, e o
 * validador diz `VALIDO` para qualquer coisa. Já vi uma dessas seis contraprovas
 * passar **vacuamente** aqui — o texto que ela substituía não existia no documento,
 * então ela validava o original e dava verde. Daí cada caso conferir que o alvo da
 * substituição existe antes de testar.
 *
 * ── Onde este script roda ───────────────────────────────────────────────────
 * **No HOST, não no container.** Ele usa `lxml` (Python), que é libxml2 — o mesmo
 * motor do `xmllint`:
 *
 *   npm run tiss:validar
 *
 * O container `app` **não tem `python3`** (conferido), e o host tem `lxml` mas não
 * `libxml2-utils`. Acrescentar qualquer um dos dois ao Dockerfile por causa de um
 * script de conferência é peso permanente na imagem de produção para algo que roda
 * quando alguém edita o gerador — o que é raro.
 *
 * A contrapartida honesta: **isto não roda em CI dentro do container**. Se um dia
 * precisar, o caminho é um estágio próprio no Dockerfile (não o de produção) ou uma
 * imagem só de verificação. Enquanto isso, é responsabilidade de quem edita
 * `exportar.ts` rodar no host — e o comentário no topo daquele arquivo pede isso.
 *
 * Se faltar `lxml`: `pip install lxml` ou `apt install python3-lxml`.
 */

const XSD = 'dados/tiss-xsd-3.05.00/tissV3_05_00.xsd'

/** Uma guia completa, com todos os campos que o XSD exige. */
const GUIA: DadosGuiaParaExportar = {
  numero: '1042',
  registroAns: '123456',
  convenioNome: 'Odonto Exemplo',
  numeroLote: 'LOTE-2026-07',
  pacienteNome: 'Joana Pereira da Silva',
  pacienteCpf: '52998224725',
  pacienteNascimento: '1988-03-12',
  numeroCarteirinha: 'CART-99887',
  profissionalNome: 'Dra. Helena Marques',
  cro: '54321',
  // Sigla de propósito: é o que a clínica cadastra. A tradução para o código IBGE
  // que o `dm_UF` exige acontece dentro do gerador — e é um dos seis bugs que a
  // validação encontrou.
  ufCro: 'sp',
  clinicaNome: 'Clínica Sorriso',
  clinicaCnpj: '12345678000199',
  emitidaEm: new Date('2026-07-26T13:00:00Z'),
  valorApresentado: '280.00',
  cadastro: {
    codigoPrestadorNaOperadora: 'PREST-00042',
    cnes: '1234567',
    // 223208 é cirurgião-dentista clínico geral, da faixa 2232xx que o dm_CBOS traz.
    cbos: '223208',
    planoBeneficiario: 'Odonto Pleno',
    tipoAtendimento: TIPO_ATENDIMENTO.tratamento,
    tipoFaturamento: TIPO_FATURAMENTO.total,
    atendimentoRecemNascido: 'N',
  },
  itens: [
    {
      // Códigos OFICIAIS da Tabela 22 (ver dados/README.md). Nada inventado aqui:
      // código plausível e errado é glosa que aparece semanas depois.
      codigoTuss: '81000403',
      descricao: 'Restauração em resina composta',
      denteFdi: 36,
      faces: 'oclusal e mesial',
      quantidade: 1,
      dataExecucao: '2026-07-10',
      valorApresentado: '180.00',
    },
    {
      codigoTuss: '81000012',
      descricao: 'Profilaxia',
      denteFdi: null,
      faces: null,
      quantidade: 1,
      dataExecucao: '2026-07-10',
      valorApresentado: '100.00',
    },
  ],
}

const PY_VALIDADOR = `
import sys
from lxml import etree
schema = etree.XMLSchema(etree.parse(sys.argv[1]))
doc = etree.parse(sys.argv[2])
if schema.validate(doc):
    print("VALIDO")
else:
    print("INVALIDO")
    for e in schema.error_log:
        print("  linha %d: %s" % (e.line, e.message))
`

const dir = mkdtempSync(join(tmpdir(), 'tiss-xsd-'))
const scriptPy = join(dir, 'val.py')
writeFileSync(scriptPy, PY_VALIDADOR, 'utf8')

function validar(xml: string): { valido: boolean; saida: string } {
  const arquivo = join(dir, 'doc.xml')
  writeFileSync(arquivo, xml, 'utf8')
  try {
    const saida = execFileSync('python3', [scriptPy, XSD, arquivo], { encoding: 'utf8' })
    return { valido: saida.startsWith('VALIDO'), saida: saida.trim() }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { valido: false, saida: (err.stdout ?? '') + (err.stderr ?? err.message ?? '') }
  }
}

let falhas = 0
const verde = (t: string) => `\x1b[32m${t}\x1b[0m`
const vermelho = (t: string) => `\x1b[31m${t}\x1b[0m`

function caso(nome: string, condicao: boolean, detalhe = ''): void {
  if (condicao) {
    console.log(`  ${verde('✓')} ${nome}`)
  } else {
    falhas++
    console.log(`  ${vermelho('✗')} ${nome}${detalhe ? `\n      ${detalhe}` : ''}`)
  }
}

console.log(`\n═══ XML TISS ${VERSAO_TISS} contra o XSD oficial da ANS ═══\n`)
console.log(`  XSD: ${XSD}`)
console.log('  (confira a procedência em dados/tiss-xsd-3.05.00/PROCEDENCIA.md)\n')

// ── 1. O documento que o sistema gera ──────────────────────────────────────
const xml = xmlGuiaOdontologica(GUIA)
const r = validar(xml)
caso('a guia odontológica gerada valida contra o XSD', r.valido, r.saida)

// ── 2. As contraprovas ─────────────────────────────────────────────────────
//
// Cada uma quebra o documento de um jeito que o padrão proíbe. Se qualquer uma
// passar, o validador não está validando — e o caso 1 não vale nada.
console.log('\n  Contraprovas (o validador tem de REPROVAR cada uma):')

interface Quebra {
  readonly nome: string
  readonly de: string
  readonly para: string
}

const QUEBRAS: readonly Quebra[] = [
  {
    nome: 'sem horaRegistroTransacao — campo obrigatório',
    de: `      <ans:horaRegistroTransacao>13:00:00</ans:horaRegistroTransacao>\n`,
    para: '',
  },
  {
    nome: 'sem cnesExec — campo obrigatório',
    de: `            <ans:cnesExec>1234567</ans:cnesExec>\n`,
    para: '',
  },
  {
    nome: 'UF em sigla em vez de código IBGE (o bug antigo)',
    de: '<ans:ufExec>35</ans:ufExec>',
    para: '<ans:ufExec>SP</ans:ufExec>',
  },
  {
    nome: 'denteFace com 16 caracteres, limite é 5 (o bug antigo)',
    de: '<ans:denteFace>MO</ans:denteFace>',
    para: '<ans:denteFace>oclusal e mesial</ans:denteFace>',
  },
  {
    nome: 'codigoTabela fora do domínio',
    de: '<ans:codigoTabela>22</ans:codigoTabela>',
    para: '<ans:codigoTabela>77</ans:codigoTabela>',
  },
  {
    nome: 'versão do padrão fora do domínio',
    de: `<ans:Padrao>${VERSAO_TISS}</ans:Padrao>`,
    para: '<ans:Padrao>9.99.99</ans:Padrao>',
  },
]

for (const q of QUEBRAS) {
  // Sem esta checagem o caso fica VACUOSO: a substituição não casa, o documento
  // testado é o original, ele valida, e a contraprova "falha" dizendo que o
  // validador é frouxo — ou, pior, a lógica invertida daria verde. Aconteceu.
  if (!xml.includes(q.de)) {
    falhas++
    console.log(
      `  ${vermelho('✗')} ${q.nome}\n      ALVO NÃO ENCONTRADO no documento — o caso seria vacuoso. ` +
        `Procurava: ${JSON.stringify(q.de.trim().slice(0, 60))}`,
    )
    continue
  }
  const quebrado = xml.replace(q.de, q.para)
  caso(q.nome, !validar(quebrado).valido, 'o validador ACEITOU o documento quebrado')
}

// ── 3. Ordem dos elementos, que é o erro mais fácil de cometer ─────────────
//
// O XSD usa `xs:sequence` em toda a árvore. Este caso existe separado porque
// reordenar é o que acontece quando alguém edita o gerador — e é invisível a um
// parser: o XML continua bem formado.
{
  const ini = xml.indexOf('            <ans:procSolic>')
  const fim = xml.indexOf('            </ans:procSolic>') + '            </ans:procSolic>\n'.length
  const bloco = xml.slice(ini, fim)
  const reordenado = xml.replace(bloco, '').replace('            <ans:qtdProc>', bloco + '            <ans:qtdProc>')
  caso(
    'ordem trocada (procSolic depois de qtdProc) é recusada',
    bloco.length > 0 && !validar(reordenado).valido,
    'o validador ACEITOU elementos fora de ordem — xs:sequence não está sendo conferida',
  )
}

// ── 4. O gerador se recusa a emitir XML incompleto ─────────────────────────
//
// Antes ele emitia com campo vazio, o que produz documento que passa em parser e
// morre na operadora. Falhar aqui é a diferença entre descobrir agora e descobrir
// no demonstrativo.
{
  const semCadastro: DadosGuiaParaExportar = { ...GUIA, cadastro: undefined }
  let estourou = false
  try {
    xmlGuiaOdontologica(semCadastro)
  } catch {
    estourou = true
  }
  caso('sem o cadastro obrigatório, o gerador ESTOURA em vez de emitir XML inválido', estourou)

  const semCnes: DadosGuiaParaExportar = {
    ...GUIA,
    cadastro: { ...GUIA.cadastro!, cnes: null },
  }
  let estourou2 = false
  try {
    xmlGuiaOdontologica(semCnes)
  } catch {
    estourou2 = true
  }
  caso('sem CNES, idem', estourou2)
}

console.log()
if (falhas === 0) {
  console.log(verde('═══ XML válido contra o XSD oficial, e a validação está provada ═══'))
  console.log('\n  ⚠ Válido contra o XSD NÃO é aceito pela operadora. O schema confere')
  console.log('    estrutura, tipo e domínio — não confere se o código corresponde ao que')
  console.log('    foi feito, se o valor está na tabela negociada, nem as regras próprias de')
  console.log('    cada operadora. Assinatura digital da guia não é emitida.')
} else {
  console.log(vermelho(`═══ ${falhas} falha(s) ═══`))
}
process.exit(falhas > 0 ? 1 : 0)
