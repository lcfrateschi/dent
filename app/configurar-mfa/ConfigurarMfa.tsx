'use client'

import { Button } from '@/components/ui/Button'
import { Alerta, Input } from '@/components/ui/Input'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { type DadosConfiguracaoMfa, ativarMfa, prepararMfa } from './acoes'

export function ConfigurarMfa() {
  const router = useRouter()
  const { update } = useSession()
  const [dados, setDados] = useState<DadosConfiguracaoMfa | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [mostrarSegredo, setMostrarSegredo] = useState(false)

  useEffect(() => {
    prepararMfa()
      .then(setDados)
      .catch((e: unknown) => setErro(e instanceof Error ? e.message : 'Falha ao preparar.'))
  }, [])

  async function confirmar(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    setErro(null)
    setEnviando(true)

    const codigo = String(new FormData(e.currentTarget).get('codigo') ?? '')
    const r = await ativarMfa(codigo)

    if (!r.ok) {
      setErro(r.erro)
      setEnviando(false)
      return
    }

    // Atualiza o token sem novo login, senão o middleware devolve para cá.
    await update({ mfaAtivo: true })
    router.replace('/pacientes')
    router.refresh()
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-fg">Verificação em duas etapas</h1>
        <p className="mt-1 text-sm text-fg-2">
          É obrigatória para toda a equipe. Este sistema guarda prontuário: senha sozinha não
          protege contra credencial reaproveitada de outro site.
        </p>
      </div>

      {erro ? <Alerta>{erro}</Alerta> : null}

      {!dados ? (
        <p className="text-sm text-fg-3">Preparando…</p>
      ) : (
        <>
          <ol className="space-y-4 text-sm text-fg-2">
            <li>
              <strong className="text-fg">1.</strong> Instale um app autenticador — Google
              Authenticator, Microsoft Authenticator, Authy ou 1Password.
            </li>
            <li>
              <strong className="text-fg">2.</strong> Escaneie o código abaixo.
              <div className="mt-3 inline-block rounded-(--radius-controle) border border-border bg-white p-3">
                {/* SVG gerado no servidor; não há requisição externa de imagem. */}
                <div
                  className="size-44 [&>svg]:size-full"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG do próprio servidor
                  dangerouslySetInnerHTML={{ __html: dados.qrSvg }}
                />
              </div>
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setMostrarSegredo((v) => !v)}
                  className="text-xs text-primary underline underline-offset-2"
                >
                  {mostrarSegredo ? 'Ocultar' : 'Não consigo escanear — digitar manualmente'}
                </button>
                {mostrarSegredo ? (
                  <p className="mt-1 font-mono text-xs break-all text-fg-2 select-all">
                    {dados.segredo}
                  </p>
                ) : null}
              </div>
            </li>
            <li>
              <strong className="text-fg">3.</strong> Digite o código de 6 dígitos que o app
              mostrar.
            </li>
          </ol>

          <form onSubmit={confirmar} className="max-w-52 space-y-3">
            <Input
              id="codigo"
              name="codigo"
              rotulo="Código do app"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="000000"
              autoFocus
              obrigatorio
            />
            <Button type="submit" variante="primario" tamanho="lg" disabled={enviando}>
              {enviando ? 'Confirmando…' : 'Ativar'}
            </Button>
          </form>

          <p className="text-xs text-fg-3">
            Guarde o acesso ao app. Perder o autenticador exige um administrador para reconfigurar.
          </p>
        </>
      )}
    </div>
  )
}
