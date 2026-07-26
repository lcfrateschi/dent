import Link from 'next/link'

/**
 * 404 do App Router.
 *
 * `notFound()` — usado, por exemplo, quando o id de material da URL não existe —
 * precisa de uma página para renderizar. Sem este arquivo o visitante recebe o
 * 404 padrão do Next, em inglês e fora do tema.
 */
export default function NaoEncontrado() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm font-medium text-fg-3">404</p>
      <h1 className="text-xl font-semibold text-fg">Não encontramos esta página</h1>
      <p className="text-sm text-fg-2">
        O endereço pode ter mudado, ou o registro pode ter sido removido.
      </p>
      <Link
        href="/pacientes"
        className="mt-2 rounded-(--radius-controle) border border-border bg-surface px-4 py-2 text-sm text-fg hover:bg-surface-2"
      >
        Voltar ao início
      </Link>
    </main>
  )
}
