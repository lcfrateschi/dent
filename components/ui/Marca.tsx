import { cn } from '@/lib/ui/cn'

/**
 * Marca Facilident — arquivos oficiais do kit do designer.
 *
 * ── De onde vêm as imagens ──────────────────────────────────────────────────
 * `public/marca/`, servidas do próprio domínio. O kit completo, como recebido,
 * está versionado em `design-system/kit-da-marca/` (color, mono, reverse, extra) —
 * é a fonte, e nada aqui redesenha nada. A versão anterior deste arquivo tinha um
 * símbolo que eu havia vetorizado à mão a partir do PNG do manual; ele foi
 * descartado quando o kit chegou.
 *
 * ── Por que `background-image` e não `<img>` nem SVG embutido ───────────────
 * **A arte é a original nos dois temas** — símbolo, palavra e descritor como o
 * designer entregou, sem versão branca e sem recolorir texto.
 *
 * Isso tem um custo, e ele é pago com a chapa: o navio `#0D3B66` da palavra sobre
 * `#071626` dá 1,3:1 de contraste, ou seja, a palavra desapareceria. No tema
 * escuro a assinatura vai sobre uma superfície clara (`--marca-chapa`), como um
 * crachá — é um retângulo claro num cabeçalho escuro, e ele chama a atenção. A
 * alternativa era a linha `reverse` do kit, que lê bem e perde as cores.
 *
 *   • Dois `<img>` com `dark:hidden` baixariam **os dois** arquivos, sempre — o
 *     navegador carrega imagem com `display:none`.
 *   • SVG embutido resolveria o tema, mas são ~5 KB de traçado por peça, em toda
 *     resposta HTML de toda navegação, e a marca aparece em quatro cascas.
 *   • `background-image` com variável CSS: **só o arquivo do tema em uso é
 *     baixado**, fica em cache, e a troca de tema é instantânea. As variáveis
 *     estão em `app/globals.css`, junto dos outros tokens.
 *
 * A contrapartida é que imagem de fundo não sai na impressão por padrão. Aqui não
 * custa nada: os impressos (atestado, receita, orçamento) levam o cabeçalho da
 * CLÍNICA, não a marca do software.
 *
 * ── Proporções ──────────────────────────────────────────────────────────────
 * Vêm do `viewBox` de cada arquivo e estão fixas aqui para o espaço ser reservado
 * antes de a imagem carregar — sem isso o cabeçalho pula quando ela chega.
 */

/** 340 × 320 do `facilident-icone-dente`. */
const PROPORCAO_SIMBOLO = 340 / 320
/** 1320 × 320 do `facilident-logo-completa`, com o descritor. */
const PROPORCAO_LOCKUP = 1320 / 320
/** 558.79 × 103.34 do wordmark compacto (derivado do kit, sem o descritor). */
const PROPORCAO_PALAVRA = 558.79 / 103.34

/**
 * Só o símbolo do dente — colorido, e **sem chapa**: sozinho ele tem contraste de
 * sobra sobre o fundo escuro. A chapa existe por causa da palavra.
 *
 * `tamanho` é a altura em px; a largura sai da proporção do arquivo.
 */
export function SimboloFacilident({
  tamanho = 32,
  className,
}: {
  tamanho?: number
  className?: string
  /** Aceito e ignorado: sobrou da época do SVG embutido, que precisava de id único. */
  id?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block shrink-0 bg-contain bg-center bg-no-repeat', className)}
      style={{
        backgroundImage: 'var(--marca-simbolo)',
        height: tamanho,
        width: Math.round(tamanho * PROPORCAO_SIMBOLO),
      }}
    />
  )
}

/**
 * Assinatura da marca.
 *
 * - `comDescritor` usa o **lockup oficial** (símbolo + palavra + "software de
 *   gestão odontológica"), para login e portal, onde há espaço.
 * - sem ele, símbolo + palavra em versão **compacta**: a 22 px de cabeçalho a
 *   linha do descritor viraria um borrão cinza, e o kit não traz uma versão sem
 *   ela — esta é derivada dos mesmos vetores, removendo o grupo do descritor
 *   (ver `public/marca/facilident-wordmark-compacto-color.svg`, e a variante `-escuro`
 *   com o texto clareado).
 */
export function Marca({
  tamanho = 'md',
  comDescritor = false,
  className,
}: {
  tamanho?: 'sm' | 'md' | 'lg'
  comDescritor?: boolean
  id?: string
  className?: string
}) {
  const altura = tamanho === 'sm' ? 24 : tamanho === 'md' ? 32 : 64

  /**
   * A chapa vem dos tokens: transparente no claro, `#F2F5F9` no escuro. Assim o
   * componente não sabe qual é o tema — quem sabe é o CSS, que é o único capaz de
   * saber antes da primeira pintura.
   */
  const chapa = {
    backgroundColor: 'var(--marca-chapa)',
    padding: 'var(--marca-chapa-pad)',
    borderRadius: 'var(--marca-chapa-raio)',
  } as const

  if (comDescritor) {
    return (
      <span
        role="img"
        aria-label="Facilident — software de gestão odontológica"
        className={cn('inline-block', className)}
        style={chapa}
      >
        <span
          aria-hidden="true"
          className="block bg-contain bg-left bg-no-repeat"
          style={{
            backgroundImage: 'var(--marca-lockup)',
            height: altura,
            width: Math.round(altura * PROPORCAO_LOCKUP),
          }}
        />
      </span>
    )
  }

  const alturaPalavra = Math.round(altura * 0.58)

  return (
    <span
      role="img"
      aria-label="Facilident"
      className={cn('inline-flex items-center gap-2', className)}
      style={chapa}
    >
      <SimboloFacilident tamanho={altura} />
      <span
        aria-hidden="true"
        className="inline-block bg-contain bg-left bg-no-repeat"
        style={{
          backgroundImage: 'var(--marca-palavra)',
          height: alturaPalavra,
          width: Math.round(alturaPalavra * PROPORCAO_PALAVRA),
        }}
      />
    </span>
  )
}
