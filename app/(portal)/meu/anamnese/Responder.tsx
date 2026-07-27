'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Alerta } from '@/components/ui/Input'
import type { Pergunta, Respostas, VersaoFormulario } from '@/lib/anamnese/formulario'
import { responderMinhaAnamnese } from '@/lib/portal/acoes'
import { useState, useTransition } from 'react'

/**
 * O formulário da ficha de saúde, no celular.
 *
 * ── Uma seção por vez, e por quê ───────────────────────────────────────────
 * A versão do staff mostra todas as seções numa coluna, com um painel lateral de
 * alertas — funciona numa tela larga, para quem preenche isto toda semana. No celular
 * a mesma lista vira uma rolagem de trinta perguntas sem fim visível, e quem entra
 * três vezes por ano abandona no meio.
 *
 * Uma seção por passo dá duas coisas de graça: o fim fica visível ("2 de 4") e a
 * pessoa não perde o lugar ao ser interrompida — o que, num celular, é o caso normal.
 *
 * ── Não há alerta clínico aqui ──────────────────────────────────────────────
 * Deliberado, e o porquê está no comentário da `page.tsx`: `derivarAlertas` devolve
 * severidade clínica, e mostrar "crítico" em vermelho a quem está respondendo muda a
 * resposta seguinte. O paciente declara; a clínica interpreta.
 *
 * ── Sim/Não em dois botões grandes, não em `radio` ─────────────────────────
 * Alvo de toque. O `radio` nativo é pequeno demais para o dedo e o rótulo clicável
 * não resolve, porque a linha inteira vira alvo e o toque errado responde a pergunta
 * errada.
 */
export function Responder({
  formulario,
  respostasIniciais,
}: {
  formulario: VersaoFormulario
  respostasIniciais: Respostas
}) {
  const [respostas, setRespostas] = useState<Respostas>(respostasIniciais)
  const [passo, setPasso] = useState(0)
  const [erro, setErro] = useState<string | null>(null)
  const [enviado, setEnviado] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  const total = formulario.secoes.length
  const secao = formulario.secoes[passo]
  const ultima = passo === total - 1

  function responder(id: string, valor: Respostas[string]): void {
    setRespostas((r) => ({ ...r, [id]: valor }))
  }

  function visivel(p: Pergunta): boolean {
    if (!p.dependeDe) return true
    const dep = respostas[p.dependeDe]
    if (!dep) return false
    if (dep.tipo === 'sim_nao' || dep.tipo === 'sim_nao_detalhe') return dep.valor === true
    if (dep.tipo === 'escolha') return dep.valor !== null && dep.valor !== 'Não'
    return false
  }

  function enviar(): void {
    setErro(null)
    iniciar(async () => {
      const r = await responderMinhaAnamnese({
        respostas: respostas as Record<string, unknown>,
        versaoFormulario: formulario.versao,
      })
      if (!r.ok) {
        setErro(r.mensagem)
        return
      }
      setEnviado(r.mensagem)
    })
  }

  if (enviado) {
    return (
      <Card>
        <CardBody>
          <Alerta tipo="sucesso">{enviado}</Alerta>
          <p className="mt-3 text-sm text-fg-2">
            Não precisa fazer mais nada. Se quiser corrigir algo, é só responder de novo — a versão
            anterior fica guardada.
          </p>
        </CardBody>
      </Card>
    )
  }

  if (!secao) return null

  return (
    <div className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      <Card>
        <CardHeader
          titulo={secao.titulo}
          descricao={secao.descricao ?? `Parte ${passo + 1} de ${total}`}
        />
        <CardBody className="space-y-4">
          {/* Progresso em texto, não só em barra: "2 de 4" diz quanto falta; uma
              barra pela metade não. */}
          <p className="text-xs text-fg-3">
            Parte {passo + 1} de {total}
          </p>

          {secao.perguntas.filter(visivel).map((p) => (
            <CampoDoPaciente
              key={p.id}
              pergunta={p}
              resposta={respostas[p.id]}
              onResponder={(v) => responder(p.id, v)}
            />
          ))}
        </CardBody>
      </Card>

      <div className="flex flex-wrap gap-2">
        {passo > 0 ? (
          <Button
            tamanho="lg"
            variante="fantasma"
            disabled={pendente}
            onClick={() => setPasso((n) => n - 1)}
          >
            Voltar
          </Button>
        ) : null}

        {ultima ? (
          <Button variante="primario" tamanho="lg" disabled={pendente} onClick={enviar}>
            {pendente ? 'Enviando…' : 'Enviar minhas respostas'}
          </Button>
        ) : (
          <Button
            variante="primario"
            tamanho="lg"
            disabled={pendente}
            onClick={() => setPasso((n) => n + 1)}
          >
            Continuar
          </Button>
        )}
      </div>

      <p className="text-xs text-fg-3">
        Você pode deixar perguntas em branco. Nada aqui é enviado até você tocar em “Enviar”.
      </p>
    </div>
  )
}

/**
 * Um campo, com alvo de toque de celular.
 *
 * A pergunta vem ACIMA dos botões, não ao lado como no staff: em tela estreita o
 * texto e os controles na mesma linha empurram o "Sim/Não" para fora, ou quebram de
 * um jeito que faz o botão parecer pertencer à pergunta seguinte.
 */
function CampoDoPaciente({
  pergunta,
  resposta,
  onResponder,
}: {
  pergunta: Pergunta
  resposta: Respostas[string] | undefined
  onResponder: (v: Respostas[string]) => void
}) {
  const { id, texto, tipo } = pergunta

  if (tipo === 'sim_nao' || tipo === 'sim_nao_detalhe') {
    const valor =
      resposta && (resposta.tipo === 'sim_nao' || resposta.tipo === 'sim_nao_detalhe')
        ? resposta.valor
        : null
    const detalhe = resposta?.tipo === 'sim_nao_detalhe' ? resposta.detalhe : null

    return (
      <div className="border-b border-border pb-4 last:border-0 last:pb-0">
        <p className="text-sm text-fg">{texto}</p>
        {pergunta.ajuda ? <p className="mt-0.5 text-xs text-fg-3">{pergunta.ajuda}</p> : null}

        <div className="mt-2 flex gap-2">
          {[
            { rotulo: 'Sim', v: true },
            { rotulo: 'Não', v: false },
          ].map((o) => (
            <Button
              key={o.rotulo}
              tamanho="lg"
              className="min-w-24"
              ativo={valor === o.v}
              onClick={() =>
                onResponder(
                  tipo === 'sim_nao'
                    ? { tipo: 'sim_nao', valor: o.v }
                    : { tipo: 'sim_nao_detalhe', valor: o.v, detalhe: o.v ? detalhe : null },
                )
              }
            >
              {o.rotulo}
            </Button>
          ))}
        </div>

        {tipo === 'sim_nao_detalhe' && valor === true ? (
          <input
            aria-label={pergunta.rotuloDetalhe ?? 'Detalhe'}
            placeholder={pergunta.rotuloDetalhe ?? 'Qual?'}
            value={detalhe ?? ''}
            onChange={(e) =>
              onResponder({ tipo: 'sim_nao_detalhe', valor: true, detalhe: e.currentTarget.value })
            }
            className="mt-2 h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-base text-fg"
          />
        ) : null}
      </div>
    )
  }

  if (tipo === 'escolha') {
    const valor = resposta?.tipo === 'escolha' ? resposta.valor : null
    return (
      <div className="border-b border-border pb-4 last:border-0 last:pb-0">
        <label htmlFor={id} className="block text-sm text-fg">
          {texto}
        </label>
        <select
          id={id}
          value={valor ?? ''}
          onChange={(e) => onResponder({ tipo: 'escolha', valor: e.currentTarget.value || null })}
          className="mt-2 h-11 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-base text-fg"
        >
          <option value="">— não sei / prefiro não responder —</option>
          {pergunta.opcoes?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {pergunta.ajuda ? <p className="mt-1 text-xs text-fg-3">{pergunta.ajuda}</p> : null}
      </div>
    )
  }

  if (tipo === 'numero') {
    const valor = resposta?.tipo === 'numero' ? resposta.valor : null
    return (
      <div className="border-b border-border pb-4 last:border-0 last:pb-0">
        <label htmlFor={id} className="block text-sm text-fg">
          {texto}
        </label>
        <input
          id={id}
          type="number"
          min={0}
          // `inputMode` numérico: no celular abre o teclado de números em vez do
          // alfabético, que é a diferença entre responder e desistir.
          inputMode="numeric"
          value={valor ?? ''}
          onChange={(e) =>
            onResponder({
              tipo: 'numero',
              valor: e.currentTarget.value === '' ? null : Number(e.currentTarget.value),
            })
          }
          className="mt-2 h-11 w-32 rounded-(--radius-controle) border border-border bg-surface px-3 text-base text-fg"
        />
      </div>
    )
  }

  const valor = resposta?.tipo === 'texto' ? resposta.valor : null
  return (
    <div className="border-b border-border pb-4 last:border-0 last:pb-0">
      <label htmlFor={id} className="block text-sm text-fg">
        {texto}
      </label>
      <textarea
        id={id}
        value={valor ?? ''}
        onChange={(e) => onResponder({ tipo: 'texto', valor: e.currentTarget.value || null })}
        className="mt-2 min-h-24 w-full rounded-(--radius-controle) border border-border bg-surface px-3 py-2 text-base text-fg"
      />
    </div>
  )
}
