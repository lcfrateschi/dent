import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { ROTULO_CLASSE_GLOSA, orientacaoDeGlosa } from '@/lib/domain/convenio'
import { conferirAntesDeEnviar } from '@/lib/tiss/exportar'
import { acharGuia } from '@/lib/tiss/consultas'
import { cabecalhoDaClinica } from '@/lib/orcamento/consultas'
import { cn } from '@/lib/ui/cn'
import { reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AcoesDaGuia, RetornoDoItem, RecursoDaGlosa } from './Controles'

export const metadata: Metadata = { title: 'Guia' }

/**
 * Uma guia: itens, retorno da operadora, glosas e recursos.
 *
 * A conferência de pendências (`conferirAntesDeEnviar`) aparece **antes** do botão
 * de enviar, com a lista do que falta. Descobrir que a guia ia ser glosada por
 * falta de registro ANS é mais barato aqui que no demonstrativo de um mês depois.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const ator = await exigirPermissaoPagina('convenio', 'ler')
  const { id } = await params

  const guia = await acharGuia(ator, id)
  if (!guia) notFound()

  const clinica = await cabecalhoDaClinica()
  const podeOperar = pode(ator.perfil, 'convenio', 'editar')

  const pendencias = conferirAntesDeEnviar({
    numero: guia.numero,
    registroAns: guia.registroAns,
    convenioNome: guia.convenioNome,
    numeroLote: guia.numeroLote,
    pacienteNome: guia.pacienteNome,
    pacienteCpf: guia.pacienteCpf,
    pacienteNascimento: guia.pacienteNascimento,
    numeroCarteirinha: guia.numeroCarteirinha,
    profissionalNome: guia.profissionalNome,
    cro: guia.cro,
    ufCro: guia.ufCro,
    clinicaNome: clinica?.nomeFantasia ?? clinica?.razaoSocial ?? 'Clínica',
    clinicaCnpj: clinica?.cnpj ?? null,
    emitidaEm: guia.emitidaEm,
    valorApresentado: guia.valorApresentado,
    itens: guia.itens.map((i) => ({
      codigoTuss: i.codigoTuss,
      descricao: i.descricao,
      denteFdi: i.denteFdi,
      faces: i.faces,
      quantidade: i.quantidade,
      dataExecucao: i.dataExecucao,
      valorApresentado: i.valorApresentado,
    })),
  })

  const glosaPorItem = new Map<string, typeof guia.glosas>()
  for (const g of guia.glosas) {
    glosaPorItem.set(g.itemGuiaId, [...(glosaPorItem.get(g.itemGuiaId) ?? []), g])
  }

  const emRascunho = guia.situacao === 'rascunho'
  const aReceber = String(Number(guia.valorApresentado) - Number(guia.valorPago))

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href="/convenios" className="text-fg-2 hover:text-fg">
          Convênios
        </Link>
        <span className="font-medium text-fg">Guia #{guia.numero}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Guia #{guia.numero}</h1>
          <p className="text-sm text-fg-3">
            {guia.convenioNome} · {guia.pacienteNome} · carteirinha {guia.numeroCarteirinha}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold text-fg">{reais(guia.valorApresentado)}</p>
          {Number(guia.valorPago) > 0 ? (
            <p className="text-sm text-sucesso">{reais(guia.valorPago)} recebido</p>
          ) : null}
          {Number(aReceber) > 0 && !emRascunho ? (
            <p className="text-sm text-atencao">{reais(aReceber)} a receber</p>
          ) : null}
        </div>
      </div>

      {pendencias.length > 0 ? (
        <Alerta tipo={emRascunho ? 'atencao' : 'critico'}>
          <strong>
            {emRascunho ? 'Antes de enviar, resolva:' : 'Esta guia foi enviada com pendências:'}
          </strong>
          <ul className="mt-1 list-inside list-disc">
            {pendencias.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alerta>
      ) : null}

      {podeOperar ? (
        <AcoesDaGuia
          guiaId={guia.id}
          numero={guia.numero}
          emRascunho={emRascunho}
          temPendencias={pendencias.length > 0}
        />
      ) : null}

      <Card>
        <CardHeader
          titulo="Procedimentos apresentados"
          descricao={
            emRascunho
              ? 'Ainda em rascunho: dá para cancelar e remontar.'
              : 'Guia enviada — o que foi apresentado não muda mais.'
          }
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2">
                <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                  <th className="px-4 py-2 font-semibold">TUSS</th>
                  <th className="px-4 py-2 font-semibold">Procedimento</th>
                  <th className="px-4 py-2 font-semibold">Execução</th>
                  <th className="px-4 py-2 text-right font-semibold">Apresentado</th>
                  <th className="px-4 py-2 text-right font-semibold">Pago</th>
                  {podeOperar && !emRascunho ? <th className="px-4 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {guia.itens.map((i) => {
                  const glosas = glosaPorItem.get(i.id) ?? []
                  return (
                    <tr key={i.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-4 py-2 font-mono text-xs">
                        {i.codigoTuss ?? (
                          <span className="text-critico">sem TUSS</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="text-fg">{i.descricao}</span>
                        {i.denteFdi ? (
                          <span className="block text-xs text-fg-3">
                            dente {i.denteFdi}
                            {i.faces ? ` · ${i.faces}` : ''}
                          </span>
                        ) : null}
                        {glosas.map((g) => (
                          <div key={g.id} className="mt-1.5 space-y-1">
                            <p className="text-xs">
                              <span className="font-medium text-critico">
                                Glosa {reais(g.valor)}
                              </span>{' '}
                              <span className="text-fg-3">
                                {ROTULO_CLASSE_GLOSA[g.classe]}
                                {g.codigoOperadora ? ` (${g.codigoOperadora})` : ''}
                              </span>
                            </p>
                            <p className="text-xs text-fg-2">{g.motivo}</p>
                            <p className="text-xs text-fg-3">
                              {orientacaoDeGlosa(g.classe).orientacao}
                            </p>
                            {g.recursoId ? (
                              <p className="text-xs">
                                <span
                                  className={cn(
                                    'font-medium',
                                    g.recursoDeferido === true
                                      ? 'text-sucesso'
                                      : g.recursoDeferido === false
                                        ? 'text-critico'
                                        : 'text-atencao',
                                  )}
                                >
                                  Recurso{' '}
                                  {g.recursoDeferido === true
                                    ? 'deferido'
                                    : g.recursoDeferido === false
                                      ? 'indeferido'
                                      : 'em análise'}
                                </span>
                                {g.recursoResposta ? ` — ${g.recursoResposta}` : ''}
                              </p>
                            ) : podeOperar && orientacaoDeGlosa(g.classe).recorrer ? (
                              <RecursoDaGlosa glosaId={g.id} />
                            ) : null}
                          </div>
                        ))}
                      </td>
                      <td className="px-4 py-2 text-fg-2">
                        {i.dataExecucao.split('-').reverse().join('/')}
                      </td>
                      <td className="px-4 py-2 text-right text-fg-2">
                        {reais(i.valorApresentado)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {i.valorPago === null ? (
                          <span className="text-xs text-fg-3">aguardando</span>
                        ) : (
                          <span
                            className={
                              Number(i.valorPago) >= Number(i.valorApresentado)
                                ? 'text-sucesso'
                                : 'text-critico'
                            }
                          >
                            {reais(i.valorPago)}
                          </span>
                        )}
                      </td>
                      {podeOperar && !emRascunho ? (
                        <td className="px-4 py-2">
                          {i.situacao === 'apresentado' ? (
                            <RetornoDoItem
                              itemGuiaId={i.id}
                              valorApresentado={i.valorApresentado}
                            />
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Protocolo" />
        <CardBody>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-fg-3">Emitida</dt>
            <dd className="text-fg">{guia.emitidaEm.toLocaleString('pt-BR')}</dd>
            <dt className="text-fg-3">Enviada</dt>
            <dd className="text-fg">
              {guia.enviadaEm ? guia.enviadaEm.toLocaleString('pt-BR') : '—'}
            </dd>
            <dt className="text-fg-3">Lote</dt>
            <dd className="text-fg">{guia.numeroLote ?? '—'}</dd>
            <dt className="text-fg-3">Protocolo da operadora</dt>
            <dd className="text-fg">{guia.protocoloOperadora ?? '—'}</dd>
            <dt className="text-fg-3">Previsão de repasse</dt>
            <dd className="text-fg">
              {guia.previsaoRepasse
                ? `${guia.previsaoRepasse.split('-').reverse().join('/')} (${guia.prazoPagamentoDias} dias do envio)`
                : '—'}
            </dd>
            <dt className="text-fg-3">Retorno</dt>
            <dd className="text-fg">
              {guia.retornoEm ? guia.retornoEm.toLocaleString('pt-BR') : '—'}
            </dd>
            <dt className="text-fg-3">Executante</dt>
            <dd className="text-fg">
              {guia.profissionalNome} · CRO {guia.ufCro.toUpperCase()} {guia.cro}
            </dd>
          </dl>
        </CardBody>
      </Card>

      <div className="flex flex-wrap gap-3 text-sm">
        <a
          href={`/api/convenios/guias/${guia.id}/conferencia`}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-primary hover:underline"
        >
          Folha de conferência
        </a>
        <a
          href={`/api/convenios/guias/${guia.id}/xml`}
          className="font-medium text-primary hover:underline"
          download
        >
          XML TISS (não validado — ver README)
        </a>
      </div>

      <p className="text-xs text-fg-3">
        Este acesso foi registrado na trilha de auditoria. A glosa é a diferença entre apresentado e
        pago — não um campo digitado —, e é imutável depois de registrada.
      </p>
    </div>
  )
}
