import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { SessaoProvider } from '@/components/ui/SessaoProvider'
import { atorAtual } from '@/lib/authz/sessao'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { TrocarSenha } from './TrocarSenha'

export const metadata: Metadata = { title: 'Trocar senha' }

/**
 * Troca de senha obrigatória no primeiro acesso.
 *
 * O admin cria o usuário com uma senha gerada e a dita por telefone ou entrega no
 * balcão. Uma senha que passou por terceiro é uma senha comprometida — o
 * middleware prende quem tem `senhaTemporaria` aqui, do mesmo jeito que prende
 * quem ainda não configurou o MFA.
 *
 * A ordem é MFA primeiro, senha depois: trocar a senha já protegido por segundo
 * fator é melhor do que trocá-la tendo só a credencial que passou pelo telefone.
 */
export default async function Page() {
  const ator = await atorAtual()
  if (!ator) redirect('/entrar')

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <Card>
        <CardHeader
          titulo="Escolha sua senha"
          descricao="A senha que você recebeu foi criada por outra pessoa. Troque-a agora — ela não serve como senha definitiva."
        />
        <CardBody>
          <SessaoProvider>
            <TrocarSenha />
          </SessaoProvider>
        </CardBody>
      </Card>
    </div>
  )
}
