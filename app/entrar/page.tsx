import { Card, CardBody } from '@/components/ui/Card'
import type { Metadata } from 'next'
import { FormularioEntrada } from './FormularioEntrada'

export const metadata: Metadata = { title: 'Entrar' }

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ proximo?: string }>
}) {
  const { proximo } = await searchParams

  // Só caminho interno: `?proximo=https://outro.site` viraria open redirect.
  const destino = proximo && proximo.startsWith('/') && !proximo.startsWith('//')
    ? proximo
    : '/pacientes'

  return (
    <div className="mx-auto flex min-h-dvh max-w-md items-center px-4 py-10">
      <div className="w-full">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-fg">dent</h1>
          <p className="mt-1 text-sm text-fg-3">Acesso restrito à equipe da clínica</p>
        </div>

        <Card>
          <CardBody>
            <FormularioEntrada proximo={destino} />
          </CardBody>
        </Card>

        <p className="mt-4 text-center text-xs text-fg-3">
          Todo acesso a prontuário é registrado em trilha de auditoria.
        </p>
      </div>
    </div>
  )
}
