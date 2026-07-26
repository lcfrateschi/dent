import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import publicados from '@/design-system/tokens-publicados.json'

/**
 * Trava contra divergência entre o código e o catálogo do Claude Design.
 *
 * O projeto de design tem a própria cópia dos tokens. Trocar uma cor
 * em `app/globals.css` e esquecer de republicar deixa a equipe revisando um
 * catálogo que não é mais o produto — que é pior do que não ter catálogo, porque
 * dá confiança errada.
 *
 * Quando este teste falhar, há duas saídas legítimas:
 *   1. republicar com `/design-sync` e atualizar `tokens-publicados.json` no
 *      MESMO commit; ou
 *   2. reverter a mudança de cor.
 * Editar só o snapshot para o teste passar é a saída ilegítima.
 */

const globals = readFileSync('app/globals.css', 'utf8')

function bloco(tema: 'claro' | 'escuro'): string {
  const inicioClaro = globals.indexOf(':root {')
  const inicioEscuro = globals.indexOf('.dark {')
  return tema === 'claro'
    ? globals.slice(inicioClaro, inicioEscuro)
    : globals.slice(inicioEscuro, globals.indexOf('}', globals.indexOf('--selecionado-fill', inicioEscuro)))
}

function valorDe(css: string, token: string): string | null {
  const m = new RegExp(`--${token}\\s*:\\s*([^;]+);`).exec(css)
  return m ? m[1]!.trim() : null
}

describe('tokens do código versus catálogo publicado', () => {
  for (const tema of ['claro', 'escuro'] as const) {
    describe(`tema ${tema}`, () => {
      const css = bloco(tema)
      const esperados = publicados[tema] as Record<string, string>

      it('tem o mesmo valor para cada token publicado', () => {
        const divergentes: string[] = []
        for (const [token, valorPublicado] of Object.entries(esperados)) {
          const noCodigo = valorDe(css, token)
          if (noCodigo !== valorPublicado) {
            divergentes.push(`--${token}: código=${noCodigo} catálogo=${valorPublicado}`)
          }
        }
        expect(
          divergentes,
          `Tokens divergiram do catálogo. Republique com /design-sync e atualize ` +
            `design-system/tokens-publicados.json no mesmo commit:\n  ${divergentes.join('\n  ')}`,
        ).toEqual([])
      })

      it('não introduziu token de cor que o catálogo não conhece', () => {
        // Só cores: escala tipográfica e de espaço estão em `_pendente` de propósito.
        const noCodigo = [...css.matchAll(/--([a-z0-9-]+)\s*:\s*#/g)].map((m) => m[1]!)
        const conhecidos = new Set(Object.keys(esperados))
        const novos = noCodigo.filter((t) => !conhecidos.has(t))
        expect(
          novos,
          `Cores novas ainda não publicadas: ${novos.join(', ')}. Rode /design-sync.`,
        ).toEqual([])
      })
    })
  }

  it('cobre os dois temas com o mesmo conjunto de tokens', () => {
    expect(Object.keys(publicados.claro).sort()).toEqual(Object.keys(publicados.escuro).sort())
  })

  it('documenta o vocabulário que o catálogo tem à frente do código', () => {
    // Não é asserção de igualdade: é garantia de que a dívida está registrada e
    // não vai ser descoberta por acidente seis meses depois.
    expect(publicados._pendente.escalaTipografica.length).toBeGreaterThan(0)
    expect(publicados._pendente.forma.length).toBeGreaterThan(0)
  })
})
