'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { salvarFichaTecnica, salvarMaterial } from '@/lib/estoque/acoes'
import { formatarQuantidade } from '@/lib/domain/quantidade'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const campo =
  'h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg placeholder:text-fg-3'

interface MaterialOpcao {
  id: string
  codigo: string
  nome: string
  unidade: string
}

interface ItemDaFicha {
  materialId: string
  codigo: string
  nome: string
  unidade: string
  quantidade: string
}

/**
 * Editor da ficha de um procedimento.
 *
 * Salvar **substitui o conjunto**, não mescla. Mesclagem silenciosa deixaria na
 * tela um insumo que a pessoa acabou de remover, e a conclusão seria que o
 * sistema não salvou.
 */
export function EditorDeFicha({
  procedimento,
  itens,
  materiais,
}: {
  procedimento: { id: string; codigo: string; nome: string; especialidade: string | null }
  itens: readonly ItemDaFicha[]
  materiais: readonly MaterialOpcao[]
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [lista, setLista] = useState<ItemDaFicha[]>([...itens])
  const [novoMaterial, setNovoMaterial] = useState(materiais[0]?.id ?? '')
  const [novaQtd, setNovaQtd] = useState('1')
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  function adicionar() {
    const m = materiais.find((x) => x.id === novoMaterial)
    if (!m) return
    if (lista.some((i) => i.materialId === m.id)) {
      setAviso({ ok: false, mensagem: `${m.nome} já está na ficha.` })
      return
    }
    setLista([
      ...lista,
      { materialId: m.id, codigo: m.codigo, nome: m.nome, unidade: m.unidade, quantidade: novaQtd },
    ])
    setNovaQtd('1')
    setAviso(null)
  }

  if (!aberto) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
        <div>
          <span className="font-medium text-fg">{procedimento.nome}</span>
          <span className="ml-2 font-mono text-xs text-fg-3">{procedimento.codigo}</span>
          {itens.length === 0 ? (
            <span className="ml-2 text-xs text-atencao">sem ficha</span>
          ) : (
            <span className="ml-2 text-xs text-fg-3">
              {itens.length} insumo(s):{' '}
              {itens
                .slice(0, 3)
                .map((i) => `${i.nome.split(' ').slice(0, 2).join(' ')} ${formatarQuantidade(i.quantidade)}`)
                .join(', ')}
              {itens.length > 3 ? '…' : null}
            </span>
          )}
        </div>
        <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(true)}>
          {itens.length === 0 ? 'Montar ficha' : 'Editar'}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 bg-surface-2 px-4 py-3">
      <p className="text-sm font-medium text-fg">{procedimento.nome}</p>
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      {lista.length === 0 ? (
        <p className="text-xs text-fg-3">Nenhum insumo. Adicione abaixo.</p>
      ) : (
        <ul className="space-y-1">
          {lista.map((i, indice) => (
            <li key={i.materialId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-56 flex-1 text-fg-2">
                {i.nome}
                <span className="ml-2 font-mono text-xs text-fg-3">{i.codigo}</span>
              </span>
              <input
                value={i.quantidade}
                aria-label={`Quantidade de ${i.nome}`}
                onChange={(e) => {
                  const v = e.currentTarget.value
                  setLista(lista.map((x, j) => (j === indice ? { ...x, quantidade: v } : x)))
                }}
                className="h-8 w-24 rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg"
              />
              <span className="w-16 text-xs text-fg-3">{i.unidade}</span>
              <Button
                tamanho="sm"
                variante="fantasma"
                onClick={() => setLista(lista.filter((_, j) => j !== indice))}
              >
                Remover
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-56 flex-1">
          <label htmlFor={`add-${procedimento.id}`} className="block text-xs font-medium text-fg-2">
            Adicionar insumo
          </label>
          <select
            id={`add-${procedimento.id}`}
            value={novoMaterial}
            onChange={(e) => setNovoMaterial(e.currentTarget.value)}
            className={`${campo} mt-1`}
          >
            {materiais.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nome} ({m.unidade})
              </option>
            ))}
          </select>
        </div>
        <div className="w-24">
          <label htmlFor={`qtd-${procedimento.id}`} className="block text-xs font-medium text-fg-2">
            Quantidade
          </label>
          <input
            id={`qtd-${procedimento.id}`}
            value={novaQtd}
            onChange={(e) => setNovaQtd(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
        </div>
        <Button onClick={adicionar}>Adicionar</Button>
      </div>

      <div className="flex gap-2">
        <Button
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await salvarFichaTecnica(
                procedimento.id,
                lista.map((i) => ({ materialId: i.materialId, quantidade: i.quantidade })),
              )
              setAviso(r)
              if (r.ok) {
                setAberto(false)
                router.refresh()
              }
            })
          }
        >
          {pendente ? 'Salvando…' : 'Salvar ficha'}
        </Button>
        <Button
          variante="fantasma"
          onClick={() => {
            setLista([...itens])
            setAberto(false)
          }}
        >
          Cancelar
        </Button>
      </div>
    </div>
  )
}

const CATEGORIAS = [
  'anestesico',
  'restaurador',
  'endodontia',
  'cirurgia',
  'protese',
  'ortodontia',
  'radiologia',
  'descartavel',
  'instrumental',
  'esterilizacao',
  'medicamento',
  'escritorio',
] as const

const UNIDADES = ['unidade', 'tubete', 'caixa', 'frasco', 'ml', 'g', 'par', 'rolo', 'folha'] as const

/**
 * Cadastro de material.
 *
 * Dois campos que decidem se o controle funciona ou não:
 *
 * - **Unidade** é a de CONSUMO, não a de compra. Quem consome tira um tubete, não
 *   uma caixa.
 * - **Unidades por embalagem** é a conversão do recebimento. Lançar "2" ao receber
 *   2 caixas de 100 luvas é entrada válida para o banco e alerta de mínimo que
 *   nunca dispara.
 */
export function NovoMaterial() {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [codigo, setCodigo] = useState('')
  const [nome, setNome] = useState('')
  const [categoria, setCategoria] = useState<string>('descartavel')
  const [unidade, setUnidade] = useState<string>('unidade')
  const [porEmbalagem, setPorEmbalagem] = useState('1')
  const [embalagem, setEmbalagem] = useState('')
  const [minimo, setMinimo] = useState('0')
  const [controlado, setControlado] = useState(false)
  const [exigeLote, setExigeLote] = useState(false)
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  if (!aberto) {
    return (
      <Button variante="primario" onClick={() => setAberto(true)}>
        Novo material
      </Button>
    )
  }

  return (
    <form
      className="w-full space-y-3 rounded-(--radius-controle) border border-border bg-surface-2 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        iniciar(async () => {
          const r = await salvarMaterial({
            codigo,
            nome,
            categoria,
            unidade,
            unidadesPorEmbalagem: Number(porEmbalagem),
            embalagem: embalagem || undefined,
            quantidadeMinima: minimo,
            controlado,
            exigeLoteDoFabricante: exigeLote,
          })
          setAviso(r)
          if (r.ok) {
            setAberto(false)
            setCodigo('')
            setNome('')
            router.refresh()
          }
        })
      }}
    >
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="m-codigo" className="block text-xs font-medium text-fg-2">
            Código interno
          </label>
          <input
            id="m-codigo"
            value={codigo}
            onChange={(e) => setCodigo(e.currentTarget.value)}
            placeholder="BIO-007"
            className={`${campo} mt-1`}
            required
          />
          <p className="mt-1 text-xs text-fg-3">É o que está etiquetado na prateleira.</p>
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="m-nome" className="block text-xs font-medium text-fg-2">
            Nome
          </label>
          <input
            id="m-nome"
            value={nome}
            onChange={(e) => setNome(e.currentTarget.value)}
            className={`${campo} mt-1`}
            required
          />
        </div>
        <div>
          <label htmlFor="m-cat" className="block text-xs font-medium text-fg-2">
            Categoria
          </label>
          <select
            id="m-cat"
            value={categoria}
            onChange={(e) => setCategoria(e.currentTarget.value)}
            className={`${campo} mt-1`}
          >
            {CATEGORIAS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="m-un" className="block text-xs font-medium text-fg-2">
            Unidade de consumo
          </label>
          <select
            id="m-un"
            value={unidade}
            onChange={(e) => setUnidade(e.currentTarget.value)}
            className={`${campo} mt-1`}
          >
            {UNIDADES.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-fg-3">O que sai do armário, não o que vem do fornecedor.</p>
        </div>
        <div>
          <label htmlFor="m-min" className="block text-xs font-medium text-fg-2">
            Mínimo
          </label>
          <input
            id="m-min"
            value={minimo}
            onChange={(e) => setMinimo(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
        </div>
        <div>
          <label htmlFor="m-emb" className="block text-xs font-medium text-fg-2">
            Unidades por embalagem
          </label>
          <input
            id="m-emb"
            value={porEmbalagem}
            onChange={(e) => setPorEmbalagem(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="m-emb-desc" className="block text-xs font-medium text-fg-2">
            Como o fornecedor vende
          </label>
          <input
            id="m-emb-desc"
            value={embalagem}
            onChange={(e) => setEmbalagem(e.currentTarget.value)}
            placeholder="caixa com 100 unidades"
            className={`${campo} mt-1`}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-sm text-fg-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={exigeLote}
            onChange={(e) => setExigeLote(e.currentTarget.checked)}
          />
          Exige lote do fabricante
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={controlado}
            onChange={(e) => setControlado(e.currentTarget.checked)}
          />
          Controle especial (Portaria 344/98)
        </label>
      </div>
      <p className="text-xs text-fg-3">
        Marque o lote do fabricante para implante, enxerto e membrana: se o fabricante recolher um
        lote, é o que permite dizer em quem foi usado. Não marque para luva e babador — o campo
        acabaria preenchido com número inventado.
      </p>

      <div className="flex gap-2">
        <Button type="submit" variante="primario" disabled={pendente}>
          {pendente ? 'Salvando…' : 'Cadastrar material'}
        </Button>
        <Button type="button" variante="fantasma" onClick={() => setAberto(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
