'use client'

/**
 * Erro não tratado na raiz.
 *
 * O App Router exige que este arquivo renderize `<html>` e `<body>` — ele
 * substitui o layout raiz inteiro, porque o erro pode ter acontecido dentro
 * dele. Sem ele, uma exceção no layout raiz deixa o usuário com tela branca.
 *
 * Não mostra a mensagem do erro: em sistema de prontuário, texto de exceção
 * pode carregar dado de paciente (nome em constraint, id em query).
 */
export default function ErroGlobal({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-dvh antialiased">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
          <h1 className="text-xl font-semibold">Algo deu errado</h1>
          <p className="text-sm">
            O erro foi registrado. Se acontecer de novo, avise quem administra o sistema.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            className="mt-2 rounded border px-4 py-2 text-sm"
          >
            Tentar de novo
          </button>
        </main>
      </body>
    </html>
  )
}
