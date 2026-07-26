import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { registrar } from '@/lib/auditoria/registrar'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { ROTULO_MOVIMENTO, avaliarReposicao } from '@/lib/domain/estoque'
import { formatarQuantidade } from '@/lib/domain/quantidade'
import {
  acharMaterial,
  consumoDoMaterial,
  extratoDeMovimentos,
  lotesDoMaterial,
  pacientesQueReceberamOLote,
} from '@/lib/estoque/consultas'
import { cn } from '@/lib/ui/cn'
import { dataBr, dataHoraBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ContarLote, DarBaixa, DefinirMinimo, DescartarLote, RegistrarEntrada } from './Controles'

export const metadata: Metadata = { title: 'Material' }

/**
 * Um material: lotes em ordem FEFO, movimentos e rastreabilidade.
 *
 * A lista de lotes está **na ordem em que vão sair** — não por data de entrada,
 * não alfabética. Ver a fila de saída é o que ensina o FEFO a quem opera: fica
 * evidente que a caixa nova pode estar na frente da antiga.
 *
 * Esta página pode mostrar nome de paciente (consumo ligado a execução), então a
 * leitura é registrada na auditoria. Estoque não é recurso clínico, mas "em quem
 * este lote foi usado" é dado de paciente como qualquer outro.
 */
export default async function Page({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params
  const ator = await exigirPermissaoPagina('estoque', 'ler')

  const m = await acharMaterial(materialId)
  if (!m) notFound()

  const [lotes, movimentos, consumo] = await Promise.all([
    lotesDoMaterial(materialId),
    extratoDeMovimentos({ materialId, limite: 50 }),
    consumoDoMaterial(materialId, 90),
  ])

  const comSaldo = lotes.filter((l) => Number(l.saldo) > 0)
  const saldo = comSaldo.reduce((acc, l) => acc + Number(l.saldo), 0).toFixed(3)
  const reposicao = avaliarReposicao(saldo, m.quantidadeMinima)

  const podeMovimentar = pode(ator.perfil, 'estoque', 'criar')
  const podeAjustar = pode(ator.perfil, 'estoque', 'editar')

  // Rastreabilidade: só busca se houver consumo ligado a execução neste material.
  const temConsumoDePaciente = movimentos.some((mv) => mv.pacienteId !== null)
  const receptores = temConsumoDePaciente
    ? await Promise.all(
        comSaldo.concat(lotes.filter((l) => Number(l.saldo) === 0)).map(async (l) => ({
          lote: l,
          pacientes: await pacientesQueReceberamOLote(l.id),
        })),
      )
    : []
  const lotesComPaciente = receptores.filter((r) => r.pacientes.length > 0)

  if (lotesComPaciente.length > 0) {
    // A tela mostra nome de paciente: é acesso a dado de saúde, e leitura também
    // é evento auditável na LGPD — não só escrita.
    await registrar({
      ator,
      acao: 'leitura',
      entidade: 'material',
      entidadeId: materialId,
      detalhes: { motivo: 'rastreabilidade de lote', lotes: lotesComPaciente.length },
    })
  }

  const sugestaoDeMinimo =
    consumo.consumoMedioDiario === '0.000'
      ? null
      : (Number(consumo.consumoMedioDiario) * 14).toFixed(3)

  return (
    <div className="space-y-4">
      <div>
        <Link href="/estoque" className="text-xs text-fg-3 hover:underline">
          ← Estoque
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-fg">{m.nome}</h1>
        <p className="text-sm text-fg-3">
          <span className="font-mono">{m.codigo}</span> · {m.categoria} · consumo em {m.unidade}
          {m.embalagem ? ` · compra em ${m.embalagem}` : null}
        </p>
      </div>

      {m.controlado ? (
        <Alerta tipo="atencao">
          <strong>Material de controle especial (Portaria 344/98).</strong> Toda saída exige
          profissional responsável e motivo — o banco recusa sem eles.
        </Alerta>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-fg-3">Saldo</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">
              {formatarQuantidade(saldo, m.unidade)}
            </p>
            <p className="mt-0.5 text-xs text-fg-3">
              em {comSaldo.length} lote(s) com saldo
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-fg-3">Mínimo</p>
            <p
              className={cn(
                'mt-1 text-2xl font-semibold tabular-nums',
                reposicao.situacao === 'zerado' || reposicao.situacao === 'abaixo_do_minimo'
                  ? 'text-critico'
                  : 'text-fg',
              )}
            >
              {formatarQuantidade(m.quantidadeMinima)}
            </p>
            <p className="mt-0.5 text-xs text-fg-3">{reposicao.rotulo}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-fg-3">Consumo médio</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">
              {formatarQuantidade(consumo.consumoMedioDiario)}
            </p>
            <p className="mt-0.5 text-xs text-fg-3">por dia, nos últimos 90 dias</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-xs uppercase tracking-wide text-fg-3">Cobertura</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">
              {consumo.diasDeCobertura === null ? '—' : `${consumo.diasDeCobertura} dias`}
            </p>
            <p className="mt-0.5 text-xs text-fg-3">
              {consumo.diasDeCobertura === null
                ? 'sem consumo no período — nada a projetar'
                : 'no ritmo atual'}
            </p>
          </CardBody>
        </Card>
      </div>

      {reposicao.sugestaoDeCompra !== '0.000' ? (
        <Alerta tipo={reposicao.situacao === 'zerado' ? 'critico' : 'atencao'}>
          <strong>Comprar {formatarQuantidade(reposicao.sugestaoDeCompra, m.unidade)}.</strong>{' '}
          Repõe ao dobro do mínimo — comprar exatamente o mínimo deixaria o alerta disparando no
          dia seguinte à entrega, e alerta que dispara sempre é alerta que ninguém lê.
          {m.unidadesPorEmbalagem > 1
            ? ` São ≈${Math.ceil(Number(reposicao.sugestaoDeCompra) / m.unidadesPorEmbalagem)} ${m.embalagem ?? 'embalagens'}.`
            : null}
        </Alerta>
      ) : null}

      {podeMovimentar || podeAjustar ? (
        <div className="flex flex-wrap items-start gap-2">
          {podeMovimentar ? (
            <>
              <RegistrarEntrada
                materialId={m.id}
                unidade={m.unidade}
                unidadesPorEmbalagem={m.unidadesPorEmbalagem}
                embalagem={m.embalagem}
                exigeLote={m.exigeLoteDoFabricante}
              />
              <DarBaixa
                materialId={m.id}
                unidade={m.unidade}
                controlado={m.controlado}
                profissionalId={ator.profissionalId}
              />
            </>
          ) : null}
          {podeAjustar ? (
            <DefinirMinimo
              materialId={m.id}
              minimo={m.quantidadeMinima}
              unidade={m.unidade}
              sugestao={sugestaoDeMinimo}
            />
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader
          titulo="Lotes, na ordem em que vão sair"
          descricao="FEFO: vence primeiro, sai primeiro — mesmo que tenha chegado depois. Sem validade fica no fim, porque material perene não corre risco de perda."
        />
        <CardBody className="p-0">
          {lotes.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">
              Nenhum lote. O estoque começa com a entrada do primeiro recebimento.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                    <th className="px-4 py-2 font-medium">#</th>
                    <th className="px-4 py-2 font-medium">Lote do fabricante</th>
                    <th className="px-4 py-2 font-medium">Validade</th>
                    <th className="px-4 py-2 font-medium">Saldo</th>
                    <th className="px-4 py-2 font-medium">Custo</th>
                    <th className="px-4 py-2 font-medium">Recebido</th>
                    <th className="px-4 py-2 font-medium">Nota</th>
                    {podeAjustar || podeMovimentar ? <th className="px-4 py-2" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {lotes.map((l, i) => {
                    const vazio = Number(l.saldo) === 0
                    return (
                      <tr
                        key={l.id}
                        className={cn(
                          'border-b border-border/60 last:border-0',
                          vazio && 'text-fg-3',
                        )}
                      >
                        <td className="px-4 py-2 tabular-nums text-xs text-fg-3">
                          {vazio ? '—' : i + 1}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs">{l.codigoFabricante ?? '—'}</td>
                        <td className="px-4 py-2">
                          {l.validade === null ? (
                            <span className="text-xs text-fg-3">sem validade</span>
                          ) : (
                            <span
                              className={cn(
                                'text-xs',
                                !vazio && l.avaliacao.situacao === 'vencido' && 'font-medium text-critico',
                                !vazio && l.avaliacao.situacao === 'vence_em_breve' && 'text-atencao',
                              )}
                            >
                              {dataBr(l.validade)} · {l.avaliacao.rotulo}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 tabular-nums">
                          {formatarQuantidade(l.saldo, m.unidade)}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-xs">
                          {l.custoUnitario ? reais(l.custoUnitario) : '—'}
                        </td>
                        <td className="px-4 py-2 text-xs">{dataBr(l.recebidoEm)}</td>
                        <td className="px-4 py-2 text-xs">
                          {l.notaFiscal ?? '—'}
                          {l.fornecedor ? (
                            <span className="block text-fg-3">{l.fornecedor}</span>
                          ) : null}
                        </td>
                        {podeAjustar || podeMovimentar ? (
                          <td className="px-4 py-2">
                            {vazio ? null : (
                              <div className="flex flex-wrap items-start gap-1">
                                {podeAjustar ? (
                                  <ContarLote loteId={l.id} saldo={l.saldo} unidade={m.unidade} />
                                ) : null}
                                {podeMovimentar && l.avaliacao.situacao === 'vencido' ? (
                                  <DescartarLote loteId={l.id} saldo={l.saldo} />
                                ) : null}
                              </div>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {lotesComPaciente.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Rastreabilidade — em quem cada lote foi usado"
            descricao="É a resposta ao recolhimento de lote pelo fabricante. Sem ela, a pergunta se responderia procurando em papel, paciente por paciente."
          />
          <CardBody className="space-y-3">
            {lotesComPaciente.map(({ lote, pacientes }) => (
              <div key={lote.id}>
                <p className="text-sm font-medium text-fg">
                  Lote <span className="font-mono">{lote.codigoFabricante ?? lote.id.slice(0, 8)}</span>
                  {lote.validade ? ` · validade ${dataBr(lote.validade)}` : null}
                </p>
                <ul className="mt-1 space-y-1">
                  {pacientes.map((p, i) => (
                    <li key={`${p.pacienteId}-${i}`} className="text-sm text-fg-2">
                      <Link href={`/pacientes/${p.pacienteId}`} className="hover:underline">
                        {p.pacienteNome}
                      </Link>
                      <span className="text-fg-3">
                        {' '}
                        · {p.procedimentoNome} · {dataHoraBr(p.executadoEm)} ·{' '}
                        {formatarQuantidade(p.quantidade, m.unidade)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo="Movimentos"
          descricao="Append-only. Erro de lançamento se corrige com ajuste em sentido contrário, com motivo — o que já foi registrado fica."
        />
        <CardBody className="p-0">
          {movimentos.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">Nenhum movimento.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                    <th className="px-4 py-2 font-medium">Quando</th>
                    <th className="px-4 py-2 font-medium">Tipo</th>
                    <th className="px-4 py-2 font-medium">Quantidade</th>
                    <th className="px-4 py-2 font-medium">Lote</th>
                    <th className="px-4 py-2 font-medium">Quem</th>
                    <th className="px-4 py-2 font-medium">Motivo / paciente</th>
                  </tr>
                </thead>
                <tbody>
                  {movimentos.map((mv) => (
                    <tr key={mv.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2 whitespace-nowrap text-xs text-fg-3">
                        {dataHoraBr(mv.ocorridoEm)}
                      </td>
                      <td className="px-4 py-2 text-xs">{ROTULO_MOVIMENTO[mv.tipo]}</td>
                      <td
                        className={cn(
                          'px-4 py-2 tabular-nums',
                          Number(mv.quantidade) < 0 ? 'text-fg-2' : 'font-medium text-fg',
                        )}
                      >
                        {formatarQuantidade(mv.quantidade, m.unidade)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-fg-3">
                        {mv.codigoFabricante ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-fg-2">
                        {mv.profissionalNome ?? mv.registradoPor ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-fg-2">
                        {mv.pacienteNome ?? mv.motivo ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
