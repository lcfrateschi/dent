import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import {
  itensSemOrdem,
  laboratoriosAtivos,
  ordensDeLaboratorio,
} from '@/lib/periodontal/consultas'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { NovaOrdem, SituacaoDaOrdem } from './Controles'

export const metadata: Metadata = { title: 'Laboratório' }

/**
 * A fila do laboratório de prótese.
 *
 * ── A pergunta que esta tela responde ───────────────────────────────────────
 * "O que devia ter voltado e não voltou?" — não "quais ordens existem". Por isso o
 * que está fora da clínica vem primeiro, ordenado por prazo, e o vencido é marcado.
 * Uma peça atrasada é um paciente com consulta marcada que vai ser desmarcada, e
 * quem descobre isso no dia perde a cadeira e a confiança.
 *
 * ── Custo aqui NÃO é despesa ────────────────────────────────────────────────
 * `custo` é o valor **combinado** com o laboratório, e serve para conferir a nota
 * quando ela chegar. A despesa é a nota — o laboratório fatura por mês, cobrindo
 * várias peças, e uma despesa por ordem produziria N lançamentos que não casam com
 * ela. Ver o cabeçalho de `lib/db/schema/laboratorio.ts`.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ todas?: string }>
}) {
  const { todas } = await searchParams
  const ator = await exigirPermissaoPagina('plano_tratamento', 'ler')
  const podeEditar = pode(ator.perfil, 'plano_tratamento', 'editar')
  const podeCriar = pode(ator.perfil, 'plano_tratamento', 'criar')

  const incluirFechadas = todas === '1'
  const [ordens, labs, itens] = await Promise.all([
    ordensDeLaboratorio(incluirFechadas),
    podeCriar ? laboratoriosAtivos() : Promise.resolve([]),
    podeCriar ? itensSemOrdem() : Promise.resolve([]),
  ])

  const hoje = new Date().toISOString().slice(0, 10)
  const atrasadas = ordens.filter(
    (o) => (o.situacao === 'aberta' || o.situacao === 'enviada') && o.prazoEm && o.prazoEm < hoje,
  ).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Laboratório</h1>
        <p className="mt-1 text-sm text-fg-2">
          {atrasadas > 0
            ? `${atrasadas} peça(s) fora do prazo.`
            : 'Nenhuma peça fora do prazo.'}{' '}
          O custo aqui é o combinado — a nota do laboratório é lançada como despesa.
        </p>
      </div>

      {podeCriar && labs.length > 0 && itens.length > 0 && (
        <Card>
          <CardHeader
            titulo="Nova ordem"
            descricao="A ordem pende de um item do plano: prótese sem item é custo sem receita, e a margem não fecha."
          />
          <CardBody>
            <NovaOrdem laboratorios={labs} itens={itens} />
          </CardBody>
        </Card>
      )}

      {podeCriar && (labs.length === 0 || itens.length === 0) && (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              {labs.length === 0
                ? 'Nenhum laboratório cadastrado ainda.'
                : 'Nenhum item de plano ativo sem ordem — nada a enviar agora.'}
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          titulo={incluirFechadas ? 'Todas as ordens' : 'Fora da clínica'}
          descricao={
            incluirFechadas
              ? 'Inclui recebidas e canceladas.'
              : 'Abertas e enviadas, por prazo. Sem prazo combinado desce — não é a mais urgente, é a que ninguém combinou.'
          }
        />
        <CardBody>
          {ordens.length === 0 ? (
            <p className="text-sm text-fg-2">
              {incluirFechadas ? 'Nenhuma ordem registrada.' : 'Nada fora da clínica.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-fg-2">
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Nº
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Paciente
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Peça
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Laboratório
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Prazo
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Custo
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Situação
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ordens.map((o) => {
                    const vencida =
                      (o.situacao === 'aberta' || o.situacao === 'enviada') &&
                      o.prazoEm !== null &&
                      o.prazoEm < hoje
                    return (
                      <tr key={o.id} className="border-b border-border/50 align-top">
                        <td className="py-2 pr-2 tabular-nums font-medium text-fg">{o.numero}</td>
                        <td className="py-2 pr-2">{o.pacienteNome}</td>
                        <td className="py-2 pr-2">
                          <div className="text-fg">
                            {o.procedimentoNome}
                            {o.denteFdi ? ` — dente ${o.denteFdi}` : ''}
                          </div>
                          <div className="text-xs text-fg-2">{o.especificacao}</div>
                          {o.cor && <div className="text-xs text-fg-3">Cor {o.cor}</div>}
                          {o.refazNumero !== null && (
                            <div className="text-xs text-atencao">
                              refaz a ordem {o.refazNumero}
                              {o.motivoRefacao ? `: ${o.motivoRefacao}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-fg-2">{o.laboratorioNome}</td>
                        <td className="py-2 pr-2 tabular-nums">
                          {o.prazoEm ? (
                            <span className={vencida ? 'font-medium text-critico' : ''}>
                              {dataBr(o.prazoEm)}
                            </span>
                          ) : (
                            <span className="text-fg-3">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-2 tabular-nums">{reais(o.custo)}</td>
                        <td className="py-2">
                          <SituacaoDaOrdem
                            id={o.id}
                            situacao={o.situacao}
                            podeEditar={podeEditar}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-fg-2">
            <a
              className="underline"
              href={incluirFechadas ? '/laboratorio' : '/laboratorio?todas=1'}
            >
              {incluirFechadas ? 'Ver só o que está fora da clínica' : 'Ver todas as ordens'}
            </a>
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
