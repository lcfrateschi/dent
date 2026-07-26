import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { Alerta } from '@/components/ui/Input'
import { usuarios } from '@/lib/admin/consultas'
import { ROTULO_PERFIL } from '@/lib/authz/politicas'
import { exigirPermissaoPagina } from '@/lib/authz/sessao'
import { cn } from '@/lib/ui/cn'
import { dataHoraBr } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import { NovoUsuario, UsuarioControles } from './Controles'

export const metadata: Metadata = { title: 'Usuários' }

/**
 * Usuários do staff.
 *
 * ── O que esta tela nunca mostra ────────────────────────────────────────────
 * O segredo do autenticador. A coluna diz **se** o MFA está configurado, não qual
 * é o segredo — quem o visse geraria códigos válidos em nome do outro, e o
 * segundo fator deixaria de ser segundo fator.
 *
 * ── Por que ninguém é apagado ───────────────────────────────────────────────
 * O usuário assina evolução, executa procedimento e aparece no `audit_log`.
 * Apagar quebraria a trilha exatamente onde a guarda de 20 anos a exige. O que
 * existe é **desativar**: o login recusa antes de conferir a senha, e o histórico
 * continua legível.
 */
export default async function Page() {
  const ator = await exigirPermissaoPagina('usuario', 'ler')
  const lista = await usuarios()

  const ativos = lista.filter((u) => u.ativo)
  const admins = ativos.filter((u) => u.perfil === 'admin')
  const semMfa = ativos.filter((u) => !u.mfaAtivo)
  const soAdminInicial = ativos.length === 1 && ativos[0]?.email === 'admin@local'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg">
            <Icone nome="usuarios" tamanho={18} />
            Usuários
          </h1>
          <p className="text-sm text-fg-3">Quem entra no sistema, com que perfil</p>
        </div>
        <NovoUsuario />
      </div>

      {soAdminInicial ? (
        <Alerta tipo="critico">
          <strong>Só existe o usuário inicial de desenvolvimento.</strong> O
          <code className="mx-1 font-mono">admin@local</code>
          nasceu com senha pública no seed — qualquer pessoa que conheça este projeto a sabe. Crie
          os usuários reais da clínica e desative-o.
        </Alerta>
      ) : null}

      {admins.length === 1 ? (
        <Alerta tipo="atencao">
          <strong>Há apenas um administrador ativo.</strong> Se ele perder o acesso, ninguém
          consegue cadastrar usuário nem reiniciar autenticador — a saída passaria a ser mexer no
          banco. Cadastre um segundo.
        </Alerta>
      ) : null}

      {semMfa.length > 0 ? (
        <Alerta tipo="atencao">
          {semMfa.length} usuário(s) ativo(s) ainda sem verificação em duas etapas. Eles ficam
          presos na tela de configuração até concluir — não circulam pelo sistema sem segundo
          fator.
        </Alerta>
      ) : null}

      <Card>
        <CardHeader
          titulo={`${ativos.length} ativo(s), ${lista.length - ativos.length} inativo(s)`}
          descricao="Perfil define o que a pessoa vê: recepção não lê evolução clínica, financeiro não lê dado clínico, dentista não altera cobrança."
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-3">
                  <th className="px-4 py-2 font-medium">Nome</th>
                  <th className="px-4 py-2 font-medium">E-mail</th>
                  <th className="px-4 py-2 font-medium">Perfil</th>
                  <th className="px-4 py-2 font-medium">CRO</th>
                  <th className="px-4 py-2 font-medium">Comissão</th>
                  <th className="px-4 py-2 font-medium">2 etapas</th>
                  <th className="px-4 py-2 font-medium">Último acesso</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {lista.map((u) => (
                  <tr
                    key={u.id}
                    className={cn('border-b border-border/60 last:border-0', !u.ativo && 'text-fg-3')}
                  >
                    <td className="px-4 py-2">
                      <span className={cn('font-medium', u.ativo ? 'text-fg' : 'text-fg-3')}>
                        {u.nome}
                      </span>
                      {u.id === ator.usuarioId ? (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-fg-2">
                          você
                        </span>
                      ) : null}
                      {!u.ativo ? (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px]">
                          inativo
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-fg-2">{u.email}</td>
                    <td className="px-4 py-2">{ROTULO_PERFIL[u.perfil]}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {u.cro ? `${u.cro}/${u.ufCro}` : '—'}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {u.comissaoPct ? `${Number(u.comissaoPct).toFixed(0)}%` : '—'}
                    </td>
                    <td className="px-4 py-2">
                      {u.mfaAtivo ? (
                        <span className="text-xs text-sucesso">configurada</span>
                      ) : (
                        <span className="text-xs text-atencao">pendente</span>
                      )}
                      {u.senhaTemporaria ? (
                        <span className="block text-xs text-atencao">senha temporária</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-xs text-fg-3">
                      {u.ultimoLoginEm ? dataHoraBr(u.ultimoLoginEm) : 'nunca entrou'}
                    </td>
                    <td className="px-4 py-2">
                      <UsuarioControles
                        usuario={{
                          id: u.id,
                          nome: u.nome,
                          email: u.email,
                          perfil: u.perfil,
                          ativo: u.ativo,
                          cro: u.cro,
                          ufCro: u.ufCro,
                          comissaoPct: u.comissaoPct,
                          especialidade: u.especialidade,
                        }}
                        souEu={u.id === ator.usuarioId}
                        unicoAdminAtivo={u.perfil === 'admin' && admins.length === 1}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <p className="text-xs text-fg-3">
        Ninguém é apagado: o usuário assina evolução e aparece na trilha de auditoria, que tem
        guarda de 20 anos. Desativar impede o login e preserva o histórico.
      </p>
    </div>
  )
}
