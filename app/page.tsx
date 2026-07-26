import { atorAtual } from '@/lib/authz/sessao'
import { redirect } from 'next/navigation'

export default async function Home() {
  const ator = await atorAtual()
  redirect(ator ? '/pacientes' : '/entrar')
}
