import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { emMegabytes } from '@/lib/domain/arquivo'
import { documentosDoPortal, registrarAcessoDoPortal } from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

export const metadata: Metadata = { title: 'Documentos' }

const ROTULO: Readonly<Record<string, string>> = {
  atestado: 'Atestado',
  receita: 'Receita',
  orcamento_pdf: 'Orçamento',
  termo_consentimento: 'Termo que você assinou',
}

/**
 * Documentos do paciente.
 *
 * **Radiografia e foto clínica não aparecem aqui**, e é decisão, não esquecimento:
 * são insumo de diagnóstico, e imagem sem laudo produz interpretação errada e
 * ligação assustada às onze da noite. Quem quiser as imagens pede na clínica, onde
 * a entrega vem com explicação.
 *
 * O que está aqui é o que foi feito **para o paciente levar**: atestado, receita,
 * orçamento em PDF e o termo que ele assinou.
 */
export default async function Page() {
  const sessao = await sessaoAtual()
  if (!sessao) redirect('/meu/entrar')

  const lista = await documentosDoPortal(sessao)
  await registrarAcessoDoPortal(sessao, 'documentos', { quantidade: lista.length })

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">Documentos</h1>
        <p className="text-sm text-fg-3">Atestados, receitas, orçamentos e termos assinados.</p>
      </div>

      <Card>
        <CardBody className="p-0">
          {lista.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-3">Você não tem documentos disponíveis.</p>
          ) : (
            <ul className="divide-y divide-border">
              {lista.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-fg">{d.nome}</p>
                    <p className="text-xs text-fg-3">
                      {ROTULO[d.tipo] ?? d.tipo} ·{' '}
                      {(d.dataExame ?? d.criadoEm).toLocaleDateString('pt-BR')} ·{' '}
                      {emMegabytes(d.tamanhoBytes)}
                    </p>
                  </div>
                  {/* Baixa pela rota DO PORTAL, que confere a sessão. A rota do
                      staff (/api/documentos) não serve aqui: ela autoriza por
                      perfil de clínica. */}
                  <a
                    href={`/api/meu/documentos/${d.id}`}
                    className="ml-auto flex shrink-0 items-center gap-1.5 rounded-(--radius-controle) border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2"
                    download
                  >
                    <Icone nome="baixar" tamanho={14} />
                    Baixar
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader titulo="Radiografias e fotos" />
        <CardBody>
          <p className="text-sm text-fg-2">
            Suas imagens ficam no seu prontuário e não aparecem aqui de propósito: uma radiografia
            sem a explicação do dentista costuma gerar mais dúvida que informação. Peça na clínica
            que a gente mostra e explica.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
