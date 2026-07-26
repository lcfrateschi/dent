import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { FORMATAR_BR, resolverPeriodo } from '@/lib/domain/periodo'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import { atoresMaisAtivos, consultarAuditoria, resumoDeAuditoria } from '@/lib/relatorios/auditoria'
import { cn } from '@/lib/ui/cn'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Auditoria' }

type Busca = {
  periodo?: string
  de?: string
  ate?: string
  acao?: string
  entidade?: string
  paciente?: string
  pagina?: string
}

/**
 * Trilha de auditoria.
 *
 * Existe desde a Fase 1 e só agora tem tela — e isso não é detalhe: um log que
 * ninguém consegue consultar não protege paciente nenhum, só ocupa disco e dá
 * sensação de conformidade. A pergunta que esta tela responde é a que a LGPD faz:
 * **quem acessou o prontuário deste paciente?**
 *
 * Só o admin entra. Não porque seja mais confiável, mas porque a trilha registra o
 * comportamento de todos os outros: dentista poder auditar dentista muda o
 * significado do registro.
 *
 * A própria consulta é registrada. Sem isso, o único acesso que a trilha não
 * conheceria seria o acesso à trilha.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  const ator = await exigirPermissaoPagina('auditoria', 'ler')
  const busca = await searchParams

  const hoje = await hojeDaClinica()
  const periodo = resolverPeriodo(hoje, busca)
  const pagina = Math.max(0, Number(busca.pagina ?? '0') || 0)

  const filtro = {
    acao: ACOES.includes(busca.acao ?? '') ? busca.acao : undefined,
    entidade: busca.entidade?.trim() || undefined,
    pacienteId: /^[0-9a-f-]{36}$/i.test(busca.paciente ?? '') ? busca.paciente : undefined,
  }

  const [{ linhas, total }, resumo, atores] = await Promise.all([
    consultarAuditoria(ator, periodo, filtro, pagina),
    resumoDeAuditoria(periodo),
    atoresMaisAtivos(periodo),
  ])

  const paginas = Math.ceil(total / 100)
  const base = new URLSearchParams(
    Object.entries({ ...busca, pagina: undefined }).filter(([, v]) => v) as [string, string][],
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
            <Icone nome="auditoria" tamanho={18} />
            Auditoria
          </h1>
          <p className="text-sm text-fg-3">
            {periodo.rotulo} · {total} evento(s)
          </p>
        </div>
        <div className="flex gap-1 text-sm">
          {[
            { valor: 'mes', rotulo: 'Mês' },
            { valor: 'trimestre', rotulo: 'Trimestre' },
            { valor: 'ano', rotulo: 'Ano' },
          ].map((o) => (
            <Link
              key={o.valor}
              href={`/auditoria?periodo=${o.valor}`}
              className={cn(
                'rounded-(--radius-controle) border px-2.5 py-1.5',
                periodo.tipo === o.valor
                  ? 'border-primary bg-primary/10 font-medium text-primary'
                  : 'border-border text-fg-2 hover:bg-surface-2',
              )}
            >
              {o.rotulo}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader titulo="Eventos por ação" />
          <CardBody className="p-0">
            {resumo.length === 0 ? (
              <p className="px-4 py-6 text-sm text-fg-3">Nenhum evento no período.</p>
            ) : (
              <ul className="divide-y divide-border">
                {resumo.map((r) => (
                  <li key={r.acao} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                    <Link
                      href={`/auditoria?periodo=${periodo.tipo}&acao=${r.acao}`}
                      className={cn(
                        'font-medium hover:underline',
                        filtro.acao === r.acao ? 'text-primary' : 'text-fg hover:text-primary',
                      )}
                    >
                      {ROTULO_ACAO[r.acao] ?? r.acao}
                    </Link>
                    <span className="ml-auto text-fg-2">{r.n}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            titulo="Quem mais acessou prontuário"
            descricao="Contando só eventos ligados a um paciente."
          />
          <CardBody className="p-0">
            {atores.length === 0 ? (
              <p className="px-4 py-6 text-sm text-fg-3">Nenhum acesso a prontuário no período.</p>
            ) : (
              <ul className="divide-y divide-border">
                {atores.map((a) => (
                  <li
                    key={a.atorId ?? a.atorEmail ?? 'sistema'}
                    className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm"
                  >
                    <span className="font-medium text-fg">
                      {a.atorNome ?? a.atorEmail ?? 'sistema'}
                    </span>
                    {/* Nome nulo = usuário removido. O e-mail gravado na linha é o
                        que sobra, e é de propósito: o log não tem FK. */}
                    {!a.atorNome && a.atorEmail ? (
                      <span className="text-xs text-fg-3">(usuário removido)</span>
                    ) : null}
                    <span className="ml-auto text-fg-2">
                      {a.eventos} evento(s) · {a.pacientes} paciente(s)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {filtro.acao || filtro.entidade || filtro.pacienteId ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-3">Filtro:</span>
          {filtro.acao ? <Etiqueta>ação {ROTULO_ACAO[filtro.acao] ?? filtro.acao}</Etiqueta> : null}
          {filtro.entidade ? <Etiqueta>entidade {filtro.entidade}</Etiqueta> : null}
          {filtro.pacienteId ? <Etiqueta>um paciente</Etiqueta> : null}
          <Link
            href={`/auditoria?periodo=${periodo.tipo}`}
            className="text-primary hover:underline"
          >
            limpar
          </Link>
        </div>
      ) : null}

      <Card>
        <CardHeader
          titulo="Eventos"
          descricao="Do mais recente para o mais antigo. A trilha é append-only: nada aqui pode ser alterado nem apagado, nem pelo administrador."
        />
        <CardBody className="p-0">
          {linhas.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Nenhum evento com estes filtros.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2">
                  <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
                    <th className="px-4 py-2 font-semibold">Quando</th>
                    <th className="px-4 py-2 font-semibold">Quem</th>
                    <th className="px-4 py-2 font-semibold">Ação</th>
                    <th className="px-4 py-2 font-semibold">Entidade</th>
                    <th className="px-4 py-2 font-semibold">Paciente</th>
                    <th className="px-4 py-2 font-semibold">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => (
                    <tr key={l.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-1.5 whitespace-nowrap text-fg-2">
                        {l.criadoEm.toLocaleString('pt-BR')}
                      </td>
                      <td className="px-4 py-1.5">
                        <span className="text-fg">{l.atorNome ?? l.atorEmail ?? '—'}</span>
                        <span className="ml-1.5 text-xs text-fg-3">{l.atorTipo}</span>
                      </td>
                      <td className="px-4 py-1.5">
                        <span className={cn('font-medium', COR_ACAO[l.acao] ?? 'text-fg-2')}>
                          {ROTULO_ACAO[l.acao] ?? l.acao}
                        </span>
                      </td>
                      <td className="px-4 py-1.5 text-fg-2">
                        <Link
                          href={`/auditoria?periodo=${periodo.tipo}&entidade=${l.entidade}`}
                          className="hover:text-primary hover:underline"
                        >
                          {l.entidade}
                        </Link>
                      </td>
                      <td className="px-4 py-1.5">
                        {l.pacienteId ? (
                          <Link
                            href={`/auditoria?periodo=${periodo.tipo}&paciente=${l.pacienteId}`}
                            className="text-fg hover:text-primary hover:underline"
                          >
                            {l.pacienteNome ?? 'paciente removido'}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-1.5 font-mono text-xs text-fg-3">{l.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {paginas > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-fg-3">
            Página {pagina + 1} de {paginas}
          </span>
          <div className="flex gap-2">
            {pagina > 0 ? (
              <Link
                href={`/auditoria?${base}&pagina=${pagina - 1}`}
                className="rounded-(--radius-controle) border border-border px-2.5 py-1.5 text-fg-2 hover:bg-surface-2"
              >
                <Icone nome="anterior" tamanho={14} /> Anterior
              </Link>
            ) : null}
            {pagina + 1 < paginas ? (
              <Link
                href={`/auditoria?${base}&pagina=${pagina + 1}`}
                className="rounded-(--radius-controle) border border-border px-2.5 py-1.5 text-fg-2 hover:bg-surface-2"
              >
                Próxima <Icone nome="proximo" tamanho={14} />
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <p className="text-xs text-fg-3">
        Período: {FORMATAR_BR(periodo.de)} a {FORMATAR_BR(periodo.ate)}. Esta consulta também foi
        registrada na trilha — inclusive o acesso à auditoria é auditado.
      </p>
    </div>
  )
}

const ACOES = [
  'leitura',
  'criacao',
  'atualizacao',
  'exclusao',
  'exportacao',
  'impressao',
  'login',
  'login_falho',
  'logout',
]

const ROTULO_ACAO: Readonly<Record<string, string>> = {
  leitura: 'Leitura',
  criacao: 'Criação',
  atualizacao: 'Atualização',
  exclusao: 'Exclusão',
  exportacao: 'Exportação',
  impressao: 'Impressão',
  login: 'Entrada',
  login_falho: 'Entrada recusada',
  logout: 'Saída',
}

/**
 * Cor por ação, com o rótulo sempre presente.
 *
 * `login_falho` em vermelho porque uma sequência deles é o sinal de tentativa de
 * invasão — e é a linha que alguém procura quando desconfia.
 */
const COR_ACAO: Readonly<Record<string, string>> = {
  exclusao: 'text-critico',
  login_falho: 'text-critico',
  exportacao: 'text-atencao',
  criacao: 'text-sucesso',
}

function Etiqueta({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-(--radius-controle) border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
      {children}
    </span>
  )
}
