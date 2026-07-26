import { Card, CardBody } from '@/components/ui/Card'
import type { Metadata } from 'next'
import Link from 'next/link'
import { FormularioConvite } from './Formulario'

export const metadata: Metadata = { title: 'Primeiro acesso' }

/**
 * Primeiro acesso com o código de convite.
 *
 * O token pode vir na URL (`?codigo=...`) para o link ficar clicável, ou ser
 * digitado. Vir na URL tem um custo — fica no histórico do navegador — e é o
 * motivo de ele ser de **uso único** e expirar em 7 dias: depois de a senha existir,
 * o link no histórico não abre nada.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ codigo?: string }>
}) {
  const { codigo } = await searchParams

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Primeiro acesso</h1>
        <p className="text-sm text-fg-3">
          Use o código que a clínica te passou para criar sua senha.
        </p>
      </div>

      <Card>
        <CardBody>
          <FormularioConvite codigoInicial={codigo ?? ''} />
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        O código vale por 7 dias e só pode ser usado uma vez. Se o seu expirou, peça outro na
        clínica.{' '}
        <Link href="/meu/entrar" className="text-primary hover:underline">
          Já tenho senha
        </Link>
      </p>
    </div>
  )
}
