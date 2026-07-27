'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { alternarConvenio, salvarConvenio } from '@/lib/convenios/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const campo =
  'h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg placeholder:text-fg-3'

interface ConvenioEditavel {
  id: string
  nome: string
  registroAns: string | null
  codigoPrestador: string | null
  cnpj: string | null
  prazoPagamentoDias: number
  diaFechamento: number | null
  contatoNome: string | null
  contatoTelefone: string | null
  observacoes: string | null
  ativo: boolean
}

function Formulario({
  inicial,
  aoConcluir,
  aoCancelar,
}: {
  inicial?: ConvenioEditavel
  aoConcluir: () => void
  aoCancelar: () => void
}) {
  const [pendente, iniciar] = useTransition()
  const [nome, setNome] = useState(inicial?.nome ?? '')
  const [registroAns, setRegistroAns] = useState(inicial?.registroAns ?? '')
  const [codigoPrestador, setCodigoPrestador] = useState(inicial?.codigoPrestador ?? '')
  const [cnpj, setCnpj] = useState(inicial?.cnpj ?? '')
  const [prazo, setPrazo] = useState(String(inicial?.prazoPagamentoDias ?? 30))
  const [diaFechamento, setDiaFechamento] = useState(
    inicial?.diaFechamento ? String(inicial.diaFechamento) : '',
  )
  const [contatoNome, setContatoNome] = useState(inicial?.contatoNome ?? '')
  const [contatoTelefone, setContatoTelefone] = useState(inicial?.contatoTelefone ?? '')
  const [observacoes, setObservacoes] = useState(inicial?.observacoes ?? '')
  const [erro, setErro] = useState<string | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        setErro(null)
        iniciar(async () => {
          const r = await salvarConvenio(
            {
              nome,
              registroAns: registroAns || undefined,
              codigoPrestador: codigoPrestador || undefined,
              cnpj: cnpj || undefined,
              prazoPagamentoDias: Number(prazo),
              diaFechamento: diaFechamento ? Number(diaFechamento) : undefined,
              contatoNome: contatoNome || undefined,
              contatoTelefone: contatoTelefone || undefined,
              observacoes: observacoes || undefined,
            },
            inicial?.id,
          )
          if (!r.ok) {
            setErro(r.mensagem)
            return
          }
          aoConcluir()
        })
      }}
    >
      {erro ? <Alerta tipo="critico">{erro}</Alerta> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="op-nome" className="block text-xs font-medium text-fg-2">
            Nome da operadora
          </label>
          <input
            id="op-nome"
            value={nome}
            onChange={(e) => setNome(e.currentTarget.value)}
            className={`${campo} mt-1`}
            required
          />
        </div>
        <div>
          <label htmlFor="op-ans" className="block text-xs font-medium text-fg-2">
            Registro ANS
          </label>
          <input
            id="op-ans"
            value={registroAns}
            onChange={(e) => setRegistroAns(e.currentTarget.value)}
            placeholder="5 ou 6 dígitos"
            className={`${campo} mt-1`}
          />
        </div>
        <div>
          <label htmlFor="op-prestador" className="block text-xs font-medium text-fg-2">
            Nosso código nesta operadora
          </label>
          <input
            id="op-prestador"
            value={codigoPrestador}
            onChange={(e) => setCodigoPrestador(e.currentTarget.value)}
            maxLength={20}
            className={`${campo} mt-1`}
          />
          <p className="mt-1 text-xs text-fg-3">
            O código que ESTA operadora deu à clínica — vai no XML TISS. Cada operadora usa
            um formato próprio, então nada é recusado aqui. Está no contrato ou no portal
            dela; deixe em branco se ainda não faturou por esta operadora.
          </p>
        </div>
        <div>
          <label htmlFor="op-cnpj" className="block text-xs font-medium text-fg-2">
            CNPJ
          </label>
          <input
            id="op-cnpj"
            value={cnpj}
            onChange={(e) => setCnpj(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label htmlFor="op-prazo" className="block text-xs font-medium text-fg-2">
              Prazo de pagamento (dias)
            </label>
            <input
              id="op-prazo"
              value={prazo}
              onChange={(e) => setPrazo(e.currentTarget.value)}
              className={`${campo} mt-1`}
            />
          </div>
          <div className="w-28">
            <label htmlFor="op-fecha" className="block text-xs font-medium text-fg-2">
              Dia do lote
            </label>
            <input
              id="op-fecha"
              value={diaFechamento}
              onChange={(e) => setDiaFechamento(e.currentTarget.value)}
              placeholder="—"
              className={`${campo} mt-1`}
            />
          </div>
        </div>
        <div>
          <label htmlFor="op-contato" className="block text-xs font-medium text-fg-2">
            Contato na operadora
          </label>
          <input
            id="op-contato"
            value={contatoNome}
            onChange={(e) => setContatoNome(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
        </div>
        <div>
          <label htmlFor="op-fone" className="block text-xs font-medium text-fg-2">
            Telefone do contato
          </label>
          <input
            id="op-fone"
            value={contatoTelefone}
            onChange={(e) => setContatoTelefone(e.currentTarget.value)}
            className={`${campo} mt-1`}
          />
        </div>
      </div>

      <div>
        <label htmlFor="op-obs" className="block text-xs font-medium text-fg-2">
          Observações
        </label>
        <textarea
          id="op-obs"
          rows={2}
          value={observacoes}
          onChange={(e) => setObservacoes(e.currentTarget.value)}
          placeholder="Particularidades do contrato: cobra coparticipação? exige autorização prévia para quais procedimentos?"
          className="mt-1 w-full rounded-(--radius-controle) border border-border bg-surface px-2 py-1 text-sm text-fg placeholder:text-fg-3"
        />
      </div>

      <p className="text-xs text-fg-3">
        O prazo de pagamento é o do contrato e alimenta a previsão de repasse — é o que faz a tela
        de convênios apontar guia atrasada sem ninguém conferir data no papel.
      </p>

      <div className="flex gap-2">
        <Button type="submit" variante="primario" disabled={pendente}>
          {pendente ? 'Salvando…' : inicial ? 'Salvar' : 'Cadastrar operadora'}
        </Button>
        <Button type="button" variante="fantasma" onClick={aoCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}

export function NovoConvenio() {
  const router = useRouter()
  const [aberto, setAberto] = useState(false)

  if (!aberto) {
    return (
      <Button variante="primario" onClick={() => setAberto(true)}>
        Nova operadora
      </Button>
    )
  }

  return (
    <div className="w-full rounded-(--radius-controle) border border-border bg-surface-2 p-3">
      <Formulario
        aoConcluir={() => {
          setAberto(false)
          router.refresh()
        }}
        aoCancelar={() => setAberto(false)}
      />
    </div>
  )
}

export function ConvenioControles({ convenio }: { convenio: ConvenioEditavel }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [editando, setEditando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  if (editando) {
    return (
      <div className="w-full min-w-80 rounded-(--radius-controle) border border-border bg-surface-2 p-3">
        <Formulario
          inicial={convenio}
          aoConcluir={() => {
            setEditando(false)
            router.refresh()
          }}
          aoCancelar={() => setEditando(false)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {aviso ? <p className="text-xs text-fg-2">{aviso}</p> : null}
      <div className="flex flex-wrap gap-1">
        <Button tamanho="sm" variante="fantasma" onClick={() => setEditando(true)}>
          Editar
        </Button>
        <Button
          tamanho="sm"
          variante="fantasma"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await alternarConvenio(convenio.id, !convenio.ativo)
              setAviso(r.mensagem)
              router.refresh()
            })
          }
          title="Nunca apaga: guia, repasse e carteirinha apontam para a operadora."
        >
          {convenio.ativo ? 'Desativar' : 'Reativar'}
        </Button>
      </div>
    </div>
  )
}
