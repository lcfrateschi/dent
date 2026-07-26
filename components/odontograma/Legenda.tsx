import { cn } from '@/lib/ui/cn'

/**
 * Legenda das convenções de desenho. Não é enfeite: sem ela o dentista não sabe
 * que a moldura é a cervical, nem que mesial troca de lado entre os quadrantes.
 */
export function Legenda({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-5 sm:grid-cols-2', className)}>
      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-3 uppercase">
          Estado da face
        </h3>
        <ul className="space-y-2 text-sm">
          <ItemLegenda
            amostra={<span className="block size-5 rounded-sm border border-dente-borda bg-dente-higido" />}
          >
            Hígido
          </ItemLegenda>
          <ItemLegenda
            amostra={
              <span className="hachura-planejado block size-5 rounded-sm border border-planejado" />
            }
          >
            <strong className="font-semibold text-planejado">Planejado</strong> — vermelho e
            hachurado
          </ItemLegenda>
          <ItemLegenda
            amostra={
              <span
                className="block size-5 rounded-sm border-2 border-executado"
                style={{ background: 'var(--executado-fill)' }}
              />
            }
          >
            <strong className="font-semibold text-executado">Executado</strong> — azul e sólido
          </ItemLegenda>
          <ItemLegenda
            amostra={
              <span className="block size-5 rounded-sm border-2 border-selecionado bg-transparent" />
            }
          >
            Selecionado — contorno verde-água
          </ItemLegenda>
        </ul>
        <p className="mt-3 text-xs text-fg-3">
          Vermelho para o que falta fazer e azul para o que já foi feito é a convenção do
          prontuário em papel. A hachura garante que a distinção não dependa só de cor.
        </p>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-fg-3 uppercase">
          Estado do dente
        </h3>
        <ul className="space-y-2 text-sm">
          <ItemLegenda amostra={<GlifoAusente />}>Ausente (extraído)</ItemLegenda>
          <ItemLegenda
            amostra={<span className="block size-5 rounded-sm border-2 border-coroa" />}
          >
            Coroa — moldura âmbar
          </ItemLegenda>
          <ItemLegenda amostra={<GlifoImplante />}>Implante</ItemLegenda>
        </ul>

        <h3 className="mt-4 mb-2 text-xs font-semibold tracking-wide text-fg-3 uppercase">
          Como ler o desenho
        </h3>
        <ul className="space-y-1.5 text-xs text-fg-2">
          <li>
            Cada dente é a <strong>vista oclusal</strong> da coroa: 4 trapézios em volta do
            centro.
          </li>
          <li>
            A <strong>moldura</strong> em volta é a face <strong>cervical</strong> — o colo do
            dente circunda todas as faces.
          </li>
          <li>
            O centro é <strong>incisal</strong> nos anteriores e <strong>oclusal</strong> nos
            posteriores. Nunca os dois.
          </li>
          <li>
            <strong>Vestibular</strong> fica sempre na borda externa; palatina (superior) e
            lingual (inferior) voltadas para a linha do meio.
          </li>
          <li>
            <strong>Mesial aponta para a linha média</strong> — por isso troca de lado entre os
            quadrantes.
          </li>
          <li>
            O paciente está de frente: o lado <strong>direito dele</strong> aparece à sua
            esquerda.
          </li>
        </ul>
      </section>
    </div>
  )
}

function ItemLegenda({
  amostra,
  children,
}: {
  amostra: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center">{amostra}</span>
      <span className="text-fg-2">{children}</span>
    </li>
  )
}

function GlifoAusente() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="2"
        fill="var(--dente-higido)"
        stroke="var(--dente-borda)"
        opacity="0.4"
      />
      <g stroke="var(--ausente)" strokeWidth="2" strokeLinecap="round">
        <line x1="4" y1="4" x2="16" y2="16" />
        <line x1="16" y1="4" x2="4" y2="16" />
      </g>
    </svg>
  )
}

function GlifoImplante() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
      <rect
        x="1"
        y="1"
        width="18"
        height="18"
        rx="2"
        fill="var(--dente-higido)"
        stroke="var(--dente-borda)"
        opacity="0.4"
      />
      <g stroke="var(--implante)" strokeWidth="1.6" strokeLinecap="round">
        <line x1="10" y1="4" x2="10" y2="16" />
        <line x1="6.5" y1="8" x2="13.5" y2="8" />
        <line x1="6.5" y1="11" x2="13.5" y2="11" />
        <line x1="6.5" y1="14" x2="13.5" y2="14" />
      </g>
    </svg>
  )
}
