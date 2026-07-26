import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { materiaisAtivos } from '@/lib/estoque/consultas'
import { procedimentosComFicha } from '@/lib/estoque/cadastro'
import { fichaDoProcedimento } from '@/lib/estoque/consultas'
import type { Metadata } from 'next'
import Link from 'next/link'
import { EditorDeFicha, NovoMaterial } from './Editores'

export const metadata: Metadata = { title: 'Fichas técnicas' }

/**
 * Fichas técnicas e cadastro de material.
 *
 * A ficha diz o que cada procedimento consome, e é o que faz o estoque ser usado
 * em vez de abandonado: sem ela, a baixa depende de alguém lembrar de lançar no
 * meio do atendimento, e ninguém lembra.
 *
 * Os procedimentos **sem ficha aparecem primeiro** — é a lista de trabalho de
 * quem está montando. Procedimento sem ficha é baixa que nunca vai ser proposta,
 * e o efeito aparece como saldo que não fecha na contagem.
 */
export default async function Page() {
  await exigirPermissaoPagina('estoque', 'ler')

  const [procedimentos, materiais] = await Promise.all([
    procedimentosComFicha(),
    materiaisAtivos(),
  ])

  // Carrega as fichas existentes de uma vez: são poucas dezenas de linhas.
  const fichas = await Promise.all(
    procedimentos.map(async (p) => ({
      procedimentoId: p.id,
      itens: p.insumos > 0 ? await fichaDoProcedimento(p.id) : [],
    })),
  )
  const porProcedimento = new Map(fichas.map((f) => [f.procedimentoId, f.itens]))

  const semFicha = procedimentos.filter((p) => p.insumos === 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/estoque" className="text-xs text-fg-3 hover:underline">
            ← Estoque
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-fg">Fichas técnicas e materiais</h1>
          <p className="text-sm text-fg-3">
            O que cada procedimento consome, e o cadastro dos insumos
          </p>
        </div>
        <NovoMaterial />
      </div>

      {semFicha.length > 0 ? (
        <Alerta tipo="atencao">
          <strong>{semFicha.length} de {procedimentos.length} procedimentos sem ficha.</strong>{' '}
          Para eles o sistema não propõe baixa nenhuma — o consumo tem de ser lançado à mão, e é o
          que faz um controle de estoque morrer no segundo mês.
        </Alerta>
      ) : (
        <Alerta tipo="sucesso">Todos os procedimentos ativos têm ficha técnica.</Alerta>
      )}

      <Card>
        <CardHeader
          titulo="Quantidades são de partida"
          descricao="Uma restauração usa mais gaze em dente posterior que em anterior. O dentista ajusta na tela de baixa, e é a correção repetida que revela o número real."
        />
        <CardBody className="p-0">
          <div className="divide-y divide-border">
            {procedimentos.map((p) => (
              <EditorDeFicha
                key={p.id}
                procedimento={{
                  id: p.id,
                  codigo: p.codigo,
                  nome: p.nome,
                  especialidade: p.especialidade,
                }}
                itens={(porProcedimento.get(p.id) ?? []).map((i) => ({
                  materialId: i.materialId,
                  codigo: i.codigo,
                  nome: i.nome,
                  unidade: i.unidade,
                  quantidade: i.quantidade,
                }))}
                materiais={materiais.map((m) => ({
                  id: m.id,
                  codigo: m.codigo,
                  nome: m.nome,
                  unidade: m.unidade,
                }))}
              />
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
