'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import { Icone } from '@/components/ui/Icone'
import { formatarConvite } from '@/lib/auth/conviteTexto'
import { liberarAcessoAoPortal, revogarAcessoAoPortal } from '@/lib/pacientes/acessoPortal'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

export interface SituacaoAcesso {
  readonly email: string
  readonly ativo: boolean
  readonly senhaDefinida: boolean
  readonly temConvitePendente: boolean
  readonly conviteExpiraEmIso: string | null
  readonly ultimoLoginIso: string | null
  readonly bloqueadoAteIso: string | null
  readonly sessoesAbertas: number
}

/**
 * Acesso do paciente ao portal, na ficha.
 *
 * O convite aparece **uma vez só**, aqui, logo depois de ser gerado. Não há como
 * consultá-lo depois: o banco tem só o hash. Por isso a tela insiste em copiar
 * agora — e por isso gerar outro é fácil, que é a saída certa para "o paciente
 * perdeu o código".
 */
export function AcessoAoPortal({
  pacienteId,
  emailSugerido,
  situacao,
  podeEditar,
}: {
  pacienteId: string
  emailSugerido: string | null
  situacao: SituacaoAcesso | null
  podeEditar: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [email, setEmail] = useState(situacao?.email ?? emailSugerido ?? '')
  const [abrindo, setAbrindo] = useState(false)
  const [convite, setConvite] = useState<{ token: string; expiraEm: string } | null>(null)
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  function liberar(): void {
    setAviso(null)
    iniciar(async () => {
      const r = await liberarAcessoAoPortal(pacienteId, email)
      if (r.ok && r.convite) {
        setConvite({ token: r.convite, expiraEm: r.expiraEm ?? '' })
        setAbrindo(false)
      }
      setAviso({ ok: r.ok, mensagem: r.mensagem })
      router.refresh()
    })
  }

  return (
    <div className="space-y-2">
      {situacao ? (
        <div className="space-y-1 text-sm">
          <p className={situacao.ativo ? 'font-medium text-sucesso' : 'font-medium text-fg-3'}>
            <span aria-hidden>{situacao.ativo ? '✓' : '○'}</span>{' '}
            {situacao.ativo ? 'Acesso liberado' : 'Acesso revogado'}
          </p>
          <p className="text-xs text-fg-3">
            {situacao.email}
            {situacao.senhaDefinida ? ' · senha já definida' : ' · aguardando primeiro acesso'}
          </p>
          {situacao.ultimoLoginIso ? (
            <p className="text-xs text-fg-3">
              Último acesso: {new Date(situacao.ultimoLoginIso).toLocaleString('pt-BR')}
            </p>
          ) : null}
          {situacao.sessoesAbertas > 0 ? (
            <p className="text-xs text-fg-3">
              {situacao.sessoesAbertas} sessão(ões) aberta(s)
            </p>
          ) : null}
          {situacao.temConvitePendente && situacao.conviteExpiraEmIso ? (
            <p className="text-xs text-atencao">
              <span aria-hidden>⚠</span> Convite pendente, vale até{' '}
              {new Date(situacao.conviteExpiraEmIso).toLocaleDateString('pt-BR')}
            </p>
          ) : null}
          {situacao.bloqueadoAteIso &&
          new Date(situacao.bloqueadoAteIso).getTime() > Date.now() ? (
            <p className="text-xs text-critico">
              <span aria-hidden>⚠</span> Bloqueado por tentativas até{' '}
              {new Date(situacao.bloqueadoAteIso).toLocaleTimeString('pt-BR')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-fg-2">Este paciente ainda não tem acesso ao portal.</p>
      )}

      {/* O convite em claro: aparece uma vez, e a tela diz isso. */}
      {convite ? (
        <div className="space-y-2 rounded-(--radius-controle) border border-primary/40 bg-primary/5 p-3">
          <p className="text-xs font-medium text-fg">
            Entregue este código ao paciente. Ele <strong>não pode ser consultado depois</strong> —
            se perder, gere outro.
          </p>
          <p className="font-mono text-base font-semibold tracking-wide text-fg select-all">
            {formatarConvite(convite.token)}
          </p>
          <p className="text-xs text-fg-3">
            Vale até {new Date(convite.expiraEm).toLocaleDateString('pt-BR')} e só funciona uma vez.
            O paciente entra em <span className="font-mono">/meu/convite</span>.
          </p>
          <Button tamanho="sm" variante="fantasma" onClick={() => setConvite(null)}>
            Já anotei
          </Button>
        </div>
      ) : null}

      {aviso ? (
        <p className={aviso.ok ? 'text-xs text-sucesso' : 'text-xs text-critico'} role="status">
          <span aria-hidden>{aviso.ok ? '✓' : '✕'}</span> {aviso.mensagem}
        </p>
      ) : null}

      {!podeEditar ? null : abrindo ? (
        <div className="space-y-2">
          <label htmlFor="email-portal" className="block text-xs font-medium text-fg-2">
            E-mail de acesso
          </label>
          <input
            id="email-portal"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder="paciente@exemplo.com"
            className="h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-3"
          />
          <p className="text-xs text-fg-3">
            O sistema não envia e-mail: o endereço serve como login, e o código é entregue por você.
          </p>
          <div className="flex gap-2">
            <Button tamanho="sm" variante="primario" disabled={pendente} onClick={liberar}>
              {pendente ? 'Gerando…' : 'Gerar convite'}
            </Button>
            <Button tamanho="sm" variante="fantasma" onClick={() => setAbrindo(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button tamanho="sm" onClick={() => setAbrindo(true)}>
            <Icone nome="pacientes" tamanho={14} />
            {situacao ? 'Gerar novo convite' : 'Liberar acesso ao portal'}
          </Button>
          {situacao?.ativo ? (
            <Button
              tamanho="sm"
              variante="fantasma"
              disabled={pendente}
              onClick={() =>
                iniciar(async () => {
                  const r = await revogarAcessoAoPortal(pacienteId)
                  setAviso({ ok: r.ok, mensagem: r.mensagem })
                  router.refresh()
                })
              }
            >
              Revogar acesso
            </Button>
          ) : null}
        </div>
      )}

      {situacao?.ativo && situacao.sessoesAbertas > 0 ? (
        <Alerta tipo="atencao">
          Revogar o acesso encerra as {situacao.sessoesAbertas} sessão(ões) aberta(s) na hora.
        </Alerta>
      ) : null}
    </div>
  )
}
