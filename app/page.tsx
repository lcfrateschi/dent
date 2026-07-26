import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import Link from 'next/link'

export default function Home() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold text-fg">dent</h1>
      <p className="mt-1 text-sm text-fg-3">
        Sistema de gestão para consultório odontológico. Fase 1 (domínio e banco) e o protótipo do
        odontograma prontos. Ver <code className="text-fg-2">ROADMAP.md</code>.
      </p>

      <Card className="mt-6">
        <CardHeader titulo="Design system" descricao="Componentes em revisão" />
        <CardBody>
          <Link
            href="/design/odontograma"
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            Odontograma →
          </Link>
        </CardBody>
      </Card>
    </div>
  )
}
