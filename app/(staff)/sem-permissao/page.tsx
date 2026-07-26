import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import {
  ROTULO_PERFIL,
  ROTULO_RECURSO,
  type Recurso,
  acoesPermitidas,
} from '@/lib/authz/politicas'
import { exigirAtor } from '@/lib/authz/sessao'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Sem permissão' }

const ROTULO_ACAO: Record<string, string> = {
  ler: 'consultar',
  criar: 'cadastrar',
  editar: 'editar',
  excluir: 'excluir',
  assinar: 'assinar',
  exportar: 'exportar',
}

/**
 * Tela de 403.
 *
 * Diz o que o perfil PODE fazer, não só o que não pode — senão a pessoa fica
 * sem saber se pediu acesso errado ou se está no lugar errado. E deixa claro
 * que a restrição é intencional, para ninguém tratar como bug.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ recurso?: string; acao?: string }>
}) {
  const ator = await exigirAtor()
  const { recurso, acao } = await searchParams

  const nomeRecurso =
    recurso && recurso in ROTULO_RECURSO
      ? ROTULO_RECURSO[recurso as Recurso]
      : 'este recurso'
  const nomeAcao = acao ? (ROTULO_ACAO[acao] ?? acao) : 'acessar'

  const permitidas =
    recurso && recurso in ROTULO_RECURSO
      ? acoesPermitidas(ator.perfil, recurso as Recurso)
      : []

  return (
    <div className="mx-auto max-w-lg py-10">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-fg">Acesso não permitido</h1>
            <p className="mt-1 text-sm text-fg-2">
              Seu perfil <strong>{ROTULO_PERFIL[ator.perfil]}</strong> não pode{' '}
              <strong>{nomeAcao}</strong> em <strong>{nomeRecurso}</strong>.
            </p>
          </div>

          {permitidas.length > 0 ? (
            <p className="text-sm text-fg-2">
              Em {nomeRecurso.toLowerCase()}, seu perfil pode:{' '}
              {permitidas.map((a) => ROTULO_ACAO[a] ?? a).join(', ')}.
            </p>
          ) : (
            <p className="text-sm text-fg-2">
              Seu perfil não tem nenhum acesso a {nomeRecurso.toLowerCase()}.
            </p>
          )}

          <p className="text-xs text-fg-3">
            A separação de acessos é intencional: dado clínico, agenda e financeiro ficam
            restritos a quem precisa deles. Se você precisa deste acesso para trabalhar, fale com
            um administrador.
          </p>

          <div className="flex gap-2">
            <Link href="/pacientes">
              <Button variante="primario">Voltar</Button>
            </Link>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
