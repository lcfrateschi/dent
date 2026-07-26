import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { formatarCpf, formatarTelefone } from '@/lib/domain/cpf'
import { idadeEm } from '@/lib/domain/datas'
import { listarPacientes } from '@/lib/pacientes/consultas'
import { cn } from '@/lib/ui/cn'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Pacientes' }

type Busca = { q?: string; status?: string; pagina?: string }

export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  // Autorização no servidor, antes de qualquer consulta.
  const ator = await exigirPermissaoPagina('paciente', 'ler')
  const { q = '', status = 'ativo', pagina = '1' } = await searchParams

  const statusFiltro = (['ativo', 'inativo', 'arquivado', 'todos'] as const).includes(
    status as never,
  )
    ? (status as 'ativo' | 'inativo' | 'arquivado' | 'todos')
    : 'ativo'

  const resultado = await listarPacientes(ator, {
    busca: q,
    status: statusFiltro,
    pagina: Number(pagina) || 1,
  })

  const hoje = new Date().toISOString().slice(0, 10)
  const podeCriar = pode(ator.perfil, 'paciente', 'criar')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Pacientes</h1>
          <p className="text-sm text-fg-3">
            {resultado.total} {resultado.total === 1 ? 'paciente' : 'pacientes'}
            {statusFiltro !== 'todos' ? ` com status ${statusFiltro}` : ''}
          </p>
        </div>
        {podeCriar ? (
          <Link href="/pacientes/novo">
            <Button variante="primario">Novo paciente</Button>
          </Link>
        ) : null}
      </div>

      {/* GET simples: a busca fica na URL e pode ser compartilhada e recarregada. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor="q" className="mb-1 block text-sm font-medium text-fg-2">
            Buscar
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q}
            placeholder="Nome, CPF ou telefone"
            className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg placeholder:text-fg-3"
          />
        </div>
        <div>
          <label htmlFor="status" className="mb-1 block text-sm font-medium text-fg-2">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue={statusFiltro}
            className="h-10 rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
          >
            <option value="ativo">Ativos</option>
            <option value="inativo">Inativos</option>
            <option value="arquivado">Arquivados</option>
            <option value="todos">Todos</option>
          </select>
        </div>
        <Button type="submit">Filtrar</Button>
        {q || statusFiltro !== 'ativo' ? (
          <Link href="/pacientes">
            <Button variante="fantasma">Limpar</Button>
          </Link>
        ) : null}
      </form>

      <Card className="overflow-hidden">
        {resultado.itens.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-fg-2">
              {q ? `Nenhum paciente encontrado para "${q}".` : 'Nenhum paciente cadastrado ainda.'}
            </p>
            {podeCriar ? (
              <Link href="/pacientes/novo" className="mt-3 inline-block">
                <Button variante="primario" tamanho="sm">
                  Cadastrar o primeiro
                </Button>
              </Link>
            ) : null}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2 text-left">
                <tr className="text-xs tracking-wide text-fg-3 uppercase">
                  <th className="px-4 py-2.5 font-semibold">Nome</th>
                  <th className="px-4 py-2.5 font-semibold">Idade</th>
                  <th className="px-4 py-2.5 font-semibold">CPF</th>
                  <th className="px-4 py-2.5 font-semibold">Telefone</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {resultado.itens.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/pacientes/${p.id}`}
                        className="font-medium text-fg hover:text-primary hover:underline"
                      >
                        {p.nome}
                      </Link>
                      {p.nomeSocial ? (
                        <span className="block text-xs text-fg-3">
                          nome social: {p.nomeSocial}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-fg-2">
                      {idadeEm(p.dataNascimento, hoje)} anos
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-fg-2">
                      {p.cpf ? formatarCpf(p.cpf) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-fg-2">
                      {p.telefoneWhatsapp
                        ? formatarTelefone(p.telefoneWhatsapp)
                        : p.telefone
                          ? formatarTelefone(p.telefone)
                          : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <Etiqueta status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {resultado.paginas > 1 ? (
        <nav className="flex items-center justify-between text-sm" aria-label="Paginação">
          <span className="text-fg-3">
            Página {resultado.pagina} de {resultado.paginas}
          </span>
          <div className="flex gap-2">
            {resultado.pagina > 1 ? (
              <Link
                href={`/pacientes?${new URLSearchParams({ q, status: statusFiltro, pagina: String(resultado.pagina - 1) })}`}
              >
                <Button tamanho="sm">Anterior</Button>
              </Link>
            ) : null}
            {resultado.pagina < resultado.paginas ? (
              <Link
                href={`/pacientes?${new URLSearchParams({ q, status: statusFiltro, pagina: String(resultado.pagina + 1) })}`}
              >
                <Button tamanho="sm">Próxima</Button>
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  )
}

function Etiqueta({ status }: { status: 'ativo' | 'inativo' | 'arquivado' }) {
  const estilo = {
    ativo: 'bg-sucesso/12 text-sucesso border-sucesso/30',
    inativo: 'bg-surface-3 text-fg-3 border-border',
    arquivado: 'bg-atencao/12 text-atencao border-atencao/30',
  }[status]

  return (
    <span
      className={cn(
        'inline-block rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
        estilo,
      )}
    >
      {status}
    </span>
  )
}
