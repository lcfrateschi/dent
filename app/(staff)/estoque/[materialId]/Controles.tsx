'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { ajustarInventario, darBaixa, definirMinimo, descartarLote, registrarEntrada } from '@/lib/estoque/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const entrada =
  'h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg placeholder:text-fg-3'

/**
 * Recebimento de material.
 *
 * O campo de quantidade tem **duas unidades** e o padrão é a de compra quando o
 * material vem em embalagem múltipla. É a proteção contra o erro clássico da
 * nota fiscal: quem recebe 2 caixas de 100 luvas digita "2", e sem essa escolha
 * o sistema gravaria 2 pares. O lançamento seria válido para o banco — e o
 * alerta de mínimo simplesmente nunca dispararia.
 */
export function RegistrarEntrada({
  materialId,
  unidade,
  unidadesPorEmbalagem,
  embalagem,
  exigeLote,
}: {
  materialId: string
  unidade: string
  unidadesPorEmbalagem: number
  embalagem: string | null
  exigeLote: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [porEmbalagem, setPorEmbalagem] = useState(unidadesPorEmbalagem > 1)
  const [quantidade, setQuantidade] = useState('1')
  const [custo, setCusto] = useState('')
  const [lote, setLote] = useState('')
  const [validade, setValidade] = useState('')
  const [fornecedor, setFornecedor] = useState('')
  const [nf, setNf] = useState('')
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  if (!aberto) {
    return (
      <Button variante="primario" onClick={() => setAberto(true)}>
        Registrar recebimento
      </Button>
    )
  }

  const total = porEmbalagem
    ? (Number(quantidade || '0') * unidadesPorEmbalagem).toString()
    : quantidade

  return (
    <div className="space-y-3 rounded-(--radius-controle) border border-border bg-surface-2 p-3">
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="qtd" className="block text-xs font-medium text-fg-2">
            Quantidade recebida
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="qtd"
              value={quantidade}
              onChange={(e) => setQuantidade(e.currentTarget.value)}
              className={entrada}
            />
            {unidadesPorEmbalagem > 1 ? (
              <select
                value={porEmbalagem ? 'emb' : 'un'}
                onChange={(e) => setPorEmbalagem(e.currentTarget.value === 'emb')}
                aria-label="Unidade do lançamento"
                className="h-9 rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg"
              >
                <option value="emb">{embalagem ?? `embalagens de ${unidadesPorEmbalagem}`}</option>
                <option value="un">{unidade}</option>
              </select>
            ) : (
              <span className="flex h-9 items-center text-sm text-fg-3">{unidade}</span>
            )}
          </div>
          {porEmbalagem && unidadesPorEmbalagem > 1 ? (
            <p className="mt-1 text-xs text-fg-3">
              Entra no estoque como <strong>{total}</strong> {unidade}.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="custo" className="block text-xs font-medium text-fg-2">
            Custo por {unidade}
          </label>
          <input
            id="custo"
            value={custo}
            onChange={(e) => setCusto(e.currentTarget.value)}
            placeholder="1.20"
            className={`${entrada} mt-1`}
          />
          <p className="mt-1 text-xs text-fg-3">
            É o custo da unidade de consumo, não o da caixa — é ele que valora a baixa.
          </p>
        </div>

        <div>
          <label htmlFor="lote" className="block text-xs font-medium text-fg-2">
            Lote do fabricante {exigeLote ? <span className="text-critico">obrigatório</span> : '(opcional)'}
          </label>
          <input
            id="lote"
            value={lote}
            onChange={(e) => setLote(e.currentTarget.value)}
            className={`${entrada} mt-1`}
          />
          {exigeLote ? (
            <p className="mt-1 text-xs text-fg-3">
              Sem ele, o recolhimento de lote não tem como dizer em quem o material foi usado.
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="validade" className="block text-xs font-medium text-fg-2">
            Validade (em branco = sem validade)
          </label>
          <input
            id="validade"
            type="date"
            value={validade}
            onChange={(e) => setValidade(e.currentTarget.value)}
            className={`${entrada} mt-1`}
          />
        </div>

        <div>
          <label htmlFor="fornecedor" className="block text-xs font-medium text-fg-2">
            Fornecedor
          </label>
          <input
            id="fornecedor"
            value={fornecedor}
            onChange={(e) => setFornecedor(e.currentTarget.value)}
            className={`${entrada} mt-1`}
          />
        </div>

        <div>
          <label htmlFor="nf" className="block text-xs font-medium text-fg-2">
            Nota fiscal
          </label>
          <input
            id="nf"
            value={nf}
            onChange={(e) => setNf(e.currentTarget.value)}
            className={`${entrada} mt-1`}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await registrarEntrada({
                materialId,
                quantidade,
                porEmbalagem,
                custoUnitario: custo || '0.00',
                codigoFabricante: lote || undefined,
                validade: validade || undefined,
                fornecedor: fornecedor || undefined,
                notaFiscal: nf || undefined,
              })
              setAviso(r)
              if (r.ok) {
                setAberto(false)
                router.refresh()
              }
            })
          }
        >
          {pendente ? 'Registrando…' : 'Confirmar entrada'}
        </Button>
        <Button variante="fantasma" onClick={() => setAberto(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

/**
 * Baixa de material.
 *
 * O lote **não** é escolhido aqui por padrão: o FEFO decide, e a tela mostra de
 * qual lote saiu depois. Deixar a escolha aberta em toda baixa faria a pessoa
 * pegar sempre o primeiro da lista, que é o mais novo na prateleira — o oposto
 * do que preserva a validade.
 */
export function DarBaixa({
  materialId,
  unidade,
  controlado,
  profissionalId,
}: {
  materialId: string
  unidade: string
  controlado: boolean
  profissionalId: string | null
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [tipo, setTipo] = useState<'consumo' | 'descarte' | 'devolucao'>('consumo')
  const [quantidade, setQuantidade] = useState('1')
  const [motivo, setMotivo] = useState('')
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  const exigeMotivo = tipo === 'descarte'

  if (!aberto) {
    return <Button onClick={() => setAberto(true)}>Dar baixa</Button>
  }

  return (
    <div className="space-y-3 rounded-(--radius-controle) border border-border bg-surface-2 p-3">
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      {controlado && !profissionalId ? (
        <Alerta tipo="atencao">
          Material de controle especial: a saída exige um profissional responsável, e seu usuário
          não está vinculado a um. Quem retira precisa responder pela retirada.
        </Alerta>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="tipo" className="block text-xs font-medium text-fg-2">
            Tipo
          </label>
          <select
            id="tipo"
            value={tipo}
            onChange={(e) => setTipo(e.currentTarget.value as typeof tipo)}
            className="mt-1 h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg"
          >
            <option value="consumo">Consumo em paciente</option>
            <option value="descarte">Descarte (vencido, quebra, contaminação)</option>
            <option value="devolucao">Devolução ao fornecedor</option>
          </select>
        </div>

        <div>
          <label htmlFor="qtdBaixa" className="block text-xs font-medium text-fg-2">
            Quantidade ({unidade})
          </label>
          <input
            id="qtdBaixa"
            value={quantidade}
            onChange={(e) => setQuantidade(e.currentTarget.value)}
            className={`${entrada} mt-1`}
          />
        </div>

        <div>
          <label htmlFor="motivoBaixa" className="block text-xs font-medium text-fg-2">
            Motivo {exigeMotivo ? <span className="text-critico">obrigatório</span> : '(opcional)'}
          </label>
          <input
            id="motivoBaixa"
            value={motivo}
            onChange={(e) => setMotivo(e.currentTarget.value)}
            className={`${entrada} mt-1`}
          />
        </div>
      </div>

      <p className="text-xs text-fg-3">
        {tipo === 'consumo'
          ? 'Sai do lote que vence primeiro (FEFO), atravessando lotes se precisar. Lote vencido é ignorado — a mensagem avisa se houver.'
          : 'Descarte e devolução podem sair de lote vencido: é justamente o que se faz com ele.'}
      </p>

      <div className="flex gap-2">
        <Button
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await darBaixa({
                materialId,
                quantidade,
                tipo,
                motivo: motivo || undefined,
                profissionalId: profissionalId ?? undefined,
              })
              setAviso(r)
              if (r.ok) {
                setAberto(false)
                router.refresh()
              }
            })
          }
        >
          {pendente ? 'Registrando…' : 'Confirmar baixa'}
        </Button>
        <Button variante="fantasma" onClick={() => setAberto(false)}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

/**
 * Contagem de um lote.
 *
 * Pede **o que foi contado**, não a diferença: quem está com a caixa na mão não
 * deve fazer subtração de cabeça, e é aí que a contagem passa a divergir do
 * estoque em vez de corrigi-lo.
 */
export function ContarLote({
  loteId,
  saldo,
  unidade,
}: {
  loteId: string
  saldo: string
  unidade: string
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [contado, setContado] = useState(saldo)
  const [motivo, setMotivo] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  if (!aberto) {
    return (
      <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(true)}>
        Contar
      </Button>
    )
  }

  const diferenca = Number(contado || '0') - Number(saldo)

  return (
    <div className="w-64 space-y-2">
      <label htmlFor={`contado-${loteId}`} className="block text-xs font-medium text-fg-2">
        Quanto tem na prateleira ({unidade})
      </label>
      <input
        id={`contado-${loteId}`}
        value={contado}
        onChange={(e) => setContado(e.currentTarget.value)}
        className={entrada}
      />
      {diferenca !== 0 ? (
        <p className={diferenca < 0 ? 'text-xs text-critico' : 'text-xs text-atencao'}>
          {diferenca < 0 ? 'Falta' : 'Sobra'} de {Math.abs(diferenca)} em relação ao sistema.
        </p>
      ) : (
        <p className="text-xs text-fg-3">Confere com o sistema.</p>
      )}
      <input
        value={motivo}
        onChange={(e) => setMotivo(e.currentTarget.value)}
        placeholder="Motivo (obrigatório)"
        aria-label="Motivo do ajuste"
        className={entrada}
      />
      {erro ? <p className="text-xs text-critico">{erro}</p> : null}
      <div className="flex gap-1">
        <Button
          tamanho="sm"
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await ajustarInventario({ loteId, quantidadeContada: contado, motivo })
              if (r.ok) {
                setAberto(false)
                router.refresh()
              } else {
                setErro(r.mensagem)
              }
            })
          }
        >
          {pendente ? '…' : 'Registrar contagem'}
        </Button>
        <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(false)}>
          Fechar
        </Button>
      </div>
    </div>
  )
}

/** Descarta todo o saldo de um lote — o atalho da prateleira com lote vencido. */
export function DescartarLote({ loteId, saldo }: { loteId: string; saldo: string }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [motivo, setMotivo] = useState('vencido')
  const [erro, setErro] = useState<string | null>(null)

  if (!aberto) {
    return (
      <Button tamanho="sm" variante="perigo" onClick={() => setAberto(true)}>
        Descartar
      </Button>
    )
  }

  return (
    <div className="w-56 space-y-2">
      <p className="text-xs text-fg-2">
        Descartar os {saldo} restantes. O valor perdido fica no livro — é o que permite discutir
        compra excessiva depois.
      </p>
      <input
        value={motivo}
        onChange={(e) => setMotivo(e.currentTarget.value)}
        placeholder="Motivo"
        aria-label="Motivo do descarte"
        className={entrada}
      />
      {erro ? <p className="text-xs text-critico">{erro}</p> : null}
      <div className="flex gap-1">
        <Button
          tamanho="sm"
          variante="perigo"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await descartarLote(loteId, motivo)
              if (r.ok) {
                setAberto(false)
                router.refresh()
              } else {
                setErro(r.mensagem)
              }
            })
          }
        >
          {pendente ? '…' : 'Confirmar descarte'}
        </Button>
        <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(false)}>
          Fechar
        </Button>
      </div>
    </div>
  )
}

/** Ponto de reposição. O número certo vem do consumo real, não do palpite inicial. */
export function DefinirMinimo({
  materialId,
  minimo,
  unidade,
  sugestao,
}: {
  materialId: string
  minimo: string
  unidade: string
  sugestao: string | null
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [valor, setValor] = useState(minimo)
  const [erro, setErro] = useState<string | null>(null)

  if (!aberto) {
    return (
      <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(true)}>
        Alterar mínimo
      </Button>
    )
  }

  return (
    <div className="w-64 space-y-2">
      <label htmlFor="minimo" className="block text-xs font-medium text-fg-2">
        Mínimo em {unidade}
      </label>
      <input
        id="minimo"
        value={valor}
        onChange={(e) => setValor(e.currentTarget.value)}
        className={entrada}
      />
      {sugestao ? (
        <p className="text-xs text-fg-3">
          Pelo consumo dos últimos 90 dias, {sugestao} cobre duas semanas.
        </p>
      ) : null}
      {erro ? <p className="text-xs text-critico">{erro}</p> : null}
      <div className="flex gap-1">
        <Button
          tamanho="sm"
          variante="primario"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await definirMinimo(materialId, valor)
              if (r.ok) {
                setAberto(false)
                router.refresh()
              } else {
                setErro(r.mensagem)
              }
            })
          }
        >
          {pendente ? '…' : 'Salvar'}
        </Button>
        <Button tamanho="sm" variante="fantasma" onClick={() => setAberto(false)}>
          Fechar
        </Button>
      </div>
    </div>
  )
}
