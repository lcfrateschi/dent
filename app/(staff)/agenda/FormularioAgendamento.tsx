'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta, Input, Select, Textarea } from '@/components/ui/Input'
import type { ResultadoAgenda } from '@/lib/agenda/acoes'
import { buscarHorariosLivres } from './acoesCliente'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect, useState, useTransition } from 'react'

export interface OpcaoSimples {
  readonly id: string
  readonly nome: string
}

export interface OpcaoProcedimento extends OpcaoSimples {
  readonly duracaoMinutos: number
}

export function FormularioAgendamento({
  pacientes,
  profissionais,
  cadeiras,
  procedimentos,
  inicial,
  acao,
}: {
  pacientes: readonly OpcaoSimples[]
  profissionais: readonly OpcaoSimples[]
  cadeiras: readonly OpcaoSimples[]
  procedimentos: readonly OpcaoProcedimento[]
  inicial: {
    dia: string
    hora?: string | undefined
    profissionalId?: string | undefined
    pacienteId?: string | undefined
  }
  acao: (anterior: ResultadoAgenda | null, dados: FormData) => Promise<ResultadoAgenda>
}) {
  const router = useRouter()
  const [estado, enviar, pendente] = useActionState(acao, null)

  const [dia, setDia] = useState(inicial.dia)
  const [profissionalId, setProfissionalId] = useState(inicial.profissionalId ?? profissionais[0]?.id ?? '')
  const [cadeiraId, setCadeiraId] = useState('')
  const [duracao, setDuracao] = useState(30)
  const [hora, setHora] = useState(inicial.hora ?? '')
  const [livres, setLivres] = useState<readonly string[] | null>(null)
  const [carregando, iniciar] = useTransition()

  useEffect(() => {
    if (estado?.ok) router.push(`/agenda?ref=${dia}`)
  }, [estado, router, dia])

  // Recalcula os horários livres a cada mudança que os afeta. É conveniência de
  // UI: a garantia contra dupla marcação é a EXCLUDE constraint no banco.
  useEffect(() => {
    if (!dia || !profissionalId || duracao <= 0) {
      setLivres(null)
      return
    }
    iniciar(async () => {
      const r = await buscarHorariosLivres({
        diaIso: dia,
        profissionalId,
        duracaoMin: duracao,
        cadeiraId: cadeiraId || undefined,
      })
      setLivres(r)
    })
  }, [dia, profissionalId, duracao, cadeiraId])

  const erros = estado && !estado.ok ? estado.erros : {}

  return (
    <form action={enviar} className="space-y-4">
      {estado && !estado.ok && estado.mensagem ? <Alerta>{estado.mensagem}</Alerta> : null}

      <Card>
        <CardHeader titulo="Atendimento" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Select
            id="pacienteId"
            name="pacienteId"
            rotulo="Paciente"
            defaultValue={inicial.pacienteId ?? ''}
            erro={erros.pacienteId}
            obrigatorio
          >
            <option value="">— selecione —</option>
            {pacientes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </Select>

          <Select
            id="profissionalId"
            name="profissionalId"
            rotulo="Profissional"
            value={profissionalId}
            onChange={(e) => setProfissionalId(e.currentTarget.value)}
            erro={erros.profissionalId}
            obrigatorio
          >
            <option value="">— selecione —</option>
            {profissionais.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </Select>

          <Select
            id="cadeiraId"
            name="cadeiraId"
            rotulo="Cadeira"
            value={cadeiraId}
            onChange={(e) => setCadeiraId(e.currentTarget.value)}
            erro={erros.cadeiraId}
            ajuda="Opcional, mas evita dois atendimentos na mesma sala."
          >
            <option value="">— não definir —</option>
            {cadeiras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
              </option>
            ))}
          </Select>

          {/* Não vai para o banco: serve só para sugerir a duração. */}
          <Select
            id="procedimentoRef"
            rotulo="Procedimento previsto"
            onChange={(e) => {
              const p = procedimentos.find((x) => x.id === e.currentTarget.value)
              if (p) setDuracao(p.duracaoMinutos)
            }}
            ajuda="Só para sugerir a duração — o plano de tratamento entra na Fase 6."
          >
            <option value="">— não definir —</option>
            {procedimentos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome} ({p.duracaoMinutos} min)
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Data e horário"
          descricao="A lista mostra só horários dentro do funcionamento, sem bloqueio e sem ocupação."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              id="dia"
              name="dia"
              type="date"
              rotulo="Data"
              value={dia}
              onChange={(e) => setDia(e.currentTarget.value)}
              erro={erros.dia}
              obrigatorio
            />
            <Input
              id="duracaoMinutos"
              name="duracaoMinutos"
              type="number"
              rotulo="Duração (min)"
              value={duracao}
              min={5}
              max={480}
              step={5}
              onChange={(e) => setDuracao(Number(e.currentTarget.value) || 0)}
              erro={erros.duracaoMinutos}
              obrigatorio
            />
            <Select id="origem" name="origem" rotulo="Origem" defaultValue="recepcao" erro={erros.origem}>
              <option value="recepcao">Recepção</option>
              <option value="telefone">Telefone</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="encaixe">Encaixe</option>
            </Select>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-fg-2">
              Horário <span className="text-critico">*</span>
            </span>
            {/* O valor real vai neste campo oculto; os botões são o seletor. */}
            <input type="hidden" name="hora" value={hora} />

            {carregando ? (
              <p className="text-sm text-fg-3">Buscando horários livres…</p>
            ) : livres === null ? (
              <p className="text-sm text-fg-3">Escolha data, profissional e duração.</p>
            ) : livres.length === 0 ? (
              <Alerta tipo="atencao">
                Nenhum horário livre neste dia para essa duração. Tente outro dia, outra duração,
                ou registre um encaixe fora da grade.
              </Alerta>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {livres.map((h) => (
                  <Button
                    key={h}
                    type="button"
                    tamanho="sm"
                    ativo={hora === h}
                    onClick={() => setHora(h)}
                  >
                    {h}
                  </Button>
                ))}
              </div>
            )}
            {erros.hora ? <p className="mt-1 text-sm text-critico">{erros.hora}</p> : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          titulo="Repetir"
          descricao="Para manutenção ortodôntica mensal e séries de sessões."
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Select id="repetir" name="repetir" rotulo="Frequência" erro={erros.repetir}>
            <option value="">Não repetir</option>
            <option value="semanal">Semanal</option>
            <option value="quinzenal">Quinzenal</option>
            <option value="mensal">Mensal</option>
          </Select>
          <Input
            id="repeticoes"
            name="repeticoes"
            type="number"
            rotulo="Quantas ocorrências"
            defaultValue={1}
            min={1}
            max={24}
            erro={erros.repeticoes}
            ajuda="Tudo ou nada: se um horário conflitar, nenhuma ocorrência é criada."
          />
          <Textarea
            id="observacao"
            name="observacao"
            rotulo="Observação"
            erro={erros.observacao}
            className="sm:col-span-2"
          />
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <Button
          type="submit"
          variante="primario"
          tamanho="lg"
          disabled={pendente || hora.length === 0}
        >
          {pendente ? 'Agendando…' : 'Agendar'}
        </Button>
        <Button type="button" tamanho="lg" variante="fantasma" onClick={() => router.push('/agenda')}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
