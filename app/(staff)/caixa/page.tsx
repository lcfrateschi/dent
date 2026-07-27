import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { comissaoSobreLiquido, fluxoDeCaixaDoPeriodo } from '@/lib/caixa/consultas'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { PerguntaDaTela } from '../caixa/PerguntaDaTela'
import { Periodo, dataValida } from '../caixa/Periodo'

export const metadata: Metadata = { title: 'Fluxo de caixa' }

type Busca = { de?: string; ate?: string }

/**
 * Fluxo de caixa — **regime de caixa**, pela data em que o dinheiro se moveu.
 *
 * ── Por que as três linhas de entrada, e não uma ────────────────────────────
 * Bruto, taxa e líquido aparecem separados porque servem a duas pessoas diferentes. O
 * recibo do paciente diz R$ 100; o extrato do banco diz R$ 97,51. Mostrar só o bruto
 * faz o sistema não bater com o banco; mostrar só o líquido faz o recibo do paciente
 * não bater com o sistema. Os três números resolvem os dois lados, e a diferença passa a
 * ter nome — MDR — em vez de ser um erro de R$ 2,49 que ninguém explica.
 *
 * ── Por que produção não aparece aqui ──────────────────────────────────────
 * Decisão fechada do projeto: **caixa e produção nunca são somados.** Executado em julho
 * pode entrar em outubro. Quem quer produção vai em Relatórios, e não existe (nem deve
 * passar a existir) função que devolva a soma dos dois.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  await exigirPermissaoPagina('despesa', 'ler')
  const { de, ate } = await searchParams

  const hoje = await hojeDaClinica()
  const deIso = dataValida(de) ?? `${hoje.slice(0, 7)}-01`
  const ateIso = dataValida(ate) ?? hoje

  const [fluxo, sobreLiquido] = await Promise.all([
    fluxoDeCaixaDoPeriodo({ de: deIso, ate: ateIso }),
    comissaoSobreLiquido(),
  ])

  const negativo = fluxo.resultadoDeCaixa.startsWith('-')

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PerguntaDaTela
        titulo="Fluxo de caixa"
        pergunta={`quanto entrou e saiu do banco entre ${dataBr(deIso)} e ${dataBr(ateIso)}?`}
        regime="Regime de caixa: manda a data do PAGAMENTO. Uma despesa de julho paga em agosto aparece em agosto."
        ativa="caixa"
      />

      <Periodo deIso={deIso} ateIso={ateIso} rotulo="Ver período" />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Entrou (líquido)</p>
            {/*
              `data-teste` nos três números do resumo: `lib/caixa/verificar-telas.ts`
              precisa afirmar "as SAÍDAS de julho são 850,00", e procurar a string solta
              no HTML casa com qualquer card. Foi assim que uma asserção minha passou com
              a tela sabotada para somar pela competência — ela achou "850,00" no card de
              resultado (−850,00) e concluiu que o de saídas estava certo.
            */}
            <p data-teste="entradas-liquidas" className="mt-1 text-2xl font-semibold text-fg">
              {reais(fluxo.entradasLiquidas)}
            </p>
            <p className="mt-1 text-xs text-fg-3">
              {reais(fluxo.entradasBrutas)} pagos pelos pacientes − {reais(fluxo.taxas)} de taxa
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Saiu</p>
            <p data-teste="saidas" className="mt-1 text-2xl font-semibold text-fg">
              {reais(fluxo.saidas)}
            </p>
            <p className="mt-1 text-xs text-fg-3">despesas pagas no período</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Resultado de caixa</p>
            <p
              className={
                negativo
                  ? 'mt-1 text-2xl font-semibold text-critico'
                  : 'mt-1 text-2xl font-semibold text-fg'
              }
              data-teste="resultado-de-caixa"
            >
              {reais(fluxo.resultadoDeCaixa)}
            </p>
            {/*
              Resultado negativo é INFORMAÇÃO, não erro: o mês em que a clínica pagou o
              13º e faturou pouco fecha no vermelho, e esconder isso seria o oposto do
              que a tela existe para fazer.
            */}
            <p className="mt-1 text-xs text-fg-3">
              {negativo ? 'saiu mais do que entrou no período' : 'líquido que entrou menos o que saiu'}
            </p>
          </CardBody>
        </Card>
      </div>

      {/*
        A base da comissão fica visível porque a escolha muda a folha de todo dentista, e
        ninguém deve descobri-la por diferença entre dois relatórios. `false` (bruto) é o
        padrão porque é o que NÃO altera a folha de quem já operava — não porque seja o
        certo. A decisão é da clínica e está registrada como pergunta aberta.
      */}
      <div className="rounded-(--radius-controle) border-l-2 border-primary bg-surface-2 px-3 py-2.5 text-sm text-fg-2">
        Base da comissão em uso: <strong className="font-medium text-fg">
          {sobreLiquido ? 'valor líquido' : 'valor bruto'}
        </strong>
        {sobreLiquido
          ? ' — a taxa do meio de pagamento é descontada antes de calcular a comissão.'
          : ' — a comissão incide sobre o valor pago pelo paciente, sem descontar a taxa.'}{' '}
        Trocar é decisão da clínica (é contrato de trabalho), em Ajustes.
      </div>

      <Card>
        <CardHeader
          titulo="Para onde o dinheiro foi"
          descricao="Só o que foi PAGO no período, agrupado pela categoria da despesa."
        />
        {fluxo.porCategoria.length === 0 ? (
          <CardBody>
            <p className="text-sm text-fg-2">
              Nenhuma despesa paga entre {dataBr(deIso)} e {dataBr(ateIso)}. Se você lançou
              despesas e elas não aparecem aqui, provavelmente ainda não foram pagas — veja
              &ldquo;o que ainda devo&rdquo;.
            </p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {fluxo.porCategoria.map((c) => (
              <li key={c.categoria} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0">
                  <span className="text-sm text-fg">{c.categoria}</span>
                  <span className="ml-2 text-xs text-fg-3">
                    {c.natureza === 'fixa' ? 'fixa' : 'variável'}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-medium text-fg">{reais(c.valor)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-fg-3">
        Esta tela não soma <strong>caixa</strong> com <strong>produção</strong>, e isso é
        deliberado: são grandezas diferentes — um procedimento executado em julho pode ser
        recebido em outubro. Produção fica em Relatórios.
      </p>
    </div>
  )
}
