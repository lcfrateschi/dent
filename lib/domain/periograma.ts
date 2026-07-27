import { exigirDente, type Arcada } from './dentes'
import { erro } from './erros'

/**
 * Regras do exame periodontal (periograma).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 *  ⚠️ QUEM ESCREVEU ISTO NÃO É DENTISTA
 *
 *  Este arquivo modela um exame clínico, não uma tela de cadastro. Um campo errado
 *  aqui não é bug de software: é um diagnóstico que não se sustenta.
 *
 *  Por isso cada regra abaixo está marcada com a origem:
 *
 *    [PADRÃO]  protocolo internacional, verificável em fonte — 6 sítios por dente,
 *              Miller para mobilidade, Glickman para furca, NIC = PS + recessão.
 *    ⚠️ [ESCOLHA] decisão de modelagem que **precisa de validação do dentista**:
 *              faixas numéricas aceitas, quais dentes têm furca, exclusão dos
 *              decíduos, e o que ficou de fora.
 *
 *  A lista consolidada do que precisa ser validado está no `GLOSSARIO.md`.
 * ══════════════════════════════════════════════════════════════════════════════
 */

// ── Sítios ───────────────────────────────────────────────────────────────────

/**
 * Os seis sítios de sondagem por dente. [PADRÃO]
 *
 * Três na face vestibular (mésio-vestibular, vestibular, disto-vestibular) e três
 * na face oral. **O nome do sítio oral depende da arcada**: superior é palatina,
 * inferior é lingual — a mesma regra que `facesDe()` já aplica às faces do
 * odontograma, e que o `CLAUDE.md` registra como armadilha do domínio.
 *
 * São nove valores no total, não seis, e é de propósito: um enum com
 * `mesio_oral` genérico deixaria o exame gravar um sítio que não existe naquele
 * dente sem que nada percebesse. Com nove valores e a trava por arcada, "sítio
 * palatino no 36" é impossível de gravar, não apenas errado de exibir.
 */
export type SitioPeriograma =
  | 'mesio_vestibular'
  | 'vestibular'
  | 'disto_vestibular'
  | 'mesio_palatina'
  | 'palatina'
  | 'disto_palatina'
  | 'mesio_lingual'
  | 'lingual'
  | 'disto_lingual'

const SITIOS_VESTIBULARES = ['mesio_vestibular', 'vestibular', 'disto_vestibular'] as const
const SITIOS_PALATINOS = ['mesio_palatina', 'palatina', 'disto_palatina'] as const
const SITIOS_LINGUAIS = ['mesio_lingual', 'lingual', 'disto_lingual'] as const

/** Os seis sítios válidos de um dente, na ordem em que o exame é ditado. [PADRÃO] */
export function sitiosDe(fdi: number): readonly SitioPeriograma[] {
  const d = exigirDente(fdi)
  return [
    ...SITIOS_VESTIBULARES,
    ...(d.arcada === 'superior' ? SITIOS_PALATINOS : SITIOS_LINGUAIS),
  ]
}

/** `true` quando o sítio existe naquele dente — a arcada decide o lado oral. */
export function sitioEhValido(fdi: number, sitio: SitioPeriograma): boolean {
  return sitiosDe(fdi).includes(sitio)
}

export function exigirSitioValido(fdi: number, sitio: SitioPeriograma): void {
  if (!sitioEhValido(fdi, sitio)) {
    const arcada: Arcada = exigirDente(fdi).arcada
    erro(
      'SITIO_INVALIDO',
      `O dente ${fdi} é ${arcada} e não tem sítio "${sitio}". ` +
        `Superior tem palatina, inferior tem lingual.`,
      { fdi, sitio, arcada },
    )
  }
}

// ── Dentição: por que só permanente ──────────────────────────────────────────

/**
 * ⚠️ [ESCOLHA] **O periograma cobre só a dentição permanente (FDI 11–48).**
 *
 * Três razões, e nenhuma é técnica:
 *
 * 1. O protocolo de 6 sítios com medida de nível de inserção é validado para
 *    dentição permanente. Periodontite em criança existe (forma agressiva
 *    localizada) e é incomum.
 * 2. **Mobilidade de Miller num decíduo pré-esfoliação mede o oposto de doença.**
 *    Um decíduo que balança perto da troca está fazendo exatamente o que deve; um
 *    grau III registrado ali viraria achado patológico num evento fisiológico.
 * 3. O NIC se mede da junção cemento-esmalte, e a referência anatômica em raiz
 *    em reabsorção não é a mesma coisa.
 *
 * **Isto precisa de validação do dentista.** Se ele registrar periodonto em
 * criança, a trava é uma linha na `drizzle/0037` — e o modelo não muda.
 */
export function aceitaPeriograma(fdi: number): boolean {
  return exigirDente(fdi).denticao === 'permanente'
}

// ── Furca ────────────────────────────────────────────────────────────────────

/**
 * `true` quando o dente tem mais de uma raiz e, portanto, pode ter furca. [PADRÃO
 * para molares] / ⚠️ [ESCOLHA para pré-molares]
 *
 * Furca é o espaço entre as raízes: **dente de raiz única não tem furca**, e
 * registrar Glickman num incisivo é o mesmo tipo de erro que marcar face oclusal
 * num canino — que o projeto já trata como armadilha do domínio.
 *
 * O que está travado aqui: **molares** (posições 6, 7, 8 na notação FDI). Isso é
 * pacífico.
 *
 * ⚠️ **O que NÃO está, e precisa do dentista:** o primeiro pré-molar SUPERIOR
 * (14 e 24) tem duas raízes na maioria das pessoas, e portanto tem furca. Ele está
 * **fora** desta lista — a escolha é conservadora de propósito: deixar de fora
 * impede registrar furca onde ela existe (perde informação, e o dentista percebe);
 * deixar dentro permitiria registrar furca num dente de raiz única (cria
 * informação falsa, e ninguém percebe). Entre perder e inventar, este projeto
 * perde.
 *
 * A regra fica em UM lugar autoritativo — a função SQL `dente_multirradicular()`,
 * usada pelo CHECK da tabela. Esta cópia em TypeScript existe para a interface não
 * oferecer o campo, e há invariante em `docker/verificar-invariantes.sql` que
 * compara as duas contra a mesma lista de 32 dentes. Duas implementações da mesma
 * regra sem cruzamento é divergência esperando acontecer.
 */
export function ehMultirradicular(fdi: number): boolean {
  const d = exigirDente(fdi)
  if (d.denticao !== 'permanente') return false
  const posicao = fdi % 10
  return posicao === 6 || posicao === 7 || posicao === 8
}

/** Faixa de Glickman. `0` = examinado, sem envolvimento. [PADRÃO] */
export const FURCA_MAXIMA = 4
/** Faixa de Miller. `0` = sem mobilidade detectável. [PADRÃO] */
export const MOBILIDADE_MAXIMA = 3

// ── Faixas numéricas ─────────────────────────────────────────────────────────

/**
 * ⚠️ [ESCOLHA] Faixas aceitas, e o motivo de cada limite.
 *
 * `PS` de 0 a 15 mm: a sonda milimetrada (UNC-15) tem marcação até 15, então 15 é
 * o maior valor **legível** — acima disso não é medida, é estimativa. O limite não
 * é fisiológico, é do instrumento, e é por isso que ele é aceitável como trava:
 * recusa erro de digitação (um "40" que era "4,0") sem recusar achado real.
 *
 * `recessão` de −10 a +20 mm, e o sinal é o que importa:
 *   • **positivo** = margem gengival apical à junção cemento-esmalte → recessão,
 *     raiz exposta;
 *   • **negativo** = margem coronal à junção → aumento gengival, a margem cobre
 *     parte da coroa.
 *
 * Sem o negativo, o NIC de um paciente com hiperplasia sairia superestimado — e é
 * exatamente nesse paciente que a bolsa profunda não significa perda de inserção.
 */
export const PS_MINIMA = 0
export const PS_MAXIMA = 15
export const RECESSAO_MINIMA = -10
export const RECESSAO_MAXIMA = 20

/** Limiar de bolsa que entra na contagem de sítios rasos × profundos. [PADRÃO] */
export const LIMIAR_BOLSA_MM = 4
/** Limiar do que costuma indicar necessidade de tratamento cirúrgico. [PADRÃO] */
export const LIMIAR_BOLSA_PROFUNDA_MM = 6

// ── Nível de inserção clínica ────────────────────────────────────────────────

/**
 * NIC = PS + recessão. [PADRÃO]
 *
 * **É DERIVADO, e no banco é coluna gerada** (`GENERATED ALWAYS AS … STORED`), o
 * que significa que `INSERT` nele é recusado pelo Postgres — não por trigger, não
 * por disciplina. Mesmo princípio de "glosa é CALCULADA, nunca digitada": campo
 * derivado que se pode digitar divergindo do cálculo é conciliação que não fecha
 * nunca. E aqui é pior que dinheiro — **o NIC é o número que diz se a doença
 * progrediu**, porque a bolsa pode encolher só porque a gengiva retraiu.
 *
 * Esta função existe para a interface mostrar o valor antes de gravar. Ela e a
 * coluna gerada precisam concordar, e há invariante que prova que concordam.
 */
export function nivelInsercao(profundidadeMm: number, recessaoMm: number): number {
  return profundidadeMm + recessaoMm
}

// ── Resumo de um exame ───────────────────────────────────────────────────────

export interface SitioMedido {
  readonly denteFdi: number
  readonly sitio: SitioPeriograma
  readonly profundidadeMm: number
  readonly recessaoMm: number
  readonly sangramento: boolean
  readonly supuracao: boolean
}

/**
 * Agregados de um exame.
 *
 * **Somas e contagens inteiras, nunca média em ponto flutuante.** É o mesmo motivo
 * de `dinheiro.ts` usar centavos e `quantidade.ts` usar milésimos: média de
 * milímetros é racional, e comparar `2.7000000000000002` com `2.7` num teste
 * produz falha que ninguém entende. A média sai em **décimos de milímetro**, como
 * inteiro — `27` é 2,7 mm.
 */
export interface ResumoPeriograma {
  readonly sitios: number
  readonly somaProfundidade: number
  readonly somaNivelInsercao: number
  readonly sangrantes: number
  readonly supurantes: number
  readonly sitiosComBolsa: number
  readonly sitiosComBolsaProfunda: number
}

const VAZIO: ResumoPeriograma = {
  sitios: 0,
  somaProfundidade: 0,
  somaNivelInsercao: 0,
  sangrantes: 0,
  supurantes: 0,
  sitiosComBolsa: 0,
  sitiosComBolsaProfunda: 0,
}

export function resumir(sitios: readonly SitioMedido[]): ResumoPeriograma {
  return sitios.reduce<ResumoPeriograma>(
    (acc, s) => ({
      sitios: acc.sitios + 1,
      somaProfundidade: acc.somaProfundidade + s.profundidadeMm,
      somaNivelInsercao: acc.somaNivelInsercao + nivelInsercao(s.profundidadeMm, s.recessaoMm),
      sangrantes: acc.sangrantes + (s.sangramento ? 1 : 0),
      supurantes: acc.supurantes + (s.supuracao ? 1 : 0),
      sitiosComBolsa: acc.sitiosComBolsa + (s.profundidadeMm >= LIMIAR_BOLSA_MM ? 1 : 0),
      sitiosComBolsaProfunda:
        acc.sitiosComBolsaProfunda + (s.profundidadeMm >= LIMIAR_BOLSA_PROFUNDA_MM ? 1 : 0),
    }),
    VAZIO,
  )
}

/**
 * Média em décimos de milímetro, ou `null` quando não há base.
 *
 * `null` e não `0` — decisão já fechada no projeto para taxas: exame sem sítio
 * medido não tem média de 0,0 mm, **não tem média**. A tela escreve "—".
 */
export function mediaProfundidadeDecimos(r: ResumoPeriograma): number | null {
  if (r.sitios === 0) return null
  return Math.round((r.somaProfundidade * 10) / r.sitios)
}

export function mediaNivelInsercaoDecimos(r: ResumoPeriograma): number | null {
  if (r.sitios === 0) return null
  return Math.round((r.somaNivelInsercao * 10) / r.sitios)
}

/** Percentual de sangramento em décimos de ponto: `234` é 23,4 %. `null` sem base. */
export function sangramentoDecimosPct(r: ResumoPeriograma): number | null {
  if (r.sitios === 0) return null
  return Math.round((r.sangrantes * 1000) / r.sitios)
}

/** `27` → `"2,7 mm"`. `null` → `"—"`. */
export function formatarMm(decimos: number | null): string {
  if (decimos === null) return '—'
  const sinal = decimos < 0 ? '-' : ''
  const abs = Math.abs(decimos)
  return `${sinal}${Math.trunc(abs / 10)},${abs % 10} mm`
}

// ── Comparação entre dois exames ─────────────────────────────────────────────

export interface ComparacaoPeriograma {
  /**
   * Comparação sobre os sítios presentes nos DOIS exames. **É esta que vale.**
   */
  readonly emparelhado: { readonly antes: ResumoPeriograma; readonly depois: ResumoPeriograma }
  /**
   * Cada exame sobre TODOS os seus sítios. Existe para a tela poder mostrar o
   * tamanho de cada exame — e para a demonstração provar que usá-la como
   * comparação mente.
   */
  readonly completo: { readonly antes: ResumoPeriograma; readonly depois: ResumoPeriograma }
  /** Dentes que existiam no primeiro exame e não existem no segundo. */
  readonly dentesPerdidos: readonly number[]
  /** Dentes que apareceram no segundo (erupção do 3º molar, implante registrado). */
  readonly dentesNovos: readonly number[]
  /** `true` quando a boca mudou entre os exames — a comparação é parcial. */
  readonly parcial: boolean
}

const chave = (s: SitioMedido): string => `${s.denteFdi}:${s.sitio}`

/**
 * Compara dois exames do mesmo paciente.
 *
 * ── A armadilha que esta função existe para evitar ──────────────────────────
 * **Dente extraído entre dois exames melhora todos os números.** Os sítios dele
 * desaparecem — e são justamente os piores, porque foi por isso que ele saiu. Uma
 * comparação que só faça `média(exame 2) − média(exame 1)` mostra melhora
 * espetacular exatamente no paciente que perdeu o dente, e é o tipo de gráfico que
 * uma clínica mostraria ao paciente de boa-fé.
 *
 * Por isso a comparação é **emparelhada**: só entram os sítios presentes nos dois
 * exames. O que mudou de boca é reportado separadamente, como o que é — perda
 * dentária, o desfecho mais grave da doença periodontal, não uma melhora.
 *
 * A versão ingênua fica exposta em `completo` de propósito: a tela precisa dizer
 * "192 sítios antes, 168 depois", e a demonstração usa as duas para provar que a
 * diferença entre elas não é detalhe.
 */
export function compararPeriogramas(
  antes: readonly SitioMedido[],
  depois: readonly SitioMedido[],
): ComparacaoPeriograma {
  const chavesDepois = new Set(depois.map(chave))
  const chavesAntes = new Set(antes.map(chave))

  const antesEmparelhado = antes.filter((s) => chavesDepois.has(chave(s)))
  const depoisEmparelhado = depois.filter((s) => chavesAntes.has(chave(s)))

  const dentesAntes = new Set(antes.map((s) => s.denteFdi))
  const dentesDepois = new Set(depois.map((s) => s.denteFdi))

  const dentesPerdidos = [...dentesAntes].filter((d) => !dentesDepois.has(d)).sort((a, b) => a - b)
  const dentesNovos = [...dentesDepois].filter((d) => !dentesAntes.has(d)).sort((a, b) => a - b)

  return {
    emparelhado: { antes: resumir(antesEmparelhado), depois: resumir(depoisEmparelhado) },
    completo: { antes: resumir(antes), depois: resumir(depois) },
    dentesPerdidos,
    dentesNovos,
    parcial: dentesPerdidos.length > 0 || dentesNovos.length > 0,
  }
}
