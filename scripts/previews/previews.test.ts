import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { montarPreview } from './pagina'
import { CSS_TOKENS, TOKENS_ESPERADOS } from './tokens'

/**
 * Os previews duplicam os tokens de propósito — o Claude Design serve HTML
 * autocontido, sem build. Estes testes são a trava que impede a duplicação de
 * virar divergência silenciosa: se alguém mudar uma cor em `app/globals.css` e
 * esquecer o catálogo, a suíte falha.
 */
describe('tokens do preview versus globals.css', () => {
  const globals = readFileSync('app/globals.css', 'utf8')

  it('declara todos os tokens que o CSS real declara no tema claro', () => {
    // Extrai os nomes de token do bloco `:root` de globals.css.
    const root = globals.slice(globals.indexOf(':root {'), globals.indexOf('.dark {'))
    const doCss = [...root.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!)
    const doPreview = new Set(TOKENS_ESPERADOS as readonly string[])

    const faltando = doCss.filter((t) => !doPreview.has(t))
    expect(faltando, `tokens em globals.css ausentes do preview: ${faltando.join(', ')}`).toEqual([])
  })

  it('usa os MESMOS valores do tema claro', () => {
    const root = globals.slice(globals.indexOf(':root {'), globals.indexOf('.dark {'))
    for (const token of TOKENS_ESPERADOS) {
      const noCss = valorDe(root, token)
      const noPreview = valorDe(CSS_TOKENS.slice(0, CSS_TOKENS.indexOf('.escuro')), token)
      expect(noPreview, `--${token} divergiu entre globals.css e o preview`).toBe(noCss)
    }
  })

  it('usa os MESMOS valores do tema escuro', () => {
    const dark = globals.slice(globals.indexOf('.dark {'))
    const escuro = CSS_TOKENS.slice(CSS_TOKENS.indexOf('.escuro'))
    for (const token of TOKENS_ESPERADOS) {
      const noCss = valorDe(dark, token)
      const noPreview = valorDe(escuro, token)
      expect(noPreview, `--${token} divergiu no tema escuro`).toBe(noCss)
    }
  })

  it('define cada token nos dois temas', () => {
    const claro = CSS_TOKENS.slice(0, CSS_TOKENS.indexOf('.escuro'))
    const escuro = CSS_TOKENS.slice(CSS_TOKENS.indexOf('.escuro'))
    for (const token of TOKENS_ESPERADOS) {
      expect(valorDe(claro, token), `--${token} falta no claro`).toBeTruthy()
      expect(valorDe(escuro, token), `--${token} falta no escuro`).toBeTruthy()
    }
  })
})

function valorDe(css: string, token: string): string | null {
  const m = new RegExp(`--${token}\\s*:\\s*([^;]+);`).exec(css)
  return m ? m[1]!.trim() : null
}

describe('estrutura do preview', () => {
  const html = montarPreview({
    grupo: 'Componentes',
    nome: 'Exemplo',
    subtitulo: 'variantes',
    largura: 800,
    altura: 400,
    corpo: '<p>oi</p>',
  })

  it('põe o marcador @dsCard na PRIMEIRA linha — sem ele o card não aparece', () => {
    const primeira = html.split('\n')[0]!
    expect(primeira.startsWith('<!-- @dsCard ')).toBe(true)
    expect(primeira).toContain('group="Componentes"')
    expect(primeira).toContain('name="Exemplo"')
    expect(primeira).toContain('subtitle="variantes"')
    expect(primeira).toContain('width="800"')
    expect(primeira).toContain('height="400"')
  })

  it('é autocontido — a CSP do Claude Design bloqueia recurso externo', () => {
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/)
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/@import\s+url\(/)
    expect(html).not.toMatch(/src=["']https?:/)
    // O CSS tem que estar embutido.
    expect(html).toContain('<style>')
    expect(html).toContain('--primary:')
  })

  it('renderiza claro e escuro lado a lado', () => {
    expect(html).toContain('class="metade"')
    expect(html).toContain('class="metade escuro"')
    expect(html.match(/<p>oi<\/p>/g)).toHaveLength(2)
  })

  it('respeita temaUnico quando o componente só faz sentido num tema', () => {
    const unico = montarPreview({ grupo: 'Brand', nome: 'X', corpo: '<p>oi</p>', temaUnico: true })
    expect(unico).not.toContain('class="metade escuro"')
    expect(unico.match(/<p>oi<\/p>/g)).toHaveLength(1)
  })

  it('escapa aspas e sinais nos atributos do marcador', () => {
    const arriscado = montarPreview({
      grupo: 'A "B" & <C>',
      nome: 'N "x"',
      corpo: '',
    })
    const primeira = arriscado.split('\n')[0]!
    expect(primeira).toContain('&quot;')
    expect(primeira).toContain('&amp;')
    expect(primeira).not.toMatch(/group="A "B"/)
  })

  it('declara idioma e viewport', () => {
    expect(html).toContain('lang="pt-BR"')
    expect(html).toContain('name="viewport"')
  })
})
