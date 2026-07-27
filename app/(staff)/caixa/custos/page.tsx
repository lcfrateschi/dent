import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { despesasPorCompetencia, recorrentesAtivas } from '@/lib/caixa/consultas'
import { somar } from '@/lib/domain/dinheiro'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { PerguntaDaTela } from '../PerguntaDaTela'
import { Periodo, dataValida } from '../Periodo'

export const metadata: Metadata = { title: 'Quanto o mês custou' }

type Busca = { de?: string; ate?: string }

/**
 * Custo por **competência** — pela data a que a despesa pertence, não pela do pagamento.
 *
 * ── O número que esta tela existe para dar ──────────────────────────────────
 * `fixas` responde "de quanto eu preciso por mês com zero paciente?". É a conta que
 * decide se a clínica aguenta um mês fraco, e quase nenhum consultório sabe de cabeça.
 * Por isso ela aparece separada, e não diluída no total.
 *
 * ── Por que o total daqui não bate com o do fluxo de caixa ──────────────────
 * Porque são perguntas diferentes, e as duas estão certas. O aluguel de julho pago em
 * agosto entra **aqui** em julho e **lá** em agosto. Se as duas telas mostrassem o mesmo
 * número, uma delas estaria mentindo — e há invariante no banco que reprova se os dois
 * regimes coincidirem no mês em que a despesa foi lançada e paga em meses distintos.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  await exigirPermissaoPagina('despesa', 'ler')
  const { de, ate } = await searchParams

  const hoje = await hojeDaClinica()
  const primeiroDoMes = `${hoje.slice(0, 7)}-01`
  const deIso = dataValida(de) ?? primeiroDoMes
  const ateIso = dataValida(ate) ?? hoje

  const [custo, recorrentes] = await Promise.all([
    despesasPorCompetencia({ de: deIso, ate: ateIso }),
    recorrentesAtivas(),
  ])

  const totalRecorrente =
    recorrentes.length === 0 ? '0.00' : somar(...recorrentes.map((r) => r.valor))

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PerguntaDaTela
        titulo="Quanto o mês custou"
        pergunta={`quanto a clínica consumiu entre ${dataBr(deIso)} e ${dataBr(ateIso)}?`}
        regime="Regime de competência: manda a data a que a despesa PERTENCE. O aluguel de julho conta em julho, mesmo que seja pago em agosto."
        ativa="custos"
      />

      <Periodo deIso={deIso} ateIso={ateIso} rotulo="Ver período" />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Custo do período</p>
            <p className="mt-1 text-2xl font-semibold text-fg">{reais(custo.total)}</p>
            <p className="mt-1 text-xs text-fg-3">despesas canceladas ficam fora</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Fixas</p>
            <p className="mt-1 text-2xl font-semibold text-fg">{reais(custo.fixas)}</p>
            <p className="mt-1 text-xs text-fg-3">
              o que vem com zero paciente — é o piso do mês
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Variáveis</p>
            <p className="mt-1 text-2xl font-semibold text-fg">{reais(custo.variaveis)}</p>
            <p className="mt-1 text-xs text-fg-3">acompanham o atendimento</p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          titulo="Por categoria"
          descricao="Pela competência da despesa. Não é plano de contas — a clínica ajusta a lista em Ajustes."
        />
        {custo.porCategoria.length === 0 ? (
          <CardBody>
            <p className="text-sm text-fg-2">
              Nenhuma despesa com competência entre {dataBr(deIso)} e {dataBr(ateIso)}.
            </p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {custo.porCategoria.map((c) => (
              <li
                key={c.categoria}
                className="flex items-baseline justify-between gap-3 px-4 py-2.5"
              >
                <span className="min-w-0 truncate text-sm text-fg">{c.categoria}</span>
                <span className="shrink-0 text-sm font-medium text-fg">{reais(c.valor)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          titulo="Recorrentes ativas"
          descricao="Regras, não lançamentos. A despesa nasce quando a competência chega."
        />
        {recorrentes.length === 0 ? (
          <CardBody>
            <p className="text-sm text-fg-2">
              Nenhuma regra recorrente cadastrada. Aluguel, contador e software costumam ser
              as primeiras.
            </p>
          </CardBody>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {recorrentes.map((r) => (
                <li
                  key={`${r.descricao}-${r.diaVencimento}`}
                  className="flex items-baseline justify-between gap-3 px-4 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-fg">{r.descricao}</span>
                    <span className="text-xs text-fg-3">
                      {r.categoria} · vence dia {r.diaVencimento}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium text-fg">{reais(r.valor)}</span>
                </li>
              ))}
            </ul>
            <CardBody className="border-t border-border">
              {/*
                Projeção é CÁLCULO, não escrita. Materializar 240 linhas por aluguel
                transformaria o reajuste anual em "editar 240 linhas futuras, ou algumas
                e esquecer", e encheria a fila de contas a pagar de coisa que ninguém
                deve ainda.
              */}
              <p className="text-sm text-fg-2">
                Somam <strong className="font-medium text-fg">{reais(totalRecorrente)}</strong> por
                mês. Este número é <strong>projeção</strong>: nada foi gravado no futuro. As
                despesas aparecem em &ldquo;o que ainda devo&rdquo; quando a competência chega.
              </p>
            </CardBody>
          </>
        )}
      </Card>
    </div>
  )
}
