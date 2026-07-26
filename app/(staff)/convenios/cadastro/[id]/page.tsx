import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import {
  acharConvenio,
  procedimentosSemPreco,
  tabelaNegociada,
} from '@/lib/convenios/consultas'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { cn } from '@/lib/ui/cn'
import { dataBr, reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { NovoPreco, PrecoControles } from './TabelaNegociada'

export const metadata: Metadata = { title: 'Tabela negociada' }

/**
 * Tabela negociada de uma operadora.
 *
 * ── Por que a lista mostra o histórico junto ────────────────────────────────
 * Porque o preço faturado é o da **data da execução**, não o de hoje. Um
 * procedimento feito em março e faturado em junho vale o preço de março. Esconder
 * as vigências fechadas faria a conferência de um repasse antigo parecer erro do
 * sistema.
 *
 * ── Por que não há botão de "editar preço" ──────────────────────────────────
 * Editar reescreveria o que já foi apresentado à operadora. Reajuste é vigência
 * nova, e a anterior fecha no dia anterior — automaticamente. O banco recusa o
 * contrário (`drizzle/0021`).
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ator = await exigirPermissaoPagina('convenio', 'ler')
  const hoje = await hojeDaClinica()

  const operadora = await acharConvenio(id, hoje)
  if (!operadora) notFound()

  const [precos, semPreco] = await Promise.all([
    tabelaNegociada(id, hoje),
    procedimentosSemPreco(id, hoje),
  ])

  const podeEditar = pode(ator.perfil, 'convenio', 'criar')
  const vigentes = precos.filter((p) => p.vigenteHoje)
  const historico = precos.filter((p) => !p.vigenteHoje)

  return (
    <div className="space-y-4">
      <div>
        <Link href="/convenios/cadastro" className="text-xs text-fg-3 hover:underline">
          ← Operadoras
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-fg">{operadora.nome}</h1>
        <p className="text-sm text-fg-3">
          {operadora.registroAns ? `Registro ANS ${operadora.registroAns} · ` : null}
          repasse em {operadora.prazoPagamentoDias} dias · {operadora.pacientes} paciente(s)
        </p>
      </div>

      {semPreco.length > 0 ? (
        <Alerta tipo={vigentes.length === 0 ? 'critico' : 'atencao'}>
          <strong>
            {semPreco.length} procedimento(s) do catálogo sem preço vigente nesta operadora.
          </strong>{' '}
          Eles não podem ser faturados por convênio — o item vai para a fila e a guia sai sem valor
          que a operadora reconheça.
        </Alerta>
      ) : (
        <Alerta tipo="sucesso">Todo o catálogo tem preço vigente nesta operadora.</Alerta>
      )}

      {podeEditar ? (
        <Card>
          <CardHeader
            titulo="Cadastrar preço"
            descricao="Para reajuste, informe a data de início: a vigência atual é fechada no dia anterior, automaticamente."
          />
          <CardBody>
            <NovoPreco
              convenioId={id}
              hoje={hoje}
              procedimentos={semPreco.map((p) => ({
                id: p.id,
                codigo: p.codigo,
                nome: p.nome,
                valorParticular: p.valorParticular,
              }))}
              comPrecoVigente={vigentes.map((p) => ({
                id: p.procedimentoId,
                codigo: p.codigo,
                nome: p.procedimentoNome,
                valorParticular: p.valorParticular,
              }))}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          titulo={`Vigentes hoje (${vigentes.length})`}
          descricao="O que a operadora paga por procedimento, e quanto sobra de coparticipação para o paciente."
        />
        <CardBody className="p-0">
          {vigentes.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">Nenhum preço vigente.</p>
          ) : (
            <TabelaPrecos precos={vigentes} podeEditar={podeEditar} convenioId={id} hoje={hoje} />
          )}
        </CardBody>
      </Card>

      {historico.length > 0 ? (
        <Card>
          <CardHeader
            titulo={`Histórico (${historico.length})`}
            descricao="Vigências fechadas ou futuras. Ficam à vista porque o valor faturado é o da data da execução — não o de hoje."
          />
          <CardBody className="p-0">
            <TabelaPrecos precos={historico} podeEditar={podeEditar} convenioId={id} hoje={hoje} />
          </CardBody>
        </Card>
      ) : null}
    </div>
  )
}

function TabelaPrecos({
  precos,
  podeEditar,
  convenioId,
  hoje,
}: {
  precos: readonly {
    id: string
    codigo: string
    procedimentoNome: string
    codigoTuss: string | null
    valorParticular: string
    valor: string
    coberturaPct: string
    carenciaDias: number
    vigenciaInicio: string
    vigenciaFim: string | null
    vigenteHoje: boolean
    usosEmGuia: number
  }[]
  podeEditar: boolean
  convenioId: string
  hoje: string
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
            <th className="px-4 py-2 font-medium">Procedimento</th>
            <th className="px-4 py-2 font-medium">TUSS</th>
            <th className="px-4 py-2 font-medium">Particular</th>
            <th className="px-4 py-2 font-medium">Convênio paga</th>
            <th className="px-4 py-2 font-medium">Cobertura</th>
            <th className="px-4 py-2 font-medium">Carência</th>
            <th className="px-4 py-2 font-medium">Vigência</th>
            <th className="px-4 py-2 font-medium">Faturado</th>
            {podeEditar ? <th className="px-4 py-2" /> : null}
          </tr>
        </thead>
        <tbody>
          {precos.map((p) => (
            <tr key={p.id} className="border-b border-border/60 last:border-0">
              <td className="px-4 py-2">
                {p.procedimentoNome}
                <span className="ml-2 font-mono text-xs text-fg-3">{p.codigo}</span>
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {p.codigoTuss ?? <span className="text-atencao">falta</span>}
              </td>
              <td className="px-4 py-2 tabular-nums text-fg-3">{reais(p.valorParticular)}</td>
              <td className="px-4 py-2 tabular-nums font-medium">{reais(p.valor)}</td>
              <td className="px-4 py-2 tabular-nums">
                {Number(p.coberturaPct).toFixed(0)}%
                {Number(p.coberturaPct) < 100 ? (
                  <span className="block text-xs text-fg-3">
                    coparticipação do paciente
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-2 tabular-nums text-xs">
                {p.carenciaDias > 0 ? `${p.carenciaDias} dias` : '—'}
              </td>
              <td className="px-4 py-2 text-xs">
                <span className={cn(p.vigenteHoje ? 'text-fg' : 'text-fg-3')}>
                  {dataBr(p.vigenciaInicio)} →{' '}
                  {p.vigenciaFim ? dataBr(p.vigenciaFim) : 'em aberto'}
                </span>
              </td>
              <td className="px-4 py-2 tabular-nums text-xs">
                {p.usosEmGuia > 0 ? `${p.usosEmGuia} item(ns)` : '—'}
              </td>
              {podeEditar ? (
                <td className="px-4 py-2">
                  <PrecoControles
                    preco={{
                      id: p.id,
                      procedimentoNome: p.procedimentoNome,
                      vigenciaFim: p.vigenciaFim,
                      usosEmGuia: p.usosEmGuia,
                    }}
                    convenioId={convenioId}
                    hoje={hoje}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
