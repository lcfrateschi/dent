import { Card, CardBody } from '@/components/ui/Card'
import { SessaoProvider } from '@/components/ui/SessaoProvider'
import type { Metadata } from 'next'
import { ConfigurarMfa } from './ConfigurarMfa'

export const metadata: Metadata = { title: 'Verificação em duas etapas' }

export default function Page() {
  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <Card>
        <CardBody>
          <SessaoProvider>
            <ConfigurarMfa />
          </SessaoProvider>
        </CardBody>
      </Card>
    </div>
  )
}
