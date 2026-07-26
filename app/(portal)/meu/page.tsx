import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { FUSO_PADRAO } from '@/lib/domain/fuso'
import { quandoEmPortugues } from '@/lib/domain/textoMensagem'
import {
  historicoDeAtendimentos,
  proximasConsultas,
  registrarAcessoDoPortal,
} from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AcoesDaConsulta } from './AcoesDaConsulta'

export const metadata: Metadata = { title: 'Início' }

/**
 * Início do portal.
 *
 * A próxima consulta primeiro, e o botão de confirmar junto dela — é o que 90% dos
 * acessos vêm fazer. O resto (histórico, orçamentos, pagamentos) fica abaixo e no
 * menu.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  // Segunda tranca: o middleware só olha a presença do cookie, e presença de
  // cookie não é sessão. Quem autentica é isto.
  if (!sessao) redirect('/meu/entrar')

  const agora = new Date()
  const [consultas, historico] = await Promise.all([
    proximasConsultas(sessao, agora),
    historicoDeAtendimentos(sessao, 10),
  ])

  await registrarAcessoDoPortal(sessao, 'inicio', { consultas: consultas.length })

  const proxima = consultas[0]

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-fg">Olá, {primeiroNome(sessao.nome)}</h1>

      {proxima ? (
        <Card>
          <CardHeader
            titulo="Sua próxima consulta"
            descricao={
              proxima.confirmadoEm
                ? 'Confirmada. Até lá!'
                : 'Confirme para a clínica saber que você vem.'
            }
          />
          <CardBody className="space-y-3">
            <div>
              <p className="text-lg font-semibold text-fg">
                {quandoEmPortugues(proxima.inicio, FUSO_PADRAO)}
              </p>
              <p className="text-sm text-fg-2">com {proxima.profissionalNome}</p>
            </div>

            {proxima.confirmadoEm ? (
              <p className="flex items-center gap-1.5 text-sm font-medium text-sucesso">
                <Icone nome="confirmado" tamanho={15} />
                Você confirmou esta consulta
              </p>
            ) : (
              <AcoesDaConsulta agendamentoId={proxima.id} />
            )}
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Você não tem consulta marcada. Fale com a clínica para agendar.
            </p>
          </CardBody>
        </Card>
      )}

      {consultas.length > 1 ? (
        <Card>
          <CardHeader titulo="Outras consultas marcadas" />
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {consultas.slice(1).map((c) => (
                <li key={c.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-medium text-fg">
                      {quandoEmPortugues(c.inicio, FUSO_PADRAO)}
                    </span>
                    <span className="text-sm text-fg-3">com {c.profissionalNome}</span>
                    {c.confirmadoEm ? (
                      <span className="ml-auto text-xs font-medium text-sucesso">
                        <span aria-hidden>✓</span> confirmada
                      </span>
                    ) : null}
                  </div>
                  {c.confirmadoEm ? null : <AcoesDaConsulta agendamentoId={c.id} />}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo="Seus atendimentos"
          descricao="Quando você veio e com quem. Para o prontuário completo, peça na clínica."
        />
        <CardBody className="p-0">
          {historico.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Nenhum atendimento registrado ainda.</p>
          ) : (
            <ul className="divide-y divide-border">
              {historico.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-sm">
                  <span className="text-fg">
                    {h.inicio.toLocaleDateString('pt-BR', { timeZone: FUSO_PADRAO })}
                  </span>
                  <span className="text-fg-2">{h.profissionalNome}</span>
                  {h.status === 'faltou' ? (
                    <span className="ml-auto text-xs text-atencao">não compareceu</span>
                  ) : (
                    <span className="ml-auto text-xs text-fg-3">atendido</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Atalho href="/meu/orcamentos" icone="cobranca" rotulo="Orçamentos" />
        <Atalho href="/meu/financeiro" icone="financeiro" rotulo="Pagamentos" />
        <Atalho href="/meu/documentos" icone="documentos" rotulo="Documentos" />
      </div>
    </div>
  )
}

function Atalho({
  href,
  icone,
  rotulo,
}: {
  href: string
  icone: 'cobranca' | 'financeiro' | 'documentos'
  rotulo: string
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-(--radius-cartao) border border-border bg-surface px-4 py-3 text-sm font-medium text-fg hover:bg-surface-2"
    >
      <Icone nome={icone} tamanho={16} />
      {rotulo}
    </Link>
  )
}

function primeiroNome(nome: string): string {
  return nome.trim().split(' ')[0] ?? nome
}
