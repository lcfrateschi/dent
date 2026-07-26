import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { ROTULO_MOVIMENTO } from '@/lib/domain/estoque'
import { formatarQuantidade } from '@/lib/domain/quantidade'
import {
  extratoDeMovimentos,
  lotesVencendo,
  posicaoDeEstoque,
  resumoDoEstoque,
} from '@/lib/estoque/consultas'
import { cn } from '@/lib/ui/cn'
import { dataBr, dataHoraBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Estoque' }

/**
 * Painel de estoque.
 *
 * A ordem responde à pergunta que a clínica faz de manhã — **"o que eu preciso
 * comprar e o que vai vencer?"** — e não "quanto tem de cada coisa". A segunda
 * pergunta é a que um relatório responde; a primeira é a que muda o dia.
 *
 * Por isso a lista de reposição vem antes da posição geral, e a validade traz o
 * **valor em risco**: "3 lotes vencendo" não move ninguém, "R$ 340 vencendo em
 * 20 dias" move.
 */
export default async function Page() {
  const ator = await exigirPermissaoPagina('estoque', 'ler')

  const [resumo, atencao, todos, vencendo, extrato] = await Promise.all([
    resumoDoEstoque(),
    posicaoDeEstoque({ apenasAtencao: true }),
    posicaoDeEstoque(),
    lotesVencendo(60),
    extratoDeMovimentos({ limite: 25 }),
  ])

  const podeMovimentar = pode(ator.perfil, 'estoque', 'criar')
  const podeCadastrar = pode(ator.perfil, 'estoque', 'excluir')
  const vencidos = vencendo.filter((l) => l.avaliacao.situacao === 'vencido')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
            <Icone nome="estoque" tamanho={18} />
            Estoque
          </h1>
          <p className="text-sm text-fg-3">Materiais, lotes, validade e reposição</p>
        </div>
        {podeCadastrar ? (
          <Link
            href="/estoque/fichas"
            className="rounded-(--radius-controle) border border-border bg-surface px-4 py-2 text-sm text-fg hover:bg-surface-2"
          >
            Fichas e materiais
          </Link>
        ) : null}
      </div>

      {vencidos.length > 0 ? (
        <Alerta tipo="critico">
          <strong>
            {vencidos.length} lote(s) VENCIDO(S) com saldo, somando {reais(resumo.valorVencido)}.
          </strong>{' '}
          O sistema recusa consumir lote vencido, mas ele continua na prateleira — e prateleira é
          onde a pessoa pega. Descarte com motivo para o saldo (e o alerta) saírem daqui.
        </Alerta>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Cartao rotulo="Materiais ativos" valor={String(resumo.materiais)} />
        <Cartao
          rotulo="Abaixo do mínimo"
          valor={String(resumo.abaixoDoMinimo + resumo.zerados)}
          detalhe={resumo.zerados > 0 ? `${resumo.zerados} zerado(s)` : undefined}
          tom={resumo.abaixoDoMinimo + resumo.zerados > 0 ? 'atencao' : 'neutro'}
        />
        <Cartao
          rotulo="Lotes vencendo (60 dias)"
          valor={String(resumo.lotesVencendo)}
          detalhe={resumo.lotesVencidos > 0 ? `${resumo.lotesVencidos} já vencido(s)` : undefined}
          tom={resumo.lotesVencidos > 0 ? 'critico' : resumo.lotesVencendo > 0 ? 'atencao' : 'neutro'}
        />
        <Cartao rotulo="Valor em estoque" valor={reais(resumo.valorTotal)} />
      </div>

      <Card>
        <CardHeader
          titulo="Precisa de atenção"
          descricao="Abaixo do mínimo, zerado ou com lote vencendo. Material em ordem não aparece aqui — lista de 40 itens em que 3 importam é lista que ninguém lê."
        />
        <CardBody className="p-0">
          {atencao.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">
              Nada abaixo do mínimo e nada vencendo nos próximos 60 dias.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                    <th className="px-4 py-2 font-medium">Material</th>
                    <th className="px-4 py-2 font-medium">Saldo</th>
                    <th className="px-4 py-2 font-medium">Mínimo</th>
                    <th className="px-4 py-2 font-medium">Situação</th>
                    <th className="px-4 py-2 font-medium">Comprar</th>
                    <th className="px-4 py-2 font-medium">Validade</th>
                  </tr>
                </thead>
                <tbody>
                  {atencao.map((l) => (
                    <tr key={l.materialId} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2">
                        <Link
                          href={`/estoque/${l.materialId}`}
                          className="font-medium text-fg hover:underline"
                        >
                          {l.nome}
                        </Link>
                        <span className="ml-2 font-mono text-xs text-fg-3">{l.codigo}</span>
                        {l.controlado ? (
                          <span className="ml-2 rounded bg-atencao/15 px-1.5 py-0.5 text-[11px] font-medium text-atencao">
                            controle especial
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        {formatarQuantidade(l.saldo, l.unidade)}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-fg-3">
                        {formatarQuantidade(l.quantidadeMinima)}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-xs font-medium',
                            l.reposicao.situacao === 'zerado' && 'bg-critico/15 text-critico',
                            l.reposicao.situacao === 'abaixo_do_minimo' &&
                              'bg-atencao/15 text-atencao',
                            l.reposicao.situacao === 'proximo_do_minimo' && 'bg-surface-2 text-fg-2',
                            l.reposicao.situacao === 'ok' && 'text-fg-3',
                          )}
                        >
                          {l.reposicao.rotulo}
                        </span>
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        {l.reposicao.sugestaoDeCompra === '0.000' ? (
                          <span className="text-fg-3">—</span>
                        ) : (
                          <>
                            {formatarQuantidade(l.reposicao.sugestaoDeCompra, l.unidade)}
                            {l.unidadesPorEmbalagem > 1 ? (
                              <span className="ml-1 text-xs text-fg-3">
                                (≈{Math.ceil(Number(l.reposicao.sugestaoDeCompra) / l.unidadesPorEmbalagem)}{' '}
                                {l.embalagem ? 'emb.' : 'caixas'})
                              </span>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {l.validade === 'vencido' ? (
                          <span className="font-medium text-critico">tem lote vencido</span>
                        ) : l.validade === 'vence_em_breve' ? (
                          <span className="text-atencao">
                            {l.proximaValidade ? dataBr(l.proximaValidade) : '—'}
                          </span>
                        ) : (
                          <span className="text-fg-3">
                            {l.proximaValidade ? dataBr(l.proximaValidade) : 'sem validade'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Validade"
          descricao="Vencidos primeiro, com o valor que se perde se o lote vencer com esse saldo."
        />
        <CardBody className="p-0">
          {vencendo.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">Nenhum lote vencendo nos próximos 60 dias.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                    <th className="px-4 py-2 font-medium">Material</th>
                    <th className="px-4 py-2 font-medium">Lote</th>
                    <th className="px-4 py-2 font-medium">Validade</th>
                    <th className="px-4 py-2 font-medium">Saldo</th>
                    <th className="px-4 py-2 font-medium">Valor em risco</th>
                  </tr>
                </thead>
                <tbody>
                  {vencendo.map((l) => (
                    <tr key={l.loteId} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2">
                        <Link
                          href={`/estoque/${l.materialId}`}
                          className="font-medium text-fg hover:underline"
                        >
                          {l.nome}
                        </Link>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-fg-2">
                        {l.codigoFabricante ?? '—'}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={cn(
                            'text-xs font-medium',
                            l.avaliacao.situacao === 'vencido' ? 'text-critico' : 'text-atencao',
                          )}
                        >
                          {dataBr(l.validade)} · {l.avaliacao.rotulo}
                        </span>
                      </td>
                      <td className="px-4 py-2 tabular-nums">
                        {formatarQuantidade(l.saldo, l.unidade)}
                      </td>
                      <td className="px-4 py-2 tabular-nums font-medium">
                        {reais(l.valorEmRisco)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Todos os materiais"
          descricao="A posição completa. O que precisa de ação já está acima — esta lista é para consultar e para chegar ao material."
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                  <th className="px-4 py-2 font-medium">Material</th>
                  <th className="px-4 py-2 font-medium">Categoria</th>
                  <th className="px-4 py-2 font-medium">Saldo</th>
                  <th className="px-4 py-2 font-medium">Mínimo</th>
                  <th className="px-4 py-2 font-medium">Lotes</th>
                  <th className="px-4 py-2 font-medium">Valor</th>
                </tr>
              </thead>
              <tbody>
                {todos.map((l) => (
                  <tr key={l.materialId} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        href={`/estoque/${l.materialId}`}
                        className="text-fg hover:underline"
                      >
                        {l.nome}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-fg-3">{l.codigo}</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-fg-3">{l.categoria}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {formatarQuantidade(l.saldo, l.unidade)}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-fg-3">
                      {formatarQuantidade(l.quantidadeMinima)}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-fg-3">{l.lotes}</td>
                    <td className="px-4 py-2 tabular-nums text-fg-2">{reais(l.valorEmEstoque)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Últimos movimentos"
          descricao="O livro do estoque: append-only. Lançamento errado se corrige com ajuste em sentido contrário, com motivo — nada aqui se apaga."
        />
        <CardBody className="p-0">
          {extrato.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">
              Nenhum movimento ainda. O estoque começa com a entrada do primeiro recebimento —
              não há saldo semeado, porque saldo inventado é alerta que já nasce mentindo.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                    <th className="px-4 py-2 font-medium">Quando</th>
                    <th className="px-4 py-2 font-medium">Material</th>
                    <th className="px-4 py-2 font-medium">Tipo</th>
                    <th className="px-4 py-2 font-medium">Quantidade</th>
                    <th className="px-4 py-2 font-medium">Lote</th>
                    <th className="px-4 py-2 font-medium">Motivo / paciente</th>
                  </tr>
                </thead>
                <tbody>
                  {extrato.map((m) => (
                    <tr key={m.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-fg-3">
                        {dataHoraBr(m.ocorridoEm)}
                      </td>
                      <td className="px-4 py-2">{m.materialNome}</td>
                      <td className="px-4 py-2 text-xs">{ROTULO_MOVIMENTO[m.tipo]}</td>
                      <td
                        className={cn(
                          'px-4 py-2 tabular-nums',
                          Number(m.quantidade) < 0 ? 'text-fg-2' : 'font-medium text-fg',
                        )}
                      >
                        {formatarQuantidade(m.quantidade, m.unidade)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-fg-3">
                        {m.codigoFabricante ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-fg-2">
                        {m.pacienteNome ?? m.motivo ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {!podeMovimentar ? (
        <p className="text-xs text-fg-3">
          Seu perfil vê o estoque, mas não lança movimento. Entrada é da recepção, baixa é de quem
          usou o material — quem não estava na cadeira não sabe qual lote saiu.
        </p>
      ) : null}
    </div>
  )
}

function Cartao({
  rotulo,
  valor,
  detalhe,
  tom = 'neutro',
}: {
  rotulo: string
  valor: string
  detalhe?: string
  tom?: 'neutro' | 'atencao' | 'critico'
}) {
  return (
    <Card>
      <CardBody>
        <p className="text-xs uppercase tracking-wide text-fg-3">{rotulo}</p>
        <p
          className={cn(
            'mt-1 text-2xl font-semibold tabular-nums',
            tom === 'critico' && 'text-critico',
            tom === 'atencao' && 'text-atencao',
            tom === 'neutro' && 'text-fg',
          )}
        >
          {valor}
        </p>
        {detalhe ? <p className="mt-0.5 text-xs text-fg-3">{detalhe}</p> : null}
      </CardBody>
    </Card>
  )
}
