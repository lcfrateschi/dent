'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import {
  desativarCadeira,
  reativarCadeira,
  salvarCadeira,
  salvarClinica,
  salvarHorario,
} from '@/lib/admin/acoes'
import { NOME_DIA, type DiaSemana, type HorarioFuncionamento } from '@/lib/domain/horario'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const campo =
  'h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg placeholder:text-fg-3'

interface DadosClinica {
  razaoSocial: string
  nomeFantasia: string
  cnpj: string
  croResponsavel: string
  ufCroResponsavel: string
  cnes: string
  telefone: string
  email: string
  cep: string
  logradouro: string
  numero: string
  complemento: string
  bairro: string
  cidade: string
  uf: string
}

export function ClinicaEditor({ inicial }: { inicial: DadosClinica }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [d, setD] = useState(inicial)
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  function campoTexto(
    id: keyof DadosClinica,
    rotulo: string,
    extra?: { maxLength?: number; ajuda?: string; largura?: string },
  ) {
    return (
      <div className={extra?.largura}>
        <label htmlFor={`c-${id}`} className="block text-xs font-medium text-fg-2">
          {rotulo}
        </label>
        <input
          id={`c-${id}`}
          value={d[id]}
          maxLength={extra?.maxLength}
          onChange={(e) => setD({ ...d, [id]: e.currentTarget.value })}
          className={`${campo} mt-1`}
        />
        {extra?.ajuda ? <p className="mt-1 text-xs text-fg-3">{extra.ajuda}</p> : null}
      </div>
    )
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        iniciar(async () => {
          const r = await salvarClinica(d)
          setAviso(r)
          if (r.ok) router.refresh()
        })
      }}
    >
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {campoTexto('razaoSocial', 'Razão social')}
        {campoTexto('nomeFantasia', 'Nome fantasia')}
        {campoTexto('cnpj', 'CNPJ', {
          ajuda: 'Conferido pelos dígitos verificadores — errado, volta como glosa de dado do prestador.',
        })}
        <div className="flex gap-2">
          <div className="flex-1">
            {campoTexto('croResponsavel', 'CRO do responsável técnico')}
          </div>
          <div className="w-20">{campoTexto('ufCroResponsavel', 'UF', { maxLength: 2 })}</div>
        </div>
        {campoTexto('cnes', 'CNES do estabelecimento', {
          maxLength: 7,
          ajuda:
            'Sete dígitos, obrigatório no faturamento por convênio (vai no XML TISS). ' +
            'Não é usado no particular — deixe em branco se a clínica não fatura convênio.',
        })}
        {campoTexto('telefone', 'Telefone')}
        {campoTexto('email', 'E-mail')}
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {campoTexto('cep', 'CEP')}
        <div className="sm:col-span-2">{campoTexto('logradouro', 'Logradouro')}</div>
        {campoTexto('numero', 'Número')}
        {campoTexto('complemento', 'Complemento')}
        {campoTexto('bairro', 'Bairro')}
        {campoTexto('cidade', 'Cidade')}
        {campoTexto('uf', 'UF', { maxLength: 2 })}
      </div>

      <Button type="submit" variante="primario" disabled={pendente}>
        {pendente ? 'Salvando…' : 'Salvar identificação'}
      </Button>
    </form>
  )
}

const PASSOS = [10, 15, 20, 30, 60] as const

/**
 * Editor do horário de funcionamento.
 *
 * Duas faixas por dia, porque é o que a clínica usa (manhã e tarde, com almoço no
 * meio). Deixar em branco fecha o dia — e é assim que domingo e feriado
 * combinado ficam fora da grade.
 */
export function HorarioEditor({
  inicial,
  passoInicial,
}: {
  inicial: HorarioFuncionamento
  passoInicial: number
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [passo, setPasso] = useState(passoInicial)
  const [horario, setHorario] = useState<Record<string, { inicio: string; fim: string }[]>>(() => {
    const inicio: Record<string, { inicio: string; fim: string }[]> = {}
    for (const d of [0, 1, 2, 3, 4, 5, 6]) {
      const faixas = inicial[String(d)] ?? []
      inicio[String(d)] = [
        { inicio: faixas[0]?.inicio ?? '', fim: faixas[0]?.fim ?? '' },
        { inicio: faixas[1]?.inicio ?? '', fim: faixas[1]?.fim ?? '' },
      ]
    }
    return inicio
  })
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  function alterar(dia: number, indice: number, chave: 'inicio' | 'fim', valor: string) {
    setHorario((h) => {
      const faixas = [...(h[String(dia)] ?? [])]
      faixas[indice] = { ...(faixas[indice] ?? { inicio: '', fim: '' }), [chave]: valor }
      return { ...h, [String(dia)]: faixas }
    })
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        const limpo: Record<string, { inicio: string; fim: string }[]> = {}
        for (const [dia, faixas] of Object.entries(horario)) {
          const validas = faixas.filter((f) => f.inicio && f.fim)
          limpo[dia] = validas
        }
        iniciar(async () => {
          // Ação própria: mandar `razaoSocial` daqui gravaria um nome falso por
          // cima do da clínica, e o cabeçalho dos impressos sumiria.
          const r = await salvarHorario(limpo, passo)
          setAviso(r)
          if (r.ok) router.refresh()
        })
      }}
    >
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      <div className="space-y-1">
        {[1, 2, 3, 4, 5, 6, 0].map((dia) => (
          <div key={dia} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-24 text-xs text-fg-3">{NOME_DIA[dia as DiaSemana]}</span>
            {[0, 1].map((i) => (
              <span key={i} className="flex items-center gap-1">
                <input
                  type="time"
                  aria-label={`${NOME_DIA[dia as DiaSemana]} faixa ${i + 1} início`}
                  value={horario[String(dia)]?.[i]?.inicio ?? ''}
                  onChange={(e) => alterar(dia, i, 'inicio', e.currentTarget.value)}
                  className="h-8 rounded-(--radius-controle) border border-border bg-surface px-1 text-xs text-fg"
                />
                <span className="text-fg-3">–</span>
                <input
                  type="time"
                  aria-label={`${NOME_DIA[dia as DiaSemana]} faixa ${i + 1} fim`}
                  value={horario[String(dia)]?.[i]?.fim ?? ''}
                  onChange={(e) => alterar(dia, i, 'fim', e.currentTarget.value)}
                  className="h-8 rounded-(--radius-controle) border border-border bg-surface px-1 text-xs text-fg"
                />
              </span>
            ))}
          </div>
        ))}
      </div>

      <div>
        <label htmlFor="passo" className="block text-xs font-medium text-fg-2">
          Passo da agenda
        </label>
        <select
          id="passo"
          value={passo}
          onChange={(e) => setPasso(Number(e.currentTarget.value))}
          className={`${campo} mt-1 max-w-40`}
        >
          {PASSOS.map((p) => (
            <option key={p} value={p}>
              {p} minutos
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-fg-3">
          De quanto em quanto tempo a grade oferece horário. 15 minutos serve para consultório com
          procedimentos de duração variada.
        </p>
      </div>

      <Button type="submit" variante="primario" disabled={pendente}>
        {pendente ? 'Salvando…' : 'Salvar horário'}
      </Button>
      <p className="text-xs text-fg-3">
        Dia sem faixa é dia fechado. Faixa invertida ou sobreposta é recusada — a grade ofereceria
        horário que não existe.
      </p>
    </form>
  )
}

interface CadeiraNaTela {
  id: string
  nome: string
  ordem: number
  ativo: boolean
  agendamentosFuturos: number
}

export function CadeirasEditor({ cadeiras }: { cadeiras: readonly CadeiraNaTela[] }) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [nova, setNova] = useState('')
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  return (
    <div className="space-y-3">
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      <ul className="space-y-1">
        {cadeiras.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-controle) border border-border px-3 py-2 text-sm"
          >
            <span className={c.ativo ? 'text-fg' : 'text-fg-3'}>
              {c.nome}
              {!c.ativo ? <span className="ml-2 text-xs">(inativa)</span> : null}
              {c.agendamentosFuturos > 0 ? (
                <span className="ml-2 text-xs text-fg-3">
                  {c.agendamentosFuturos} agendamento(s) futuro(s)
                </span>
              ) : null}
            </span>
            {c.ativo ? (
              <Button
                tamanho="sm"
                variante="fantasma"
                disabled={pendente || c.agendamentosFuturos > 0}
                title={
                  c.agendamentosFuturos > 0
                    ? 'Há agendamento futuro nesta cadeira. Remarque antes de desativá-la.'
                    : undefined
                }
                onClick={() =>
                  iniciar(async () => {
                    const r = await desativarCadeira(c.id)
                    setAviso(r)
                    router.refresh()
                  })
                }
              >
                Desativar
              </Button>
            ) : (
              <Button
                tamanho="sm"
                variante="fantasma"
                disabled={pendente}
                onClick={() =>
                  iniciar(async () => {
                    const r = await reativarCadeira(c.id)
                    setAviso(r)
                    router.refresh()
                  })
                }
              >
                Reativar
              </Button>
            )}
          </li>
        ))}
      </ul>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          iniciar(async () => {
            const r = await salvarCadeira({ nome: nova, ordem: cadeiras.length + 1 })
            setAviso(r)
            if (r.ok) {
              setNova('')
              router.refresh()
            }
          })
        }}
      >
        <input
          value={nova}
          onChange={(e) => setNova(e.currentTarget.value)}
          placeholder="Nome da nova cadeira"
          aria-label="Nome da nova cadeira"
          className={campo}
        />
        <Button type="submit" disabled={pendente || nova.trim().length < 2}>
          Adicionar
        </Button>
      </form>
    </div>
  )
}
