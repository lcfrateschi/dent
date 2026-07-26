'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { montarGuia } from '@/lib/tiss/acoes'
import { cn } from '@/lib/ui/cn'
import { reais } from '@/lib/ui/moeda'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'

export interface ExecucaoParaFaturar {
  readonly itemPlanoId: string
  readonly pacienteId: string
  readonly pacienteNome: string
  readonly convenioId: string
  readonly convenioNome: string
  readonly temCarteirinha: boolean
  readonly profissionalId: string
  readonly profissionalNome: string
  readonly procedimentoNome: string
  readonly temTuss: boolean
  readonly denteFdi: number | null
  readonly valor: string
  readonly executadoEmIso: string
  readonly diasParado: number
}

/**
 * Fila de faturamento: escolher execuções e montar a guia.
 *
 * A tela **agrupa por paciente + convênio**, porque é o que uma guia é. Deixar
 * selecionar livremente e recusar depois seria fazer a recepção descobrir a regra
 * por tentativa — então a seleção de um paciente desabilita os outros, e o motivo
 * fica escrito.
 *
 * O que está parado há mais tempo aparece primeiro, com o número de dias em
 * destaque: operadora tem prazo para receber a guia, e é essa a informação que
 * decide o que faturar hoje.
 */
export function MontarGuia({ execucoes }: { execucoes: readonly ExecucaoParaFaturar[] }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [marcados, setMarcados] = useState<ReadonlySet<string>>(new Set())
  const [resultado, setResultado] = useState<{ ok: boolean; mensagem: string } | null>(null)

  const primeiro = useMemo(
    () => execucoes.find((e) => marcados.has(e.itemPlanoId)),
    [execucoes, marcados],
  )

  /** Um grupo = um paciente num convênio = uma guia possível. */
  function podeMarcar(e: ExecucaoParaFaturar): boolean {
    if (!primeiro) return true
    return e.pacienteId === primeiro.pacienteId && e.convenioId === primeiro.convenioId
  }

  const selecionados = execucoes.filter((e) => marcados.has(e.itemPlanoId))
  const total = selecionados.reduce((acc, e) => acc + Math.round(Number(e.valor) * 100), 0)
  const semTuss = selecionados.filter((e) => !e.temTuss).length
  const semCarteirinha = selecionados.some((e) => !e.temCarteirinha)

  function alternar(id: string): void {
    setMarcados((atual) => {
      const novo = new Set(atual)
      if (novo.has(id)) novo.delete(id)
      else novo.add(id)
      return novo
    })
    setResultado(null)
  }

  return (
    <Card>
      <CardHeader
        titulo="A faturar"
        descricao="Procedimentos executados e ainda não cobrados da operadora. Uma guia é de um paciente num convênio."
      />
      <CardBody className="space-y-3">
        {resultado ? (
          <Alerta tipo={resultado.ok ? 'sucesso' : 'critico'}>{resultado.mensagem}</Alerta>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-2">
              <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                <th className="px-3 py-2" />
                <th className="px-3 py-2 font-semibold">Paciente</th>
                <th className="px-3 py-2 font-semibold">Operadora</th>
                <th className="px-3 py-2 font-semibold">Procedimento</th>
                <th className="px-3 py-2 font-semibold">Executado</th>
                <th className="px-3 py-2 text-right font-semibold">Parado</th>
                <th className="px-3 py-2 text-right font-semibold">Valor</th>
              </tr>
            </thead>
            <tbody>
              {execucoes.map((e) => {
                const habilitado = podeMarcar(e)
                const marcado = marcados.has(e.itemPlanoId)
                return (
                  <tr
                    key={e.itemPlanoId}
                    className={cn(
                      'border-b border-border last:border-0',
                      marcado ? 'bg-primary/5' : '',
                      !habilitado ? 'opacity-40' : '',
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={marcado}
                        disabled={!habilitado}
                        onChange={() => alternar(e.itemPlanoId)}
                        aria-label={`Selecionar ${e.procedimentoNome} de ${e.pacienteNome}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-fg">
                      {e.pacienteNome}
                      {!e.temCarteirinha ? (
                        <span className="block text-xs font-medium text-critico">
                          <span aria-hidden>⚠</span> sem carteirinha
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-fg-2">{e.convenioNome}</td>
                    <td className="px-3 py-2 text-fg-2">
                      {e.procedimentoNome}
                      {e.denteFdi ? (
                        <span className="ml-1 text-xs text-fg-3">dente {e.denteFdi}</span>
                      ) : null}
                      {!e.temTuss ? (
                        <span className="block text-xs text-atencao">
                          <span aria-hidden>⚠</span> sem código TUSS
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-fg-2">
                      {new Date(e.executadoEmIso).toLocaleDateString('pt-BR')}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={cn(
                          e.diasParado > 60
                            ? 'font-medium text-critico'
                            : e.diasParado > 30
                              ? 'text-atencao'
                              : 'text-fg-3',
                        )}
                      >
                        {e.diasParado}d
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-fg">{reais(e.valor)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {primeiro ? (
          <p className="text-xs text-fg-3">
            Selecionando de <strong>{primeiro.pacienteNome}</strong> em{' '}
            <strong>{primeiro.convenioNome}</strong>. Os outros ficam indisponíveis porque uma guia
            é de um paciente num convênio — faturar junto seria rejeitado no protocolo.
          </p>
        ) : null}

        {selecionados.length > 0 ? (
          <div className="space-y-2 rounded-(--radius-controle) border border-border bg-surface-2 p-3">
            <p className="text-sm text-fg">
              {selecionados.length} procedimento(s) ·{' '}
              <strong>{reais((total / 100).toFixed(2))}</strong>
            </p>

            {semCarteirinha ? (
              <Alerta>
                O paciente não tem carteirinha ativa deste convênio. Cadastre na ficha dele antes de
                faturar — a guia é rejeitada sem ela.
              </Alerta>
            ) : null}

            {semTuss > 0 ? (
              <Alerta tipo="atencao">
                {semTuss} procedimento(s) sem código TUSS. A guia pode ser montada, mas a operadora
                glosa item sem código na entrada. Importe a Tabela 22 da ANS antes de enviar.
              </Alerta>
            ) : null}

            <Button
              variante="primario"
              disabled={pendente || semCarteirinha}
              onClick={() =>
                iniciar(async () => {
                  const r = await montarGuia({
                    itemPlanoIds: selecionados.map((e) => e.itemPlanoId),
                    profissionalId: primeiro!.profissionalId,
                  })
                  setResultado(r)
                  if (r.ok) {
                    setMarcados(new Set())
                    router.refresh()
                  }
                })
              }
            >
              {pendente ? 'Montando…' : 'Montar guia'}
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
