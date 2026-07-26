'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { alternarCarteirinha, salvarCarteirinha } from '@/lib/convenios/acoes'
import { dataBr } from '@/lib/ui/moeda'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const campo =
  'h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg placeholder:text-fg-3'

export interface CarteirinhaProps {
  id: string
  convenioId: string
  convenioNome: string
  numeroCarteirinha: string
  plano: string | null
  ehTitular: boolean
  nomeTitular: string | null
  adesaoEm: string | null
  validade: string | null
  ativo: boolean
}

/**
 * Carteirinhas de convênio do paciente.
 *
 * ── Por que a data de adesão não é opcional na prática ──────────────────────
 * É dela que sai a contagem de **carência**. Sem ela, a avaliação de
 * elegibilidade não sabe dizer se o procedimento está coberto, e o resultado
 * aparece semanas depois como glosa por carência — com o atendimento já feito.
 * O campo aceita vazio (a recepção às vezes não tem o dado na hora), e a tela
 * avisa o que isso custa.
 *
 * ── Uma ativa por operadora ─────────────────────────────────────────────────
 * O banco recusa duas ativas do mesmo paciente na mesma operadora: seria
 * indefinido qual número vai na guia. Troca de plano é inativar e cadastrar.
 */
export function Carteirinhas({
  pacienteId,
  carteirinhas,
  convenios,
  podeEditar,
}: {
  pacienteId: string
  carteirinhas: readonly CarteirinhaProps[]
  convenios: readonly { id: string; nome: string }[]
  podeEditar: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [aberto, setAberto] = useState(false)
  const [convenioId, setConvenioId] = useState(convenios[0]?.id ?? '')
  const [numero, setNumero] = useState('')
  const [plano, setPlano] = useState('')
  const [ehTitular, setEhTitular] = useState(true)
  const [nomeTitular, setNomeTitular] = useState('')
  const [adesao, setAdesao] = useState('')
  const [validade, setValidade] = useState('')
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  const ativas = carteirinhas.filter((c) => c.ativo)
  const semAdesao = ativas.filter((c) => !c.adesaoEm)

  return (
    <div className="space-y-3">
      {aviso ? <Alerta tipo={aviso.ok ? 'sucesso' : 'critico'}>{aviso.mensagem}</Alerta> : null}

      {carteirinhas.length === 0 ? (
        <p className="text-sm text-fg-2">
          Nenhum convênio. O atendimento é particular — o que é o caminho normal para a maioria dos
          pacientes.
        </p>
      ) : (
        <ul className="space-y-2">
          {carteirinhas.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-(--radius-controle) border border-border px-3 py-2"
            >
              <div className="text-sm">
                <p className={c.ativo ? 'font-medium text-fg' : 'text-fg-3'}>
                  {c.convenioNome}
                  {!c.ativo ? <span className="ml-2 text-xs">(inativa)</span> : null}
                </p>
                <p className="font-mono text-xs text-fg-2">{c.numeroCarteirinha}</p>
                <p className="text-xs text-fg-3">
                  {c.plano ? `${c.plano} · ` : null}
                  {c.ehTitular ? 'titular' : `dependente de ${c.nomeTitular}`}
                  {c.adesaoEm ? ` · adesão ${dataBr(c.adesaoEm)}` : ' · sem data de adesão'}
                  {c.validade ? ` · válida até ${dataBr(c.validade)}` : null}
                </p>
              </div>
              {podeEditar ? (
                <Button
                  tamanho="sm"
                  variante="fantasma"
                  disabled={pendente}
                  onClick={() =>
                    iniciar(async () => {
                      const r = await alternarCarteirinha(c.id, !c.ativo, pacienteId)
                      setAviso(r)
                      router.refresh()
                    })
                  }
                >
                  {c.ativo ? 'Inativar' : 'Reativar'}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {semAdesao.length > 0 ? (
        <p className="text-xs text-atencao">
          <span aria-hidden>⚠</span> {semAdesao.length} carteirinha(s) ativa(s) sem data de adesão.
          A carência é contada dela — sem o dado, a elegibilidade não é avaliada e o risco de glosa
          por carência fica escondido até o retorno da operadora.
        </p>
      ) : null}

      {!podeEditar ? null : convenios.length === 0 ? (
        <p className="text-xs text-fg-3">
          Nenhuma operadora cadastrada ainda. Cadastre em Convênios → Operadoras antes de vincular a
          carteirinha.
        </p>
      ) : !aberto ? (
        <Button onClick={() => setAberto(true)}>Adicionar convênio</Button>
      ) : (
        <form
          className="space-y-3 rounded-(--radius-controle) border border-border bg-surface-2 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            iniciar(async () => {
              const r = await salvarCarteirinha({
                pacienteId,
                convenioId,
                numeroCarteirinha: numero,
                plano: plano || undefined,
                ehTitular,
                nomeTitular: ehTitular ? undefined : nomeTitular,
                adesaoEm: adesao || undefined,
                validade: validade || undefined,
              })
              setAviso(r)
              if (r.ok) {
                setAberto(false)
                setNumero('')
                router.refresh()
              }
            })
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="ct-conv" className="block text-xs font-medium text-fg-2">
                Operadora
              </label>
              <select
                id="ct-conv"
                value={convenioId}
                onChange={(e) => setConvenioId(e.currentTarget.value)}
                className={`${campo} mt-1`}
              >
                {convenios.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ct-num" className="block text-xs font-medium text-fg-2">
                Número da carteirinha
              </label>
              <input
                id="ct-num"
                value={numero}
                onChange={(e) => setNumero(e.currentTarget.value)}
                className={`${campo} mt-1`}
                required
              />
            </div>
            <div>
              <label htmlFor="ct-plano" className="block text-xs font-medium text-fg-2">
                Plano (opcional)
              </label>
              <input
                id="ct-plano"
                value={plano}
                onChange={(e) => setPlano(e.currentTarget.value)}
                className={`${campo} mt-1`}
              />
            </div>
            <div>
              <label htmlFor="ct-adesao" className="block text-xs font-medium text-fg-2">
                Data de adesão
              </label>
              <input
                id="ct-adesao"
                type="date"
                value={adesao}
                onChange={(e) => setAdesao(e.currentTarget.value)}
                className={`${campo} mt-1`}
              />
              <p className="mt-1 text-xs text-fg-3">É a base da contagem de carência.</p>
            </div>
            <div>
              <label htmlFor="ct-val" className="block text-xs font-medium text-fg-2">
                Validade da carteirinha (opcional)
              </label>
              <input
                id="ct-val"
                type="date"
                value={validade}
                onChange={(e) => setValidade(e.currentTarget.value)}
                className={`${campo} mt-1`}
              />
            </div>
            <div>
              <span className="block text-xs font-medium text-fg-2">Vínculo</span>
              <label className="mt-2 flex items-center gap-2 text-sm text-fg-2">
                <input
                  type="checkbox"
                  checked={ehTitular}
                  onChange={(e) => setEhTitular(e.currentTarget.checked)}
                />
                É o titular do plano
              </label>
              {!ehTitular ? (
                <input
                  value={nomeTitular}
                  onChange={(e) => setNomeTitular(e.currentTarget.value)}
                  placeholder="Nome do titular"
                  aria-label="Nome do titular"
                  className={`${campo} mt-2`}
                  required
                />
              ) : null}
            </div>
          </div>

          <div className="flex gap-2">
            <Button type="submit" variante="primario" disabled={pendente}>
              {pendente ? 'Salvando…' : 'Salvar carteirinha'}
            </Button>
            <Button type="button" variante="fantasma" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
