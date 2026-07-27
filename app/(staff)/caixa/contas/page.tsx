import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { categoriasDeDespesa, contasAPagar, pagamentosDaDespesa } from '@/lib/caixa/consultas'
import { somar } from '@/lib/domain/dinheiro'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { PerguntaDaTela } from '../PerguntaDaTela'
import { Contas, type ContaNaTela } from './Controles'

export const metadata: Metadata = { title: 'O que ainda devo' }

type Busca = { pagas?: string; lancar?: string }

/**
 * Contas a pagar — a fila, em ordem de **vencimento**.
 *
 * ── Por que o saldo é derivado e não uma coluna ─────────────────────────────
 * `saldo` e `situacao` saem da soma dos pagamentos não estornados, calculada na leitura.
 * Coluna de saldo é a que fica errada primeiro — o mesmo motivo pelo qual
 * `lote_material.saldo` é mantido por trigger e recusa `UPDATE` à mão. Aqui não há nem
 * trigger: não existe a coluna.
 *
 * ── O que esta tela mostra e o fluxo de caixa não ──────────────────────────
 * Dívida em aberto. Uma conta lançada e não paga aparece aqui e **não** aparece no fluxo
 * de caixa — porque o dinheiro não se moveu. As duas telas discordarem é o
 * comportamento correto.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  const ator = await exigirPermissaoPagina('despesa', 'ler')
  const { pagas, lancar } = await searchParams
  const incluirPagas = pagas === '1'

  const [hoje, contas, categorias] = await Promise.all([
    hojeDaClinica(),
    contasAPagar({ incluirPagas }),
    categoriasDeDespesa(),
  ])

  // Os pagamentos de cada conta, para a tela poder oferecer o estorno sem uma segunda
  // navegação. `Promise.all` sobre a lista já filtrada — a fila de um consultório tem
  // dezenas de linhas, não milhares.
  const pagamentosPorConta = await Promise.all(contas.map((c) => pagamentosDaDespesa(c.id)))

  const linhas: ContaNaTela[] = contas.map((c, i) => ({
    id: c.id,
    descricao: c.descricao,
    categoria: c.categoria,
    fornecedor: c.fornecedor,
    valorBr: reais(c.valor),
    pagoBr: reais(c.pago),
    saldoBr: reais(c.saldo),
    saldoCru: c.saldo,
    vencimentoBr: dataBr(c.vencimento),
    competenciaBr: dataBr(c.competencia),
    situacao: c.situacao,
    diasDeAtraso: c.diasDeAtraso,
    pagamentos: (pagamentosPorConta[i] ?? []).map((p) => ({
      id: p.id,
      valorBr: reais(p.valor),
      pagoEmBr: dataBr(p.pagoEm),
      meio: p.meio,
      estornado: p.estornado,
      motivoEstorno: p.motivoEstorno,
    })),
  }))

  const emAberto = contas.filter((c) => c.situacao !== 'paga' && c.situacao !== 'cancelada')
  const totalEmAberto = emAberto.length === 0 ? '0.00' : somar(...emAberto.map((c) => c.saldo))
  const vencidas = emAberto.filter((c) => c.situacao === 'vencida')
  const totalVencido = vencidas.length === 0 ? '0.00' : somar(...vencidas.map((c) => c.saldo))

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PerguntaDaTela
        titulo="O que ainda devo"
        pergunta="quais contas estão em aberto, e quais já venceram?"
        regime="Ordenado por VENCIMENTO. Uma conta só sai desta fila quando é paga por inteiro ou cancelada com motivo."
        ativa="contas"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Em aberto</p>
            <p className="mt-1 text-2xl font-semibold text-fg">{reais(totalEmAberto)}</p>
            <p className="mt-1 text-xs text-fg-3">{emAberto.length} conta(s)</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">Vencido</p>
            {/*
              Zero vencido é notícia boa, não um número: "—" em vez de "R$ 0,00" pela
              mesma regra que faz taxa sem base ser `null` e não zero.
            */}
            <p
              className={
                vencidas.length > 0
                  ? 'mt-1 text-2xl font-semibold text-critico'
                  : 'mt-1 text-2xl font-semibold text-fg-3'
              }
            >
              {vencidas.length > 0 ? reais(totalVencido) : '—'}
            </p>
            <p className="mt-1 text-xs text-fg-3">
              {vencidas.length > 0 ? `${vencidas.length} conta(s) fora do prazo` : 'nada fora do prazo'}
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          titulo="A fila"
          descricao={
            incluirPagas
              ? 'Todas as contas, inclusive pagas e canceladas.'
              : 'Só o que está em aberto. Pagas e canceladas ficam fora.'
          }
          acoes={
            <a
              href={incluirPagas ? '/caixa/contas' : '/caixa/contas?pagas=1'}
              className="rounded-(--radius-controle) border border-border bg-surface px-3 py-1.5 text-sm text-fg-2 hover:bg-surface-2"
            >
              {incluirPagas ? 'Ver só em aberto' : 'Ver todas'}
            </a>
          }
        />
        <CardBody>
          <Contas
            contas={linhas}
            categorias={categorias.map((c) => ({
              id: c.id,
              nome: c.nome,
              natureza: c.natureza,
            }))}
            hojeIso={hoje}
            podeLancar={pode(ator.perfil, 'despesa', 'criar')}
            podeBaixar={pode(ator.perfil, 'despesa', 'editar')}
            podeDesfazer={pode(ator.perfil, 'despesa', 'excluir')}
            abrirLancamento={lancar === '1'}
          />
        </CardBody>
      </Card>

      {!pode(ator.perfil, 'despesa', 'excluir') && (
        <p className="text-xs text-fg-3">
          Seu perfil lança e paga, mas não cancela despesa nem estorna pagamento — as duas
          desfazem dinheiro que já se moveu, e respondem ao financeiro.
        </p>
      )}
    </div>
  )
}
