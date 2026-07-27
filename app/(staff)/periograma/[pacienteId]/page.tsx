import { FaixaAlertas } from '@/components/paciente/FaixaAlertas'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { alertasDoPaciente } from '@/lib/pacientes/consultas'
import { db } from '@/lib/db'
import { paciente } from '@/lib/db/schema'
import {
  ehMultirradicular,
  formatarMm,
  mediaNivelInsercaoDecimos,
  mediaProfundidadeDecimos,
  sangramentoDecimosPct,
  sitiosDe,
} from '@/lib/domain/periograma'
import {
  compararUltimosDoisComAtor,
  dentesDoPeriograma,
  sitiosDoPeriogramaComAtor,
} from '@/lib/periodontal/periograma'
import { periogramaEmAberto, periogramasDoPaciente } from '@/lib/periodontal/consultas'
import { dataHoraBr } from '@/lib/ui/moeda'
import { eq } from 'drizzle-orm'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AbrirExame, GradeComConclusao } from './Controles'
import type { DenteNaTela } from './GradeDeSondagem'

export const metadata: Metadata = { title: 'Periograma' }

/** Rótulo curto do sítio, para caber na coluna da grade. */
const ROTULO_SITIO: Record<string, string> = {
  mesio_vestibular: 'MV',
  vestibular: 'V',
  disto_vestibular: 'DV',
  mesio_palatina: 'MP',
  palatina: 'P',
  disto_palatina: 'DP',
  mesio_lingual: 'ML',
  lingual: 'L',
  disto_lingual: 'DL',
}

/**
 * Ordem do exame: superior direito → superior esquerdo → inferior esquerdo →
 * inferior direito, que é o caminho da sonda na boca. [PADRÃO]
 *
 * Não é `1..48` crescente: a numeração FDI cresce no sentido oposto do exame no
 * segundo quadrante, e uma grade fora da ordem do exame força a auxiliar a procurar
 * o dente na tela — exatamente o que a grade existe para evitar.
 */
const ORDEM_DO_EXAME: readonly number[] = [
  18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
  48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
]

export default async function Page({ params }: { params: Promise<{ pacienteId: string }> }) {
  const { pacienteId } = await params
  const ator = await exigirPermissaoPagina('odontograma', 'ler')
  const podeEditar = pode(ator.perfil, 'odontograma', 'editar')

  const [linha] = await db
    .select({ id: paciente.id, nome: paciente.nome })
    .from(paciente)
    .where(eq(paciente.id, pacienteId))
  if (!linha) notFound()

  const [alertas, exames, emAberto, comparacao] = await Promise.all([
    alertasDoPaciente(pacienteId),
    periogramasDoPaciente(pacienteId),
    periogramaEmAberto(pacienteId),
    compararUltimosDoisComAtor(ator, pacienteId),
  ])

  // A leitura dos sítios do exame aberto passa pelo núcleo, que **registra no
  // audit_log**: abrir o periograma de um paciente é acesso a prontuário, e leitura
  // conta (decisão 6 do CLAUDE.md).
  const gravadas = emAberto ? await sitiosDoPeriogramaComAtor(ator, emAberto.id) : []
  const achados = emAberto ? await dentesDoPeriograma(emAberto.id) : []

  const dentes: DenteNaTela[] = ORDEM_DO_EXAME.map((fdi) => ({
    fdi,
    temFurca: ehMultirradicular(fdi),
    sitios: sitiosDe(fdi).map((s) => ({ sitio: s, rotulo: ROTULO_SITIO[s] ?? s })),
  }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Periograma — {linha.nome}</h1>
        <p className="mt-1 text-sm text-fg-2">
          Exame periodontal: seis sítios por dente, dentição permanente. O nível de inserção é
          calculado, não digitado.
        </p>
      </div>

      {/*
        Alerta clínico no topo de toda tela do paciente — segurança na cadeira.
        `FaixaAlertas` é o componente que as outras telas usam: repetir a lista à mão
        aqui faria alergia aparecer com aparência diferente dependendo da página, e é
        exatamente o aviso que não pode depender de qual tela a pessoa abriu.
      */}
      <FaixaAlertas alertas={alertas} />

      {comparacao && (
        <Card>
          <CardHeader
            titulo="Comparação com o exame anterior"
            descricao="Só os sítios presentes nos dois exames. Dente extraído no intervalo é perda dentária, não melhora."
          />
          <CardBody>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-fg-2">Profundidade média</p>
                <p className="text-lg tabular-nums text-fg">
                  {formatarMm(mediaProfundidadeDecimos(comparacao.emparelhado.antes))} →{' '}
                  {formatarMm(mediaProfundidadeDecimos(comparacao.emparelhado.depois))}
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-2">Nível de inserção médio</p>
                <p className="text-lg tabular-nums text-fg">
                  {formatarMm(mediaNivelInsercaoDecimos(comparacao.emparelhado.antes))} →{' '}
                  {formatarMm(mediaNivelInsercaoDecimos(comparacao.emparelhado.depois))}
                </p>
                <p className="text-xs text-fg-3">
                  É este que diz se a doença progrediu — a bolsa pode encolher só porque a gengiva
                  retraiu.
                </p>
              </div>
              <div>
                <p className="text-xs text-fg-2">Sangramento</p>
                <p className="text-lg tabular-nums text-fg">
                  {decimosPct(sangramentoDecimosPct(comparacao.emparelhado.antes))} →{' '}
                  {decimosPct(sangramentoDecimosPct(comparacao.emparelhado.depois))}
                </p>
              </div>
            </div>

            {comparacao.parcial && (
              <div className="mt-4 rounded border border-atencao bg-surface-2 p-3 text-sm">
                <p className="font-medium text-fg">A boca mudou entre os exames.</p>
                {comparacao.dentesPerdidos.length > 0 && (
                  <p className="mt-1 text-fg-2">
                    Perda dentária: {comparacao.dentesPerdidos.join(', ')}. Os sítios desses dentes
                    ficaram fora da comparação — eram os piores, e incluí-los mostraria melhora onde
                    houve o desfecho mais grave da doença.
                  </p>
                )}
                {comparacao.dentesNovos.length > 0 && (
                  <p className="mt-1 text-fg-2">
                    Dentes novos no exame: {comparacao.dentesNovos.join(', ')}.
                  </p>
                )}
                <p className="mt-1 text-xs text-fg-3">
                  Sítios medidos: {comparacao.completo.antes.sitios} antes,{' '}
                  {comparacao.completo.depois.sitios} depois.
                </p>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          titulo={emAberto ? 'Exame em andamento' : 'Nenhum exame aberto'}
          descricao={
            emAberto
              ? 'Cada dente é gravado ao sair dele. Fechar a página não perde o que já foi digitado.'
              : 'Abra um exame para começar a digitar.'
          }
        />
        <CardBody>
          {emAberto ? (
            <GradeComConclusao
              periogramaId={emAberto.id}
              dentes={dentes}
              gravadas={gravadas.map((g) => ({ ...g }))}
              achados={achados.map((a) => ({ ...a }))}
              somenteLeitura={!podeEditar}
            />
          ) : podeEditar ? (
            <AbrirExame pacienteId={pacienteId} />
          ) : (
            <p className="text-sm text-fg-2">Seu perfil vê exames e não os registra.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Exames anteriores" />
        <CardBody>
          {exames.length === 0 ? (
            <p className="text-sm text-fg-2">Nenhum exame registrado.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-fg-2">
                  <th scope="col" className="py-1 font-medium">
                    Data
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Profissional
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Sítios
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    Situação
                  </th>
                </tr>
              </thead>
              <tbody>
                {exames.map((e) => (
                  <tr key={e.id} className="border-b border-border/50">
                    <td className="py-1">{dataHoraBr(e.examinadoEm)}</td>
                    <td className="py-1 text-fg-2">{e.profissionalNome ?? '—'}</td>
                    <td className="py-1 tabular-nums">{e.sitios}</td>
                    <td className="py-1 text-fg-2">
                      {e.concluidoEm ? 'concluído' : 'em andamento'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

/** `234` → `"23,4 %"`. `null` → `"—"`, porque exame sem sítio não tem taxa. */
function decimosPct(v: number | null): string {
  if (v === null) return '—'
  return `${Math.trunc(v / 10)},${v % 10} %`
}
