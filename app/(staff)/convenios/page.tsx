import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { Icone } from '@/components/ui/Icone'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import {
  execucoesAFaturar,
  glosasEmAberto,
  guias,
  painelDeConvenios,
  procedimentosSemTuss,
} from '@/lib/tiss/consultas'
import { ROTULO_CLASSE_GLOSA, orientacaoDeGlosa } from '@/lib/domain/convenio'
import { cn } from '@/lib/ui/cn'
import { reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { MontarGuia } from './MontarGuia'

export const metadata: Metadata = { title: 'Convênios' }

/**
 * Painel de convênios.
 *
 * A ordem das seções segue o que custa dinheiro, do mais urgente ao menos:
 *
 * 1. **A faltar código TUSS** — bloqueia faturar. Aparece no topo enquanto existir.
 * 2. **A faturar** — procedimento feito e não cobrado. É a perda mais silenciosa:
 *    não é glosa, é esquecimento, e vence prazo.
 * 3. **Vencido** — guia enviada cujo prazo de repasse passou.
 * 4. **Glosas em aberto** — o que voltou e pode ser recorrido.
 */
export default async function Page() {
  const ator = await exigirPermissaoPagina('convenio', 'ler')
  const hoje = await hojeDaClinica()
  const agora = new Date()

  const [painel, aFaturar, listaGuias, glosas, tuss] = await Promise.all([
    painelDeConvenios(hoje),
    execucoesAFaturar(agora),
    guias({}, hoje),
    glosasEmAberto(20),
    procedimentosSemTuss(),
  ])

  const podeFaturar = pode(ator.perfil, 'convenio', 'criar')
  const atrasadas = listaGuias.filter((g) => g.atrasoDias > 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
            <Icone nome="convenios" tamanho={18} />
            Convênios
          </h1>
          <p className="text-sm text-fg-3">Faturamento, glosas e repasses das operadoras</p>
        </div>
      </div>

      {tuss.semTuss > 0 ? (
        <Alerta>
          <strong>
            {tuss.semTuss} de {tuss.total} procedimentos estão sem código TUSS.
          </strong>{' '}
          Guia com procedimento sem código é glosada na entrada. A fonte é a Tabela 22 da ANS —
          importe com <code className="font-mono">npm run tuss:importar</code>. Código inventado
          gera glosa, então o catálogo nasce sem eles de propósito.
        </Alerta>
      ) : null}

      {painel.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-fg-2">
              Nenhuma operadora cadastrada. Cadastre a operadora e a tabela negociada antes de
              faturar por convênio.
            </p>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader
            titulo="Por operadora"
            descricao="A faturar é o que já foi feito e não foi cobrado — a perda mais silenciosa, porque vence prazo."
          />
          <CardBody className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Operadora</th>
                    <th className="px-4 py-2 text-right font-semibold">A faturar</th>
                    <th className="px-4 py-2 text-right font-semibold">A receber</th>
                    <th className="px-4 py-2 text-right font-semibold">Vencido</th>
                    <th className="px-4 py-2 text-right font-semibold">Glosado no ano</th>
                  </tr>
                </thead>
                <tbody>
                  {painel.map((c) => (
                    <tr key={c.convenioId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        <Link
                          href={`/convenios/${c.convenioId}`}
                          className="font-medium text-fg hover:text-primary hover:underline"
                        >
                          {c.nome}
                        </Link>
                        <span className="ml-2 text-xs text-fg-3">{c.prazoPagamentoDias}d</span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span className={Number(c.valorAFaturar) > 0 ? 'text-atencao' : 'text-fg-2'}>
                          {reais(c.valorAFaturar)}
                        </span>
                        {c.aFaturar > 0 ? (
                          <span className="block text-xs text-fg-3">{c.aFaturar} item(ns)</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-right text-fg-2">{reais(c.aReceber)}</td>
                      <td className="px-4 py-2 text-right">
                        <span className={Number(c.vencido) > 0 ? 'font-medium text-critico' : 'text-fg-2'}>
                          {reais(c.vencido)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-fg-2">{reais(c.glosadoNoAno)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      {podeFaturar && aFaturar.length > 0 ? (
        <MontarGuia
          execucoes={aFaturar.map((e) => ({
            itemPlanoId: e.itemPlanoId,
            pacienteId: e.pacienteId,
            pacienteNome: e.pacienteNome,
            convenioId: e.convenioId,
            convenioNome: e.convenioNome,
            temCarteirinha: e.numeroCarteirinha !== null,
            profissionalId: e.profissionalId,
            profissionalNome: e.profissionalNome,
            procedimentoNome: e.procedimentoNome,
            temTuss: e.codigoTuss !== null,
            denteFdi: e.denteFdi,
            valor: e.valor,
            executadoEmIso: e.executadoEm.toISOString(),
            diasParado: e.diasParado,
          }))}
        />
      ) : null}

      {atrasadas.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Repasse atrasado"
            descricao="Guias enviadas cujo prazo contratual já passou. Contado do envio, como o contrato define."
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {atrasadas.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <Link
                    href={`/convenios/guias/${g.id}`}
                    className="font-mono font-semibold text-fg hover:text-primary hover:underline"
                  >
                    #{g.numero}
                  </Link>
                  <span className="text-fg-2">{g.convenioNome}</span>
                  <span className="text-fg-3">{g.pacienteNome}</span>
                  <span className="ml-auto font-medium text-critico">
                    {g.atrasoDias} dia{g.atrasoDias === 1 ? '' : 's'}
                  </span>
                  <span className="w-24 text-right font-semibold text-fg">
                    {reais(String(Number(g.valorApresentado) - Number(g.valorPago)))}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {glosas.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Glosas em aberto"
            descricao="Sem recurso ou com recurso indeferido. A orientação diz onde vale insistir."
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {glosas.map((g) => {
                const o = orientacaoDeGlosa(g.classe)
                return (
                  <li key={g.id} className="space-y-1 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <Link
                        href={`/convenios/guias/${g.guiaId}`}
                        className="font-mono font-semibold text-fg hover:text-primary hover:underline"
                      >
                        #{g.guiaNumero}
                      </Link>
                      <span className="text-fg-2">{g.descricao}</span>
                      <span className="text-xs text-fg-3">{g.pacienteNome}</span>
                      <span className="ml-auto font-semibold text-critico">{reais(g.valor)}</span>
                    </div>
                    <p className="text-xs text-fg-2">
                      <span
                        className={cn(
                          'font-medium',
                          o.recorrer ? 'text-atencao' : 'text-fg-3',
                        )}
                      >
                        {ROTULO_CLASSE_GLOSA[g.classe]}
                      </span>{' '}
                      · {g.motivo}
                    </p>
                    <p className="text-xs text-fg-3">
                      {o.recorrer ? '↻ ' : '· '}
                      {o.orientacao}
                      {g.recursoDeferido === false ? ' (recurso já indeferido)' : ''}
                    </p>
                  </li>
                )
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader titulo="Guias" descricao="Da mais recente para a mais antiga." />
        <CardBody className="p-0">
          {listaGuias.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Nenhuma guia emitida.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Nº</th>
                    <th className="px-4 py-2 font-semibold">Operadora</th>
                    <th className="px-4 py-2 font-semibold">Paciente</th>
                    <th className="px-4 py-2 font-semibold">Situação</th>
                    <th className="px-4 py-2 text-right font-semibold">Apresentado</th>
                    <th className="px-4 py-2 text-right font-semibold">Pago</th>
                  </tr>
                </thead>
                <tbody>
                  {listaGuias.map((g) => (
                    <tr key={g.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                      <td className="px-4 py-2">
                        <Link
                          href={`/convenios/guias/${g.id}`}
                          className="font-mono font-semibold text-fg hover:text-primary hover:underline"
                        >
                          #{g.numero}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-fg-2">{g.convenioNome}</td>
                      <td className="px-4 py-2 text-fg-2">{g.pacienteNome}</td>
                      <td className="px-4 py-2">
                        <SituacaoGuia situacao={g.situacao} />
                      </td>
                      <td className="px-4 py-2 text-right text-fg-2">
                        {reais(g.valorApresentado)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span
                          className={
                            Number(g.valorPago) >= Number(g.valorApresentado)
                              ? 'text-sucesso'
                              : 'text-fg'
                          }
                        >
                          {reais(g.valorPago)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        Este acesso foi registrado na trilha de auditoria. Guia enviada é documento apresentado à
        operadora: o que foi apresentado não muda depois.
      </p>
    </div>
  )
}

/** Situação da guia, com marca e cor — ninguém depende só da cor. */
function SituacaoGuia({ situacao }: { situacao: string }) {
  const estilo: Record<string, { cor: string; marca: string; rotulo: string }> = {
    rascunho: { cor: 'text-fg-2', marca: '○', rotulo: 'rascunho' },
    enviada: { cor: 'text-atencao', marca: '→', rotulo: 'enviada' },
    em_analise: { cor: 'text-atencao', marca: '⋯', rotulo: 'em análise' },
    paga: { cor: 'text-sucesso', marca: '✓', rotulo: 'paga' },
    glosada_parcial: { cor: 'text-critico', marca: '◐', rotulo: 'glosada em parte' },
    glosada_total: { cor: 'text-critico', marca: '✕', rotulo: 'glosada' },
    cancelada: { cor: 'text-fg-3', marca: '–', rotulo: 'cancelada' },
  }
  const e = estilo[situacao] ?? { cor: 'text-fg-2', marca: '·', rotulo: situacao }
  return (
    <span className={cn('text-xs font-medium', e.cor)}>
      <span aria-hidden>{e.marca}</span> {e.rotulo}
    </span>
  )
}
