import { cn } from '@/lib/ui/cn'

/**
 * Marca Facilident.
 *
 * ── Por que vetor, e não o PNG do manual ────────────────────────────────────
 * O símbolo aparece de 20 px (cabeçalho) a 64 px (login e portal), em tema claro
 * e escuro. Raster escalado fica borrado no cabeçalho e pesa em toda navegação;
 * o vetor é o mesmo arquivo em qualquer tamanho e acompanha o tema. A estrutura é
 * a do manual: dois traços abertos (coroa e raízes em W), sorriso com dois pontos
 * e os quadrados de "pixel" à direita — a transformação digital do consultório.
 *
 * ── O gradiente é o do manual ───────────────────────────────────────────────
 * `#0D3B66 → #1278E3 → #00B3A6`, na diagonal, como no lockup original: navio
 * escuro na esquerda da coroa, azul no topo, verde-água nas raízes.
 *
 * ── `id` do gradiente ───────────────────────────────────────────────────────
 * `defs` com id fixo colidiria quando a marca aparece duas vezes na mesma página
 * (cabeçalho + rodapé). O id vem de `variante`, que já distingue os usos.
 */
export function SimboloFacilident({
  tamanho = 32,
  className,
  id = 'marca',
}: {
  tamanho?: number
  className?: string
  id?: string
}) {
  const gradiente = `facilident-${id}`
  return (
    <svg
      width={tamanho}
      height={tamanho}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradiente} x1="6" y1="12" x2="44" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0D3B66" />
          <stop offset="0.5" stopColor="#1278E3" />
          <stop offset="1" stopColor="#00B3A6" />
        </linearGradient>
      </defs>
      {/* coroa */}
      <path
        d="M8 40 C6 28 7 19 12 15 C17 11 21 13 24 20 C27 13 31 11 36 15 C41 19 42 28 40 40"
        stroke={`url(#${gradiente})`}
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* raízes */}
      <path
        d="M9 44 C10 53 13 58 17 58 C21 58 23 53 24 48 C25 53 27 58 31 58 C36 58 39 52 41 43"
        stroke={`url(#${gradiente})`}
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* sorriso */}
      <path
        d="M14 34 C15 41 20 43 24 41 C27 39.5 28.5 37 29 34"
        stroke={`url(#${gradiente})`}
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <circle cx="14" cy="33" r="2.3" fill="#1278E3" />
      <circle cx="29" cy="32.5" r="2.3" fill="#00B3A6" />
      {/* pixels */}
      <rect x="52" y="2" width="7.5" height="7.5" rx="1.5" fill="#00B3A6" />
      <rect x="44.5" y="7" width="6" height="6" rx="1.3" fill="#1278E3" />
      <rect x="50" y="15" width="4.6" height="4.6" rx="1.1" fill="#1278E3" />
      <rect x="44.5" y="18.5" width="4" height="4" rx="0.9" fill="#6FB2F2" />
      <rect x="52" y="23" width="4" height="4" rx="0.9" fill="#6FB2F2" />
      <rect x="46" y="25.5" width="4.6" height="4.6" rx="1.1" fill="#1278E3" />
    </svg>
  )
}

/**
 * Assinatura completa: símbolo + palavra.
 *
 * O "i" de "Facilident" é azul-claro no manual — é o único detalhe cromático da
 * palavra, e some se o texto for pintado de uma cor só. Em tema escuro a palavra
 * inteira clareia (`text-fg`), porque `#0D3B66` sobre fundo escuro desaparece.
 */
export function Marca({
  tamanho = 'md',
  comDescritor = false,
  id = 'marca',
  className,
}: {
  tamanho?: 'sm' | 'md' | 'lg'
  comDescritor?: boolean
  id?: string
  className?: string
}) {
  const simbolo = tamanho === 'sm' ? 22 : tamanho === 'md' ? 30 : 52
  const palavra =
    tamanho === 'sm' ? 'text-base' : tamanho === 'md' ? 'text-xl' : 'text-4xl'

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <SimboloFacilident tamanho={simbolo} id={id} />
      <span className="inline-flex flex-col leading-none">
        <span className={cn('font-semibold tracking-tight text-marca dark:text-fg', palavra)}>
          Facil<span className="text-marca-azul">i</span>dent
        </span>
        {comDescritor ? (
          <span className="mt-1 text-[0.62em] font-medium uppercase tracking-[0.18em] text-fg-3">
            Software de gestão odontológica
          </span>
        ) : null}
      </span>
    </span>
  )
}
