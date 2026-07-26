import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { sessaoAtual } from '@/lib/portal/sessao'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { FormularioEntrar } from './Formulario'

export const metadata: Metadata = { title: 'Entrar' }

/**
 * Login do paciente.
 *
 * Sem MFA, e isso é escolha consciente: exigir autenticador de um paciente que
 * entra três vezes por ano produziria abandono, não segurança. O que compensa é o
 * bloqueio por tentativas, a sessão de 12 horas e a possibilidade de revogar —
 * está tudo em `lib/portal/sessao.ts` e `lib/domain/bloqueio.ts`.
 */
export default async function Page() {
  // Quem já tem sessão não precisa ver esta tela.
  if (await sessaoAtual()) redirect('/meu')

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Entrar</h1>
        <p className="text-sm text-fg-3">
          Acesse suas consultas, orçamentos e pagamentos.
        </p>
      </div>

      <Card>
        <CardBody>
          <FormularioEntrar />
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Primeiro acesso" />
        <CardBody className="space-y-2 text-sm text-fg-2">
          <p>
            Se a clínica te deu um código de convite, use ele para criar sua senha.
          </p>
          <Link href="/meu/convite" className="font-medium text-primary hover:underline">
            Tenho um código de convite
          </Link>
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        Esqueceu a senha? Fale com a clínica — por segurança, a redefinição é feita lá, e não por
        e-mail.
      </p>
    </div>
  )
}
