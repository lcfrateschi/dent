'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import { Icone } from '@/components/ui/Icone'
import { gerarAtestado, gerarReceita } from '@/lib/documentos/acoesImpressos'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * Formulários de atestado e receita.
 *
 * Duas escolhas de interface que vêm de regra, não de gosto:
 *
 * 1. **O CID começa desmarcado e a autorização do paciente é uma caixa separada.**
 *    Digitar o CID não é o mesmo que autorizar a imprimi-lo. O atestado costuma ir
 *    para o RH da empresa, e o diagnóstico é dado de saúde.
 * 2. **Posologia é obrigatória e o campo diz o que precisa ter.** "Amoxicilina
 *    500mg" não é receita: a farmácia não dispensa e o paciente inventa a dose.
 */

const HOJE = new Date().toISOString().slice(0, 10)

function Resultado({
  estado,
}: {
  estado: { ok: boolean; mensagem: string; avisos?: readonly string[]; documentoId?: string } | null
}) {
  if (!estado) return null
  if (!estado.ok) return <Alerta>{estado.mensagem}</Alerta>

  return (
    <div className="space-y-2">
      <Alerta tipo="sucesso">{estado.mensagem}</Alerta>
      {(estado.avisos ?? []).map((a) => (
        <Alerta key={a} tipo="atencao">
          {a}
        </Alerta>
      ))}
      {estado.documentoId ? (
        <a
          href={`/api/documentos/${estado.documentoId}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <Icone nome="baixar" tamanho={14} />
          Abrir o PDF para imprimir
        </a>
      ) : null}
    </div>
  )
}

export function FormularioAtestado({ pacienteId }: { pacienteId: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [atendidoEm, setAtendidoEm] = useState(HOJE)
  const [comAfastamento, setComAfastamento] = useState(false)
  const [dias, setDias] = useState(1)
  const [cid, setCid] = useState('')
  const [cidAutorizado, setCidAutorizado] = useState(false)
  const [observacao, setObservacao] = useState('')
  const [estado, setEstado] = useState<Parameters<typeof Resultado>[0]['estado']>(null)

  return (
    <Card>
      <CardHeader
        titulo="Atestado odontológico"
        descricao="Sem dias de afastamento, sai como atestado de comparecimento."
      />
      <CardBody className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="atendidoEm" className="mb-1 block text-sm font-medium text-fg-2">
              Data do atendimento
            </label>
            <input
              id="atendidoEm"
              type="date"
              value={atendidoEm}
              max={HOJE}
              onChange={(e) => setAtendidoEm(e.currentTarget.value)}
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
            />
          </div>

          <div className="sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-fg-2">Afastamento</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-fg-2">
                <input
                  type="checkbox"
                  checked={comAfastamento}
                  onChange={(e) => setComAfastamento(e.currentTarget.checked)}
                />
                Recomendar repouso
              </label>
              {comAfastamento ? (
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={dias}
                  onChange={(e) => setDias(Number(e.currentTarget.value) || 1)}
                  aria-label="Dias de afastamento"
                  className="h-10 w-20 rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
                />
              ) : null}
              {comAfastamento ? <span className="text-sm text-fg-3">dia(s)</span> : null}
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="cid" className="mb-1 block text-sm font-medium text-fg-2">
              CID-10 (opcional)
            </label>
            <input
              id="cid"
              value={cid}
              onChange={(e) => setCid(e.currentTarget.value)}
              placeholder="K02.1"
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg placeholder:text-fg-3"
            />
          </div>
          <div className="sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-fg-2">Sigilo</span>
            <label className="flex items-start gap-2 text-sm text-fg-2">
              <input
                type="checkbox"
                checked={cidAutorizado}
                onChange={(e) => setCidAutorizado(e.currentTarget.checked)}
                className="mt-1"
              />
              <span>
                O paciente <strong>autorizou expressamente</strong> a inclusão do CID no atestado.
                Sem isto, o CID não é impresso — o atestado costuma ir para o RH da empresa.
              </span>
            </label>
          </div>
        </div>

        <div>
          <label htmlFor="obs" className="mb-1 block text-sm font-medium text-fg-2">
            Observação
          </label>
          <input
            id="obs"
            value={observacao}
            onChange={(e) => setObservacao(e.currentTarget.value)}
            className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg"
          />
        </div>

        <Resultado estado={estado} />

        <Button
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await gerarAtestado({
                pacienteId,
                atendidoEm,
                diasAfastamento: comAfastamento ? dias : undefined,
                cid: cid.trim() || undefined,
                cidAutorizadoPeloPaciente: cidAutorizado,
                observacao: observacao.trim() || undefined,
              })
              setEstado(
                r.ok
                  ? { ok: true, mensagem: r.mensagem, avisos: r.avisos, documentoId: r.documentoId }
                  : { ok: false, mensagem: r.mensagem },
              )
              if (r.ok) router.refresh()
            })
          }
        >
          <Icone nome="novo" tamanho={14} />
          {pendente ? 'Emitindo…' : 'Emitir atestado'}
        </Button>
      </CardBody>
    </Card>
  )
}

interface ItemReceita {
  nome: string
  apresentacao: string
  quantidade: string
  posologia: string
}

const VAZIO: ItemReceita = { nome: '', apresentacao: '', quantidade: '', posologia: '' }

export function FormularioReceita({ pacienteId }: { pacienteId: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [itens, setItens] = useState<ItemReceita[]>([{ ...VAZIO }])
  const [orientacoes, setOrientacoes] = useState('')
  const [estado, setEstado] = useState<Parameters<typeof Resultado>[0]['estado']>(null)

  function alterar(i: number, campo: keyof ItemReceita, valor: string): void {
    setItens((atual) => atual.map((item, j) => (i === j ? { ...item, [campo]: valor } : item)))
  }

  return (
    <Card>
      <CardHeader
        titulo="Receituário"
        descricao="Dose, intervalo e duração são obrigatórios — sem eles a farmácia não dispensa."
      />
      <CardBody className="space-y-4">
        {itens.map((item, i) => (
          <div
            key={i}
            className="space-y-2 rounded-(--radius-controle) border border-border bg-surface-2 p-3"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-fg">Medicamento {i + 1}</span>
              {itens.length > 1 ? (
                <Button
                  tamanho="sm"
                  variante="fantasma"
                  onClick={() => setItens((a) => a.filter((_, j) => j !== i))}
                >
                  Remover
                </Button>
              ) : null}
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <input
                value={item.nome}
                onChange={(e) => alterar(i, 'nome', e.currentTarget.value)}
                placeholder="Amoxicilina 500 mg"
                aria-label={`Nome do medicamento ${i + 1}`}
                className="h-10 rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3 sm:col-span-2"
              />
              <input
                value={item.apresentacao}
                onChange={(e) => alterar(i, 'apresentacao', e.currentTarget.value)}
                placeholder="cápsulas"
                aria-label={`Apresentação do medicamento ${i + 1}`}
                className="h-10 rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
              />
            </div>

            <input
              value={item.quantidade}
              onChange={(e) => alterar(i, 'quantidade', e.currentTarget.value)}
              placeholder="21 cápsulas"
              aria-label={`Quantidade do medicamento ${i + 1}`}
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
            />

            <input
              value={item.posologia}
              onChange={(e) => alterar(i, 'posologia', e.currentTarget.value)}
              placeholder="Tomar 1 cápsula de 8 em 8 horas, por 7 dias."
              aria-label={`Posologia do medicamento ${i + 1}`}
              className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
            />
          </div>
        ))}

        {itens.length < 10 ? (
          <Button tamanho="sm" onClick={() => setItens((a) => [...a, { ...VAZIO }])}>
            <Icone nome="novo" tamanho={14} />
            Outro medicamento
          </Button>
        ) : null}

        <div>
          <label htmlFor="orientacoes" className="mb-1 block text-sm font-medium text-fg-2">
            Orientações
          </label>
          <input
            id="orientacoes"
            value={orientacoes}
            onChange={(e) => setOrientacoes(e.currentTarget.value)}
            placeholder="Não bochechar nas primeiras 24 horas."
            className="h-10 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-fg placeholder:text-fg-3"
          />
        </div>

        <Resultado estado={estado} />

        <Button
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await gerarReceita({
                pacienteId,
                medicamentos: itens.map((i) => ({
                  nome: i.nome,
                  apresentacao: i.apresentacao || undefined,
                  quantidade: i.quantidade,
                  posologia: i.posologia,
                })),
                orientacoes: orientacoes.trim() || undefined,
              })
              setEstado(
                r.ok
                  ? { ok: true, mensagem: r.mensagem, avisos: r.avisos, documentoId: r.documentoId }
                  : { ok: false, mensagem: r.mensagem },
              )
              if (r.ok) {
                setItens([{ ...VAZIO }])
                setOrientacoes('')
                router.refresh()
              }
            })
          }
        >
          <Icone nome="novo" tamanho={14} />
          {pendente ? 'Emitindo…' : 'Emitir receita'}
        </Button>
      </CardBody>
    </Card>
  )
}
