import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Toda classe de cor no JSX aponta para um token que EXISTE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  POR QUE ESTE TESTE EXISTE
 *
 *  `bg-superficie` esteve quatro vezes em `app/(portal)/meu/agendar/Marcar.tsx`.
 *  O token chama-se `--surface`; `--superficie` nunca existiu. O Tailwind não
 *  gera regra para classe sem token correspondente — então os três campos do
 *  formulário de agendamento ficaram **sem fundo nenhum**, num portal que é lido
 *  no celular, onde campo sem fundo desaparece visualmente no meio da tela.
 *
 *  Nada pegava: `tsc` não olha string de `className`, o `next build` compila sem
 *  reclamar, e asserção de HTML encontra a classe no markup — o que falta é o CSS.
 *  A única forma de descobrir era abrir a tela e olhar.
 *
 *  E aconteceu DUAS vezes de forma independente, em telas de agentes diferentes
 *  (o outro caso foi `border-borda`, com o token `--border`). Erro que se repete
 *  sozinho não é distração: é um buraco na rede.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── O que ele NÃO garante ──────────────────────────────────────────────────
 * Não é o compilador do Tailwind. `PREFIXOS` e `NATIVOS` abaixo são listas
 * curadas, e lista curada envelhece: uma utilitária nova do Tailwind que caia num
 * prefixo daqui vai aparecer como falso positivo até alguém acrescentá-la a
 * `NATIVOS`.
 *
 * A alternativa era rodar o build e conferir o CSS gerado — mais fiel e lento
 * demais para teste de unidade. A troca é consciente: um falso positivo custa uma
 * linha em `NATIVOS`, e um falso negativo custa uma tela invisível em produção.
 */

const RAIZES = ['app', 'components']

/** Prefixos que, neste projeto, consomem token de cor do design system. */
const PREFIXOS = [
  'bg-',
  'text-',
  'border-',
  'ring-',
  'fill-',
  'stroke-',
  'divide-',
  'outline-',
  'decoration-',
  'accent-',
  'caret-',
  'shadow-',
]

/**
 * Valores que o Tailwind resolve sozinho — não são tokens do projeto.
 *
 * Cada grupo é uma família de utilitárias que colide com os prefixos acima:
 * `border-b` é largura de borda por lado, `bg-contain` é `background-size`,
 * `text-sm` é tamanho de fonte. Nenhuma delas quer um token de cor.
 */
const NATIVOS = new Set([
  // lados e eixos de borda/divisória
  'b', 't', 'l', 'r', 'x', 'y', 's', 'e',
  // estilos de borda e colapso de tabela
  'solid', 'dashed', 'dotted', 'double', 'hidden', 'none', 'collapse', 'separate',
  // tamanhos de fonte e de sombra
  'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', 'inner',
  // peso e transformação de texto
  'thin', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black',
  'uppercase', 'lowercase', 'capitalize',
  // alinhamento e quebra
  'left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'balance',
  'pretty', 'clip', 'ellipsis', 'top', 'middle', 'bottom', 'baseline',
  // background-size / repeat / position / attachment
  'contain', 'cover', 'auto', 'no-repeat', 'repeat', 'repeat-x', 'repeat-y', 'fixed',
  'local', 'scroll', 'origin-border', 'clip-border', 'clip-padding', 'clip-text',
  // cores universais do Tailwind
  'transparent', 'current', 'inherit', 'white', 'black',
  // sublinhado
  'underline', 'overline', 'line-through',
])

/** Escalas de cor nativas do Tailwind (`bg-red-500`) — legítimas, embora o projeto use tokens. */
const ESCALA_TAILWIND =
  /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/

function tokensDoCss(): ReadonlySet<string> {
  const css = readFileSync('app/globals.css', 'utf8')
  return new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!))
}

function arquivosJsx(raiz: string): readonly string[] {
  const achados: string[] = []
  for (const nome of readdirSync(raiz)) {
    const caminho = join(raiz, nome)
    if (statSync(caminho).isDirectory()) achados.push(...arquivosJsx(caminho))
    else if (nome.endsWith('.tsx')) achados.push(caminho)
  }
  return achados
}

/** Extrai as classes de cada `className`, incluindo template e `cn(...)`. */
function classesDe(conteudo: string): readonly string[] {
  const classes: string[] = []
  const blocos = conteudo.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\(([\s\S]*?)\)\})/g)
  for (const b of blocos) {
    const blob = b[1] ?? b[2] ?? b[3] ?? ''
    // `[a-z][\w:/.\[\]-]*` cobre `hover:bg-surface-2`, `w-1/2` e `bg-[#fff]`.
    for (const c of blob.matchAll(/[a-z][a-z0-9:/[\]().-]*/g)) classes.push(c[0])
  }
  return classes
}

/** `hover:`, `dark:`, `lg:` e afins não mudam qual token a classe consome. */
function semVariante(classe: string): string {
  const partes = classe.split(':')
  return (partes[partes.length - 1] ?? '').replace(/^-/, '')
}

export function classesSemToken(
  conteudo: string,
  tokens: ReadonlySet<string>,
): readonly string[] {
  const ruins: string[] = []
  for (const bruta of classesDe(conteudo)) {
    const classe = semVariante(bruta)
    const prefixo = PREFIXOS.find((p) => classe.startsWith(p))
    if (!prefixo) continue

    const valor = classe.slice(prefixo.length)
    if (!valor) continue
    // Valor arbitrário (`bg-[#fff]`), opacidade (`bg-fg/10`) e fração (`w-1/2`).
    if (valor.startsWith('[') || valor.startsWith('(')) continue

    const raiz = valor.split('/')[0]!
    if (NATIVOS.has(raiz) || ESCALA_TAILWIND.test(raiz)) continue
    // Só números (`border-2`, `shadow-2`) são largura/escala, não cor.
    if (/^\d+$/.test(raiz)) continue

    /**
     * `border-l-atencao` (lado + token) e `border-t-2` (lado + largura) começam igual.
     * Tirar o lado resolve os dois: sobra um token a conferir, ou um número/nativo a
     * ignorar. A primeira versão testava o número ANTES de tirar o lado, então
     * `border-t-2` virava sete falsos positivos — e teste com falso positivo é teste
     * que alguém desliga.
     */
    const semLado = raiz.replace(/^[btlrxyse]-/, '')
    if (tokens.has(raiz) || tokens.has(semLado) || tokens.has(`color-${raiz}`)) continue
    if (NATIVOS.has(semLado) || /^\d+$/.test(semLado)) continue

    ruins.push(classe)
  }
  return [...new Set(ruins)]
}

describe('classes de cor apontam para tokens existentes', () => {
  const tokens = tokensDoCss()

  it('o CSS declara os tokens que o projeto usa', () => {
    // Sanidade da própria leitura: se o regex de tokens quebrar, tudo abaixo passa
    // vazio e o teste afirmaria nada. Estes quatro existem desde a Fase 2.
    for (const t of ['surface', 'surface-2', 'border', 'fg']) {
      expect(tokens.has(t), `token --${t}`).toBe(true)
    }
  })

  it('nenhum arquivo usa classe de cor sem token', () => {
    const problemas: string[] = []
    for (const raiz of RAIZES) {
      for (const arq of arquivosJsx(raiz)) {
        const ruins = classesSemToken(readFileSync(arq, 'utf8'), tokens)
        for (const c of ruins) problemas.push(`${arq}: ${c}`)
      }
    }
    expect(problemas, problemas.join('\n')).toEqual([])
  })

  it('DETECTA o caso real que motivou este teste (contraprova)', () => {
    // Sem esta contraprova, o teste acima poderia estar passando por não achar
    // classe nenhuma — e é exatamente assim que um teste vira decoração.
    const invisivel = '<div className="border border-border bg-superficie px-3" />'
    expect(classesSemToken(invisivel, tokens)).toEqual(['bg-superficie'])

    const bordaErrada = '<div className="border border-borda" />'
    expect(classesSemToken(bordaErrada, tokens)).toEqual(['border-borda'])

    // E não acusa o que é legítimo.
    const bom = '<div className="border-b border-border bg-surface-2 text-fg-3 hover:bg-surface" />'
    expect(classesSemToken(bom, tokens)).toEqual([])
  })
})
