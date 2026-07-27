import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { pode } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { filaDeRelacionamento, resumoDaFila } from '@/lib/relacionamento/consultas'
import { dataBr, dataHoraBr } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { FilaTrabalho, type LinhaNaTela } from './FilaTrabalho'

export const metadata: Metadata = { title: 'Relacionamento' }

/**
 * As filas de relacionamento ativo.
 *
 * ── Por que esta tela existe ────────────────────────────────────────────────
 * O sistema sabia registrar tudo e não sabia cobrar de si mesmo. Orçamento enviado
 * que ninguém respondeu ficava enviado; `status = 'faltou'` era gravado e morria
 * ali; profilaxia de seis meses dependia de alguém lembrar. Nada disso aparecia
 * como erro — aparecia como um mês fraco.
 *
 * ── A ordem da página responde à pergunta da manhã ─────────────────────────
 * "Para quem eu ligo hoje?", não "quantas tarefas existem". Por isso o resumo por
 * tipo vem em cima, pequeno, e mostra **atrasadas** ao lado de abertas: "12 na
 * fila" é informação, "5 atrasadas" é trabalho.
 */
export default async function Page() {
  const ator = await exigirPermissaoPagina('relacionamento', 'ler')
  const podeTrabalhar = pode(ator.perfil, 'relacionamento', 'editar')

  const [resumo, fila] = await Promise.all([resumoDaFila(), filaDeRelacionamento()])

  const linhas: LinhaNaTela[] = fila.map((l) => ({
    id: l.id,
    rotulo: l.rotulo,
    situacao: l.situacao,
    urgencia: l.urgencia,
    prazoBr: dataBr(l.prazo),
    pacienteId: l.pacienteId,
    pacienteNome: l.pacienteNome,
    telefone: l.telefoneWhatsapp ?? l.telefone,
    detalhe: l.detalhe,
    tentativas: l.tentativas,
    ultimoContatoBr: l.ultimoContatoEm ? dataHoraBr(l.ultimoContatoEm) : null,
    responsavelNome: l.responsavelNome,
    naoContatarAteBr: l.naoContatarAte ? dataBr(l.naoContatarAte) : null,
  }))

  const totalAtrasadas = resumo.reduce((s, r) => s + r.atrasadas, 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-fg">Relacionamento</h1>
        <p className="mt-1 text-sm text-fg-2">
          {totalAtrasadas > 0
            ? `${totalAtrasadas} tarefa(s) fora do prazo.`
            : 'Nada fora do prazo.'}{' '}
          As filas são geradas automaticamente a cada passada do despachante.
        </p>
      </div>

      {resumo.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {resumo.map((r) => (
            <Card key={r.tipo}>
              <CardBody>
                <p className="text-sm text-fg-2">{r.rotulo}</p>
                <p className="mt-1 text-2xl font-semibold text-fg">{r.abertas}</p>
                {/* "—" e não "0 atrasadas": zero atrasado é notícia boa, não um número. */}
                <p className="text-xs text-fg-2">
                  {r.atrasadas > 0 ? (
                    <span className="font-medium text-critico">{r.atrasadas} fora do prazo</span>
                  ) : (
                    'no prazo'
                  )}
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader titulo="Fila de trabalho" descricao="Atrasadas primeiro, depois por prazo — o topo da fila é o mais urgente, não o mais antigo." />
        <FilaTrabalho linhas={linhas} podeTrabalhar={podeTrabalhar} />
      </Card>

      {!podeTrabalhar && (
        <p className="text-xs text-fg-2">
          Seu perfil vê a fila e não a trabalha. Registrar contato, resolver e dispensar são da
          recepção e do financeiro.
        </p>
      )}
    </div>
  )
}
