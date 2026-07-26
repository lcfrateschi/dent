import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import {
  comparacoesPorDente,
  documentosDoPaciente,
  documentosRemovidos,
  nomeDoPaciente,
} from '@/lib/documentos/consultas'
import { emMegabytes } from '@/lib/domain/arquivo'
import { cn } from '@/lib/ui/cn'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FormularioAnexo, LinhaDocumento } from './Controles'

export const metadata: Metadata = { title: 'Documentos e imagens' }

const ROTULO_TIPO: Readonly<Record<string, string>> = {
  radiografia: 'Radiografia',
  foto_clinica: 'Foto clínica',
  exame: 'Exame',
  atestado: 'Atestado',
  receita: 'Receita',
  termo_consentimento: 'Termo de consentimento',
  orcamento_pdf: 'Orçamento (PDF)',
  documento_pessoal: 'Documento pessoal',
  outro: 'Outro',
}

const ROTULO_ETAPA: Readonly<Record<string, string>> = {
  inicial: 'inicial',
  durante: 'durante',
  final: 'final',
}

type Busca = { tipo?: string; dente?: string }

/**
 * Documentos e imagens do paciente.
 *
 * A comparação antes/depois vem primeiro quando existe: é o que o dentista mostra
 * ao paciente, e é a única coisa nesta tela que responde uma pergunta clínica em
 * vez de listar arquivos.
 *
 * Toda miniatura aponta para `/api/documentos/<id>` — não há URL de bucket em
 * nenhum lugar do HTML. Cada carregamento passa por autorização e auditoria.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Busca>
}) {
  const ator = await exigirPermissaoPagina('documento', 'ler')
  const { id } = await params
  const { tipo, dente } = await searchParams

  const nome = await nomeDoPaciente(id)
  if (!nome) notFound()

  const denteFdi = dente && /^\d{2}$/.test(dente) ? Number(dente) : undefined
  const tipoFiltro = tipo && ROTULO_TIPO[tipo] ? tipo : undefined

  const [documentos, comparacoes, removidos] = await Promise.all([
    documentosDoPaciente(ator, id, { tipo: tipoFiltro, denteFdi }),
    comparacoesPorDente(id),
    // Só quem pode remover vê a trilha de remoção. Não há cláusula para
    // `auditoria` aqui de propósito: o admin não tem `documento: ler`, então nem
    // chega nesta página — e uma condição que nunca é verdadeira mentiria sobre
    // quem tem acesso.
    pode(ator.perfil, 'documento', 'editar') ? documentosRemovidos(id) : Promise.resolve([]),
  ])

  const podeAnexar = pode(ator.perfil, 'documento', 'criar')
  const podeRemover = pode(ator.perfil, 'documento', 'editar')

  const dentesComImagem = [
    ...new Set(documentos.map((d) => d.denteFdi).filter((d): d is number => d !== null)),
  ].sort((a, b) => a - b)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <nav className="flex flex-wrap gap-3 text-sm">
        <Link href="/pacientes" className="text-fg-2 hover:text-fg">
          Pacientes
        </Link>
        <Link href={`/pacientes/${id}`} className="text-fg-2 hover:text-fg">
          {nome}
        </Link>
        <span className="font-medium text-fg">Documentos e imagens</span>
      </nav>

      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
          <Icone nome="documentos" tamanho={18} />
          Documentos e imagens
        </h1>
        <p className="text-sm text-fg-3">
          {documentos.length} arquivo(s) no prontuário de {nome}
        </p>
      </div>

      {comparacoes.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Antes e depois"
            descricao="Pareado por dente, da imagem marcada como inicial até a marcada como final."
          />
          <CardBody className="space-y-5">
            {comparacoes.map((c) => (
              <div key={c.denteFdi}>
                <h3 className="mb-2 text-sm font-semibold text-fg">
                  Dente {c.denteFdi} · {c.denteNome}
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Painel rotulo="Antes" documento={c.inicial!} />
                  <Painel rotulo="Depois" documento={c.final!} />
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {podeAnexar ? <FormularioAnexo pacienteId={id} /> : null}

      {/* Filtros: por tipo e por dente. Só aparecem se houver o que filtrar. */}
      {documentos.length > 0 || tipoFiltro || denteFdi ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Filtro href={`/pacientes/${id}/documentos`} ativo={!tipoFiltro && !denteFdi}>
            Todos
          </Filtro>
          {[...new Set(documentos.map((d) => d.tipo))].map((t) => (
            <Filtro
              key={t}
              href={`/pacientes/${id}/documentos?tipo=${t}`}
              ativo={tipoFiltro === t}
            >
              {ROTULO_TIPO[t] ?? t}
            </Filtro>
          ))}
          {dentesComImagem.map((d) => (
            <Filtro
              key={d}
              href={`/pacientes/${id}/documentos?dente=${d}`}
              ativo={denteFdi === d}
            >
              Dente {d}
            </Filtro>
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader
          titulo="Arquivos"
          descricao={
            documentos.length === 0
              ? 'Nada anexado ainda.'
              : 'Ordenado pela data do exame — não pela data do envio.'
          }
        />
        <CardBody className="p-0">
          {documentos.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">
              {tipoFiltro || denteFdi
                ? 'Nenhum arquivo com este filtro.'
                : 'Nenhum documento anexado a este paciente.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {documentos.map((d) => (
                <LinhaDocumento
                  key={d.id}
                  documento={{
                    id: d.id,
                    nome: d.nome,
                    descricao: d.descricao,
                    tipoRotulo: ROTULO_TIPO[d.tipo] ?? d.tipo,
                    denteFdi: d.denteFdi,
                    etapaRotulo: d.etapa ? ROTULO_ETAPA[d.etapa]! : null,
                    tamanho: emMegabytes(d.tamanhoBytes),
                    dataExameIso: d.dataExame ? d.dataExame.toISOString() : null,
                    criadoEmIso: d.criadoEm.toISOString(),
                    criadoPorNome: d.criadoPorNome,
                    exibivelNoNavegador: d.exibivelNoNavegador,
                  }}
                  podeRemover={podeRemover}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {removidos.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Removidos do prontuário"
            descricao="Continuam registrados pela guarda legal de 20 anos, mas não são mais acessíveis."
          />
          <CardBody className="p-0">
            <ul className="divide-y divide-border">
              {removidos.map((r) => (
                <li key={r.id} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-medium text-fg-2 line-through">{r.nome}</span>
                    <span className="text-xs text-fg-3">{ROTULO_TIPO[r.tipo] ?? r.tipo}</span>
                    <span className="ml-auto text-xs text-fg-3">
                      {r.removidoEm?.toLocaleString('pt-BR')}
                      {r.removidoPorNome ? ` · ${r.removidoPorNome}` : ''}
                    </span>
                  </div>
                  <p className="text-xs text-fg-3">Motivo: {r.motivoRemocao}</p>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <p className="text-xs text-fg-3">
        Este acesso foi registrado na trilha de auditoria, e cada download também é. Os arquivos
        não têm link público — só são servidos a quem tem sessão e permissão.
      </p>
    </div>
  )
}

function Filtro({
  href,
  ativo,
  children,
}: {
  href: string
  ativo: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-(--radius-controle) border px-2.5 py-1',
        ativo
          ? 'border-primary bg-primary/10 font-medium text-primary'
          : 'border-border text-fg-2 hover:bg-surface-2',
      )}
    >
      {children}
    </Link>
  )
}

/** Um lado da comparação antes/depois. */
function Painel({
  rotulo,
  documento,
}: {
  rotulo: string
  documento: { id: string; nome: string; dataExame: Date | null; criadoEm: Date; mimeType: string }
}) {
  return (
    <figure className="space-y-1">
      <figcaption className="flex items-baseline justify-between text-xs">
        <span className="font-semibold text-fg">{rotulo}</span>
        <span className="text-fg-3">
          {(documento.dataExame ?? documento.criadoEm).toLocaleDateString('pt-BR')}
        </span>
      </figcaption>
      {/* Imagem servida pela nossa rota, nunca pelo bucket. */}
      <img
        src={`/api/documentos/${documento.id}`}
        alt={`${rotulo}: ${documento.nome}`}
        className="w-full rounded-(--radius-cartao) border border-border bg-surface-2 object-contain"
        loading="lazy"
      />
    </figure>
  )
}
