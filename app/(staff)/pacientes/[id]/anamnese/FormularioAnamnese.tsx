'use client'

import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import { confirmarAlertas, salvarAnamnese } from '@/lib/anamnese/acoes'
import type { AlertaDerivado } from '@/lib/anamnese/alertas'
import { derivarAlertas } from '@/lib/anamnese/alertas'
import type { Pergunta, Respostas, VersaoFormulario } from '@/lib/anamnese/formulario'
import { cn } from '@/lib/ui/cn'
import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'

/**
 * Preenchimento da anamnese.
 *
 * ── Os alertas aparecem ENQUANTO se responde ────────────────────────────────
 * `derivarAlertas` é puro e roda no cliente a cada resposta. Isso não é enfeite:
 * quem preenche vê na hora que marcar "usa anticoagulante" gerou um alerta
 * crítico, e entende por que a pergunta existe. Mostrar só no fim transformaria
 * o questionário em burocracia.
 *
 * ── Salvar e confirmar são passos separados ─────────────────────────────────
 * A anamnese é gravada primeiro; os alertas só depois, e só os que o dentista
 * confirmar. Derivação é sugestão — gravar automático no prontuário é o que faz
 * a equipe aprender a ignorar a faixa vermelha.
 */
export function FormularioAnamnese({
  pacienteId,
  pacienteNome,
  formulario,
  respostasIniciais,
  versaoAnterior,
}: {
  pacienteId: string
  pacienteNome: string
  formulario: VersaoFormulario
  respostasIniciais: Respostas
  versaoAnterior: number | null
}) {
  const router = useRouter()
  const [respostas, setRespostas] = useState<Respostas>(respostasIniciais)
  const [etapa, setEtapa] = useState<'preencher' | 'revisar'>('preencher')
  const [anamneseId, setAnamneseId] = useState<string | null>(null)
  const [aceitos, setAceitos] = useState<Set<string>>(new Set())
  const [erro, setErro] = useState<string | null>(null)
  const [pendente, iniciar] = useTransition()

  // Roda a cada tecla: as regras são puras e baratas.
  const alertas = useMemo(() => derivarAlertas(respostas), [respostas])

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

  function salvar(): void {
    setErro(null)
    iniciar(async () => {
      const r = await salvarAnamnese({ pacienteId, respostas })
      if (!r.ok) {
        setErro(r.mensagem)
        return
      }
      setAnamneseId(r.anamneseId)
      // Todos vêm pré-marcados: o padrão seguro é registrar, e desmarcar é
      // uma decisão consciente do dentista.
      setAceitos(new Set(r.alertas.map((a) => a.regra)))
      setEtapa('revisar')
    })
  }

  function confirmar(): void {
    if (!anamneseId) return
    setErro(null)
    iniciar(async () => {
      const r = await confirmarAlertas({
        pacienteId,
        anamneseId,
        alertas: alertas.filter((a) => aceitos.has(a.regra)),
      })
      if (!r.ok) {
        setErro(r.mensagem ?? 'Não foi possível gravar os alertas.')
        return
      }
      router.push(`/pacientes/${pacienteId}`)
      router.refresh()
    })
  }

  if (etapa === 'revisar') {
    return (
      <div className="space-y-4">
        {erro ? <Alerta>{erro}</Alerta> : null}

        <Alerta tipo="sucesso">
          Anamnese versão {(versaoAnterior ?? 0) + 1} gravada. Agora confirme quais alertas devem
          aparecer no topo de toda tela deste paciente.
        </Alerta>

        <Card>
          <CardHeader
            titulo="Alertas sugeridos"
            descricao="Desmarque o que não se aplica. Só o que ficar marcado vai para o prontuário."
          />
          <CardBody>
            {alertas.length === 0 ? (
              <p className="text-sm text-fg-3">
                Nenhum alerta derivado das respostas. Nada será gravado.
              </p>
            ) : (
              <ul className="space-y-2">
                {alertas.map((a) => (
                  <li key={a.regra}>
                    <label
                      className={cn(
                        'flex cursor-pointer items-start gap-2.5 rounded-(--radius-controle) border p-2.5',
                        a.severidade === 'critico'
                          ? 'border-critico/45 bg-critico/8'
                          : a.severidade === 'atencao'
                            ? 'border-atencao/45 bg-atencao/8'
                            : 'border-border bg-surface-2',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={aceitos.has(a.regra)}
                        onChange={(e) => {
                          setAceitos((s) => {
                            const proximo = new Set(s)
                            if (e.currentTarget.checked) proximo.add(a.regra)
                            else proximo.delete(a.regra)
                            return proximo
                          })
                        }}
                        className="mt-0.5 size-4"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-semibold">
                          {a.severidade === 'critico' ? <Icone nome="alerta" tamanho={14} /> : null}
                          <span
                            className={
                              a.severidade === 'critico'
                                ? 'text-critico'
                                : a.severidade === 'atencao'
                                  ? 'text-atencao'
                                  : 'text-fg-2'
                            }
                          >
                            {a.tipo}
                          </span>
                          <span className="text-xs font-normal text-fg-3">({a.severidade})</span>
                        </span>
                        <span className="block text-sm text-fg-2">{a.descricao}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="flex gap-2">
          <Button variante="primario" tamanho="lg" disabled={pendente} onClick={confirmar}>
            {pendente ? 'Gravando…' : `Confirmar ${aceitos.size} alerta(s)`}
          </Button>
          <Button
            tamanho="lg"
            variante="fantasma"
            disabled={pendente}
            onClick={() => setEtapa('preencher')}
          >
            Voltar às respostas
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {erro ? <Alerta>{erro}</Alerta> : null}

      {versaoAnterior ? (
        <Alerta tipo="atencao">
          Este paciente já tem anamnese na versão {versaoAnterior}. Salvar cria a versão{' '}
          {versaoAnterior + 1} — a anterior continua no prontuário, não é sobrescrita.
        </Alerta>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          {formulario.secoes.map((secao) => (
            <Card key={secao.id}>
              <CardHeader titulo={secao.titulo} descricao={secao.descricao} />
              <CardBody className="space-y-3">
                {secao.perguntas.filter(visivel).map((p) => (
                  <CampoPergunta
                    key={p.id}
                    pergunta={p}
                    resposta={respostas[p.id]}
                    onResponder={(v) => responder(p.id, v)}
                  />
                ))}
              </CardBody>
            </Card>
          ))}
        </div>

        {/* Painel fixo: o efeito das respostas fica visível durante o preenchimento. */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardHeader
              titulo="Alertas que serão sugeridos"
              descricao={`${alertas.length} no momento`}
            />
            <CardBody>
              {alertas.length === 0 ? (
                <p className="text-sm text-fg-3">
                  Nenhum até agora. As respostas que mudam conduta aparecem aqui na hora.
                </p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {alertas.map((a) => (
                    <li key={a.regra} className="flex items-baseline gap-1.5">
                      <span
                        aria-hidden
                        className={cn(
                          'mt-1.5 inline-block size-2 shrink-0 rounded-full',
                          a.severidade === 'critico'
                            ? 'bg-critico'
                            : a.severidade === 'atencao'
                              ? 'bg-atencao'
                              : 'bg-fg-3',
                        )}
                      />
                      <span>
                        <strong
                          className={
                            a.severidade === 'critico'
                              ? 'text-critico'
                              : a.severidade === 'atencao'
                                ? 'text-atencao'
                                : 'text-fg-2'
                          }
                        >
                          {a.tipo}
                        </strong>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <div className="mt-3">
            <Button
              variante="primario"
              tamanho="lg"
              className="w-full"
              disabled={pendente}
              onClick={salvar}
            >
              {pendente ? 'Salvando…' : 'Salvar e revisar alertas'}
            </Button>
            <p className="mt-2 text-xs text-fg-3">
              Paciente: {pacienteNome}. Formulário versão {formulario.versao}.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

function CampoPergunta({
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
      <div className="border-b border-border pb-3 last:border-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-fg">{texto}</span>
          <div className="flex gap-1">
            {[
              { rotulo: 'Sim', v: true },
              { rotulo: 'Não', v: false },
            ].map((o) => (
              <Button
                key={o.rotulo}
                tamanho="sm"
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
        </div>

        {pergunta.ajuda ? <p className="mt-1 text-xs text-fg-3">{pergunta.ajuda}</p> : null}

        {/* O detalhe aparece só no "sim" — é o que dá utilidade clínica ao alerta. */}
        {tipo === 'sim_nao_detalhe' && valor === true ? (
          <input
            aria-label={pergunta.rotuloDetalhe ?? 'Detalhe'}
            placeholder={pergunta.rotuloDetalhe ?? 'Qual?'}
            value={detalhe ?? ''}
            onChange={(e) =>
              onResponder({ tipo: 'sim_nao_detalhe', valor: true, detalhe: e.currentTarget.value })
            }
            className="mt-2 h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg"
          />
        ) : null}
      </div>
    )
  }

  if (tipo === 'escolha') {
    const valor = resposta?.tipo === 'escolha' ? resposta.valor : null
    return (
      <div className="border-b border-border pb-3 last:border-0 last:pb-0">
        <label htmlFor={id} className="mb-1 block text-sm text-fg">
          {texto}
        </label>
        <select
          id={id}
          value={valor ?? ''}
          onChange={(e) => onResponder({ tipo: 'escolha', valor: e.currentTarget.value || null })}
          className="h-9 rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg"
        >
          <option value="">— não informado —</option>
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
      <div className="border-b border-border pb-3 last:border-0 last:pb-0">
        <label htmlFor={id} className="mb-1 block text-sm text-fg">
          {texto}
        </label>
        <input
          id={id}
          type="number"
          min={0}
          value={valor ?? ''}
          onChange={(e) =>
            onResponder({
              tipo: 'numero',
              valor: e.currentTarget.value === '' ? null : Number(e.currentTarget.value),
            })
          }
          className="h-9 w-28 rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg"
        />
      </div>
    )
  }

  const valor = resposta?.tipo === 'texto' ? resposta.valor : null
  return (
    <div className="border-b border-border pb-3 last:border-0 last:pb-0">
      <label htmlFor={id} className="mb-1 block text-sm text-fg">
        {texto}
      </label>
      <textarea
        id={id}
        value={valor ?? ''}
        onChange={(e) => onResponder({ tipo: 'texto', valor: e.currentTarget.value || null })}
        className="min-h-20 w-full rounded-(--radius-controle) border border-border bg-surface px-3 py-2 text-sm text-fg"
      />
    </div>
  )
}
