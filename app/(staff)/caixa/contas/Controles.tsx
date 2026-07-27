'use client'

import { Alerta, Input, Select, Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/ui/cn'
import { useState, useTransition } from 'react'
import {
  cancelarDespesa,
  estornarPagamentoDeDespesa,
  lancarDespesa,
  pagarDespesa,
} from '@/lib/caixa/acoes'

/**
 * Controles de contas a pagar. **Cliente, e os tipos são declarados aqui.**
 *
 * Os tipos não vêm de `lib/caixa/consultas.ts` de propósito: importar de lá arrastaria
 * `@/lib/db` para o bundle do navegador, e com ele `pg` e `node:crypto`. Foi assim que o
 * build da Fase 12 quebrou sem `npm test` nem `tsc` reclamarem — só o `next build`
 * percebe. O que atravessa a fronteira é dado já formatado; o que o cliente chama são as
 * server actions.
 */

export interface CategoriaNaTela {
  id: string
  nome: string
  natureza: 'fixa' | 'variavel'
}

export interface PagamentoNaTela {
  id: string
  valorBr: string
  pagoEmBr: string
  meio: string
  estornado: boolean
  motivoEstorno: string | null
}

export interface ContaNaTela {
  id: string
  descricao: string
  categoria: string
  fornecedor: string | null
  valorBr: string
  pagoBr: string
  saldoBr: string
  saldoCru: string
  vencimentoBr: string
  competenciaBr: string
  situacao: 'cancelada' | 'paga' | 'parcial' | 'vencida' | 'aberta'
  diasDeAtraso: number
  pagamentos: PagamentoNaTela[]
}

const MEIOS = [
  { valor: 'pix', rotulo: 'Pix' },
  { valor: 'transferencia', rotulo: 'Transferência' },
  { valor: 'boleto', rotulo: 'Boleto' },
  { valor: 'debito', rotulo: 'Débito' },
  { valor: 'credito', rotulo: 'Crédito' },
  { valor: 'dinheiro', rotulo: 'Dinheiro' },
] as const

const COR_SITUACAO: Record<ContaNaTela['situacao'], string> = {
  vencida: 'bg-critico/10 text-critico',
  parcial: 'bg-atencao/15 text-atencao',
  aberta: 'bg-surface-2 text-fg-2',
  paga: 'bg-sucesso/10 text-sucesso',
  cancelada: 'bg-surface-2 text-fg-3',
}

const ROTULO_SITUACAO: Record<ContaNaTela['situacao'], string> = {
  vencida: 'vencida',
  parcial: 'paga em parte',
  aberta: 'a vencer',
  paga: 'paga',
  cancelada: 'cancelada',
}

export function Contas({
  contas,
  categorias,
  hojeIso,
  podeLancar,
  podeBaixar,
  podeDesfazer,
  abrirLancamento = false,
}: {
  contas: readonly ContaNaTela[]
  categorias: readonly CategoriaNaTela[]
  hojeIso: string
  podeLancar: boolean
  podeBaixar: boolean
  podeDesfazer: boolean
  /**
   * Abre o formulário já na primeira renderização — vem de `?lancar=1`.
   *
   * Existe para o formulário ser **linkável**: "lançar despesa" pode chegar de outra
   * tela, de um atalho ou de um link colado no grupo da clínica, sem depender de alguém
   * achar o botão. O efeito colateral útil é que ele passa a existir no HTML servido, o
   * que permite verificá-lo por HTTP — sem isso, os dois campos de data (competência e
   * vencimento, que é a distinção que este módulo inteiro existe para preservar) só
   * poderiam ser conferidos por olho.
   */
  abrirLancamento?: boolean
}) {
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null)
  const [aberta, setAberta] = useState<string | null>(null)
  const [lancando, setLancando] = useState(abrirLancamento)
  const [pendente, iniciar] = useTransition()

  function executar(acao: () => Promise<{ ok: boolean; mensagem: string }>) {
    iniciar(async () => {
      const r = await acao()
      setAviso({ ok: r.ok, texto: r.mensagem })
      if (r.ok) {
        setAberta(null)
        setLancando(false)
      }
    })
  }

  return (
    <div className="space-y-4">
      {aviso !== null && (
        <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.texto}</Alerta>
      )}

      {podeLancar && (
        <div>
          {lancando ? (
            <FormularioDespesa
              categorias={categorias}
              hojeIso={hojeIso}
              pendente={pendente}
              onCancelar={() => setLancando(false)}
              onEnviar={(d) => executar(() => lancarDespesa(d))}
            />
          ) : (
            <Button onClick={() => setLancando(true)}>Lançar despesa</Button>
          )}
        </div>
      )}

      {contas.length === 0 ? (
        <p className="rounded-(--radius-cartao) border border-border bg-surface p-4 text-sm text-fg-2">
          Nada a pagar. Despesas recorrentes aparecem aqui quando a competência chega — nada é
          gravado com antecedência.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-(--radius-cartao) border border-border bg-surface">
          {contas.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-fg">{c.descricao}</p>
                  <p className="text-sm text-fg-2">
                    {c.categoria}
                    {c.fornecedor ? ` · ${c.fornecedor}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-fg-3">
                    vence {c.vencimentoBr} · competência {c.competenciaBr} · valor {c.valorBr}
                    {c.pagoBr !== 'R$ 0,00' ? ` · pago ${c.pagoBr}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span
                    className={cn(
                      'inline-block rounded px-2 py-0.5 text-xs font-medium',
                      COR_SITUACAO[c.situacao],
                    )}
                  >
                    {ROTULO_SITUACAO[c.situacao]}
                    {c.situacao === 'vencida' ? ` há ${c.diasDeAtraso} dia(s)` : ''}
                  </span>
                  <p className="mt-1 text-sm font-semibold text-fg">falta {c.saldoBr}</p>
                </div>
              </div>

              {c.pagamentos.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {c.pagamentos.map((p) => (
                    <li key={p.id} className="text-xs text-fg-3">
                      {/*
                        Pagamento estornado continua visível: ele saiu da soma do saldo,
                        não da história. Esconder faria o extrato do banco (que mostra a
                        saída e a devolução) não bater com o sistema, sem explicação.
                      */}
                      <span className={p.estornado ? 'line-through' : undefined}>
                        {p.valorBr} em {p.pagoEmBr} por {p.meio}
                      </span>
                      {p.estornado ? (
                        <span className="ml-1 text-critico">
                          estornado{p.motivoEstorno ? `: ${p.motivoEstorno}` : ''}
                        </span>
                      ) : podeDesfazer ? (
                        <button
                          type="button"
                          className="ml-2 underline"
                          disabled={pendente}
                          onClick={() => {
                            const motivo = prompt('Motivo do estorno (obrigatório):')
                            if (motivo?.trim()) {
                              executar(() => estornarPagamentoDeDespesa(p.id, motivo))
                            }
                          }}
                        >
                          estornar
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {podeBaixar && c.situacao !== 'paga' && c.situacao !== 'cancelada' && (
                <div className="mt-2">
                  {aberta === c.id ? (
                    <PainelDeBaixa
                      saldoCru={c.saldoCru}
                      saldoBr={c.saldoBr}
                      hojeIso={hojeIso}
                      pendente={pendente}
                      podeDesfazer={podeDesfazer}
                      temPagamento={c.pagamentos.some((p) => !p.estornado)}
                      onFechar={() => setAberta(null)}
                      onPagar={(e) => executar(() => pagarDespesa({ despesaId: c.id, ...e }))}
                      onCancelar={(motivo) => executar(() => cancelarDespesa(c.id, motivo))}
                    />
                  ) : (
                    <Button variante="secundario" tamanho="sm" onClick={() => setAberta(c.id)}>
                      Dar baixa
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PainelDeBaixa({
  saldoCru,
  saldoBr,
  hojeIso,
  pendente,
  podeDesfazer,
  temPagamento,
  onFechar,
  onPagar,
  onCancelar,
}: {
  saldoCru: string
  saldoBr: string
  hojeIso: string
  pendente: boolean
  podeDesfazer: boolean
  temPagamento: boolean
  onFechar: () => void
  onPagar: (e: {
    valor: string
    pagoEm: string
    meio: (typeof MEIOS)[number]['valor']
  }) => void
  onCancelar: (motivo: string) => void
}) {
  // O saldo devedor já vem preenchido: pagar a conta inteira é o caso comum, e digitar
  // o valor de novo é onde nasce o erro de centavo.
  const [valor, setValor] = useState(saldoCru)
  const [pagoEm, setPagoEm] = useState(hojeIso)
  const [meio, setMeio] = useState<(typeof MEIOS)[number]['valor']>('pix')
  const [cancelando, setCancelando] = useState(false)
  const [motivo, setMotivo] = useState('')

  if (cancelando) {
    return (
      <div className="rounded-(--radius-controle) border border-border bg-surface-2 p-3">
        <Textarea
          id="motivo-cancelamento"
          rotulo="Por que cancelar? (obrigatório)"
          ajuda="Despesa cancelada sai do custo do mês. O motivo é o que sobra no histórico."
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
        />
        {temPagamento && (
          <p className="mt-2 text-xs text-critico">
            Esta conta já tem pagamento. Cancelar vai ser recusado — estorne o pagamento
            primeiro, senão a saída de caixa ficaria sem obrigação nenhuma.
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Button
            tamanho="sm"
            disabled={pendente || motivo.trim().length < 3}
            onClick={() => onCancelar(motivo)}
          >
            Cancelar despesa
          </Button>
          <Button variante="secundario" tamanho="sm" onClick={() => setCancelando(false)}>
            Voltar
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-(--radius-controle) border border-border bg-surface-2 p-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          id="valor-pago"
          rotulo="Valor pago"
          ajuda={`saldo devedor: ${saldoBr}`}
          inputMode="decimal"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
        />
        <Input
          id="pago-em"
          rotulo="Saiu do banco em"
          ajuda="é esta data que manda no fluxo de caixa"
          type="date"
          value={pagoEm}
          onChange={(e) => setPagoEm(e.target.value)}
        />
        <Select
          id="meio-pagamento"
          rotulo="Meio"
          value={meio}
          onChange={(e) => setMeio(e.target.value as (typeof MEIOS)[number]['valor'])}
        >
          {MEIOS.map((m) => (
            <option key={m.valor} value={m.valor}>
              {m.rotulo}
            </option>
          ))}
        </Select>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button tamanho="sm" disabled={pendente} onClick={() => onPagar({ valor, pagoEm, meio })}>
          Registrar pagamento
        </Button>
        {podeDesfazer && (
          <Button variante="secundario" tamanho="sm" onClick={() => setCancelando(true)}>
            Cancelar despesa…
          </Button>
        )}
        <Button variante="secundario" tamanho="sm" onClick={onFechar}>
          Fechar
        </Button>
      </div>
    </div>
  )
}

function FormularioDespesa({
  categorias,
  hojeIso,
  pendente,
  onCancelar,
  onEnviar,
}: {
  categorias: readonly CategoriaNaTela[]
  hojeIso: string
  pendente: boolean
  onCancelar: () => void
  onEnviar: (d: {
    categoriaId: string
    descricao: string
    valor: string
    competencia: string
    vencimento: string
    fornecedor?: string
  }) => void
}) {
  const [categoriaId, setCategoriaId] = useState(categorias[0]?.id ?? '')
  const [descricao, setDescricao] = useState('')
  const [valor, setValor] = useState('')
  const [competencia, setCompetencia] = useState(`${hojeIso.slice(0, 7)}-01`)
  const [vencimento, setVencimento] = useState(hojeIso)
  const [fornecedor, setFornecedor] = useState('')

  const podeEnviar = categoriaId !== '' && descricao.trim().length >= 3 && valor.trim() !== ''

  return (
    <div className="rounded-(--radius-cartao) border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-fg">Lançar despesa</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Select
          id="categoria"
          rotulo="Categoria"
          obrigatorio
          value={categoriaId}
          onChange={(e) => setCategoriaId(e.target.value)}
        >
          {categorias.length === 0 && <option value="">nenhuma categoria ativa</option>}
          {categorias.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome} ({c.natureza === 'fixa' ? 'fixa' : 'variável'})
            </option>
          ))}
        </Select>
        <Input
          id="descricao"
          rotulo="Descrição"
          obrigatorio
          ajuda='"diversos" não ajuda ninguém depois'
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
        />
        <Input
          id="valor"
          rotulo="Valor"
          obrigatorio
          inputMode="decimal"
          placeholder="3200.00"
          value={valor}
          onChange={(e) => setValor(e.target.value)}
        />
        <Input
          id="fornecedor"
          rotulo="Fornecedor"
          value={fornecedor}
          onChange={(e) => setFornecedor(e.target.value)}
        />
        {/*
          Competência e vencimento são campos DIFERENTES e ambos visíveis, com a
          explicação ao lado. Um formulário com uma data só forçaria a escolher entre
          "quanto custou julho" e "quando eu pago" — e quem preenche não sabe que está
          escolhendo.
        */}
        <Input
          id="competencia"
          rotulo="Competência"
          ajuda="o mês a que a despesa pertence — manda em “quanto o mês custou”"
          type="date"
          value={competencia}
          onChange={(e) => setCompetencia(e.target.value)}
        />
        <Input
          id="vencimento"
          rotulo="Vencimento"
          ajuda="quando vence — manda na fila de contas a pagar"
          type="date"
          value={vencimento}
          onChange={(e) => setVencimento(e.target.value)}
        />
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          disabled={pendente || !podeEnviar}
          onClick={() =>
            onEnviar({
              categoriaId,
              descricao,
              valor,
              competencia,
              vencimento,
              fornecedor: fornecedor.trim() || undefined,
            })
          }
        >
          Lançar
        </Button>
        <Button variante="secundario" onClick={onCancelar}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}
