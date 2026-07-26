'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta, Input } from '@/components/ui/Input'
import { reagendar } from '@/lib/agenda/acoes'
import { buscarHorariosLivres } from '../../acoesCliente'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

/**
 * Reagendamento por escolha de horário livre.
 *
 * Deliberadamente NÃO é arrastar-e-soltar. Numa clínica o reagendamento
 * acontece com o paciente ao telefone: a recepção precisa LER as opções em voz
 * alta, e o alvo de arraste falha em tablet, que é metade dos equipamentos no
 * balcão. Arrastar entra depois, como atalho, não como único caminho.
 */
export function FormularioReagendar({
  id,
  profissionalId,
  cadeiraId,
  diaAtual,
  duracaoMin,
}: {
  id: string
  profissionalId: string
  cadeiraId: string | null
  diaAtual: string
  duracaoMin: number
}) {
  const router = useRouter()
  const [dia, setDia] = useState(diaAtual)
  const [duracao, setDuracao] = useState(duracaoMin)
  const [hora, setHora] = useState('')
  const [livres, setLivres] = useState<readonly string[] | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [carregando, buscar] = useTransition()
  const [salvando, salvar] = useTransition()

  useEffect(() => {
    if (!dia || duracao <= 0) return
    buscar(async () => {
      setLivres(
        await buscarHorariosLivres({
          diaIso: dia,
          profissionalId,
          duracaoMin: duracao,
          cadeiraId: cadeiraId ?? undefined,
          // Ignora o próprio agendamento: senão ele bloquearia o horário dele mesmo.
          ignorarAgendamentoId: id,
        }),
      )
    })
  }, [dia, duracao, profissionalId, cadeiraId, id])

  function confirmar(): void {
    setErro(null)
    salvar(async () => {
      const r = await reagendar(id, { dia, hora, duracaoMinutos: duracao })
      if (!r.ok) {
        setErro(r.mensagem ?? Object.values(r.erros)[0] ?? 'Não foi possível reagendar.')
        return
      }
      router.push(`/agenda?ref=${dia}`)
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <Card>
        <CardHeader
          titulo="Novo horário"
          descricao="Reagendar zera a confirmação: o paciente havia confirmado o horário antigo."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              id="dia"
              rotulo="Data"
              type="date"
              value={dia}
              onChange={(e) => setDia(e.currentTarget.value)}
            />
            <Input
              id="duracao"
              rotulo="Duração (min)"
              type="number"
              min={5}
              max={480}
              step={5}
              value={duracao}
              onChange={(e) => setDuracao(Number(e.currentTarget.value) || 0)}
            />
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-fg-2">Horário</span>
            {carregando ? (
              <p className="text-sm text-fg-3">Buscando…</p>
            ) : livres === null ? (
              <p className="text-sm text-fg-3">Escolha a data.</p>
            ) : livres.length === 0 ? (
              <Alerta tipo="atencao">Nenhum horário livre neste dia para essa duração.</Alerta>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {livres.map((h) => (
                  <Button key={h} tamanho="sm" ativo={hora === h} onClick={() => setHora(h)}>
                    {h}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="flex gap-2">
        <Button
          variante="primario"
          tamanho="lg"
          disabled={salvando || hora.length === 0}
          onClick={confirmar}
        >
          {salvando ? 'Reagendando…' : 'Confirmar novo horário'}
        </Button>
        <Button tamanho="lg" variante="fantasma" onClick={() => router.back()}>
          Voltar
        </Button>
      </div>
    </div>
  )
}
