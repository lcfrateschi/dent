'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { horariosDoDia, marcarMinhaConsulta } from '@/lib/portal/acoes'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

interface Opcao {
  readonly id: string
  readonly nome: string
}

/**
 * Escolher profissional, dia e horário.
 *
 * ── Três estados, e por que o "escolhido" existe ────────────────────────────
 * Escolher → ver horários → confirmar. O passo de confirmação existe porque marcar
 * consulta é irreversível pelo lado da clínica (o horário sai da grade na hora), e um
 * toque acidental na lista de horários custaria isso.
 *
 * ── O que a tela NÃO faz ───────────────────────────────────────────────────
 * Não valida a regra. Ela filtra a janela de datas no `min`/`max` do campo, o que é
 * conveniência — a decisão é do servidor, com os números do banco, porque quem manda
 * o POST escolhe o que manda.
 */
export function Marcar({
  procedimentos,
  profissionais,
  antecedenciaMinimaHoras,
  antecedenciaMaximaDias,
  termo,
}: {
  procedimentos: readonly (Opcao & { duracaoMinutos: number })[]
  profissionais: readonly Opcao[]
  antecedenciaMinimaHoras: number
  antecedenciaMaximaDias: number
  termo: string | null
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()

  const [procedimentoId, setProcedimentoId] = useState(procedimentos[0]?.id ?? '')
  const [profissionalId, setProfissionalId] = useState(profissionais[0]?.id ?? '')
  const [dia, setDia] = useState('')
  const [horarios, setHorarios] = useState<readonly { hora: string; inicioIso: string }[] | null>(
    null,
  )
  const [escolhido, setEscolhido] = useState<{ hora: string; inicioIso: string } | null>(null)
  const [aceitouTermo, setAceitouTermo] = useState(false)
  const [resultado, setResultado] = useState<{ ok: boolean; mensagem: string } | null>(null)

  // `min`/`max` do campo de data vêm da regra: a tela não oferece dia que o servidor
  // vai recusar. Oferecer e depois recusar parece defeito para quem escolheu.
  const agora = Date.now()
  const minDia = new Date(agora + antecedenciaMinimaHoras * 3_600_000).toISOString().slice(0, 10)
  const maxDia = new Date(agora + antecedenciaMaximaDias * 86_400_000).toISOString().slice(0, 10)

  if (resultado?.ok) {
    return (
      <Card>
        <CardBody>
          <p role="status" className="text-sm font-medium text-sucesso">
            <span aria-hidden>✓</span> {resultado.mensagem}
          </p>
          <Button className="mt-3" onClick={() => router.push('/meu')}>
            Ver minhas consultas
          </Button>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader titulo="Escolha o atendimento" />
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-fg-2">Tipo de atendimento</span>
            <select
              value={procedimentoId}
              onChange={(e) => {
                setProcedimentoId(e.target.value)
                setHorarios(null)
                setEscolhido(null)
              }}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-fg"
            >
              {procedimentos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome} ({p.duracaoMinutos} min)
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-fg-2">Com quem</span>
            <select
              value={profissionalId}
              onChange={(e) => {
                setProfissionalId(e.target.value)
                setHorarios(null)
                setEscolhido(null)
              }}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-fg"
            >
              {profissionais.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-fg-2">Dia</span>
          <input
            type="date"
            value={dia}
            min={minDia}
            max={maxDia}
            onChange={(e) => {
              setDia(e.target.value)
              setHorarios(null)
              setEscolhido(null)
            }}
            className="rounded-md border border-border bg-surface px-3 py-2 text-fg"
          />
        </label>

        <Button
          disabled={!dia || pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await horariosDoDia({ diaIso: dia, profissionalId, procedimentoId })
              if (!r.ok) {
                setResultado({ ok: false, mensagem: r.mensagem })
                return
              }
              setResultado(null)
              setHorarios(r.horarios)
            })
          }
        >
          {pendente ? 'Buscando…' : 'Ver horários'}
        </Button>

        {resultado && !resultado.ok && (
          <p role="alert" className="text-sm text-critico">
            <span aria-hidden>✕</span> {resultado.mensagem}
          </p>
        )}

        {horarios !== null && horarios.length === 0 && (
          <p className="text-sm text-fg-2">
            Nenhum horário livre neste dia. Tente outro, ou entre na lista de espera.
          </p>
        )}

        {horarios !== null && horarios.length > 0 && !escolhido && (
          <div>
            <p className="mb-2 text-sm text-fg-2">Horários livres:</p>
            <div className="flex flex-wrap gap-2">
              {horarios.map((h) => (
                <Button key={h.inicioIso} variante="secundario" onClick={() => setEscolhido(h)}>
                  {h.hora}
                </Button>
              ))}
            </div>
          </div>
        )}

        {escolhido && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-sm text-fg">
              Confirmar <strong>{escolhido.hora}</strong> em{' '}
              {new Date(`${dia}T00:00:00`).toLocaleDateString('pt-BR')}?
            </p>

            {termo && (
              <label className="flex gap-2 text-sm text-fg-2">
                <input
                  type="checkbox"
                  checked={aceitouTermo}
                  onChange={(e) => setAceitouTermo(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  Li e aceito o termo de atendimento.
                  <span className="mt-1 block max-h-32 overflow-y-auto rounded bg-surface-2 p-2 text-xs text-fg-3">
                    {termo}
                  </span>
                </span>
              </label>
            )}

            <div className="flex gap-2">
              <Button
                disabled={pendente || (termo !== null && !aceitouTermo)}
                onClick={() =>
                  iniciar(async () => {
                    const r = await marcarMinhaConsulta({
                      profissionalId,
                      procedimentoId,
                      inicioIso: escolhido.inicioIso,
                      aceitouTermo,
                    })
                    setResultado(r)
                    if (!r.ok) {
                      // Recarrega a grade: o motivo mais comum de recusa é o horário
                      // ter sido ocupado nos segundos entre escolher e confirmar.
                      setEscolhido(null)
                      setHorarios(null)
                    }
                    router.refresh()
                  })
                }
              >
                {pendente ? 'Marcando…' : 'Confirmar'}
              </Button>
              <Button variante="secundario" onClick={() => setEscolhido(null)}>
                Voltar
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
