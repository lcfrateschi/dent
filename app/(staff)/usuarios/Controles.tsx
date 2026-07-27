'use client'

import { Button } from '@/components/ui/Button'
import { Alerta } from '@/components/ui/Input'
import {
  criarUsuario,
  desativarUsuario,
  reativarUsuario,
  resetarMfa,
  resetarSenha,
  salvarUsuario,
} from '@/lib/admin/acoes'
import { ROTULO_PERFIL, type Perfil } from '@/lib/authz/politicas'
import { exigeProfissional } from '@/lib/domain/administracao'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

const campo =
  'h-9 w-full rounded-(--radius-controle) border border-border bg-surface px-2 text-sm text-fg placeholder:text-fg-3'

const PERFIS: readonly Perfil[] = ['dentista', 'recepcao', 'financeiro', 'admin']

interface UsuarioEditavel {
  id: string
  nome: string
  email: string
  perfil: Perfil
  ativo: boolean
  cro: string | null
  ufCro: string | null
  cbos: string | null
  comissaoPct: string | null
  especialidade: string | null
}

/**
 * Caixa que mostra a senha temporária.
 *
 * Aparece **uma vez** e não é recuperável — a mesma disciplina do convite do
 * portal. O banco guarda o hash; nem o admin que acabou de criar o usuário
 * consegue vê-la de novo. Se a pessoa perder, gera-se outra, e isso fica na
 * trilha de auditoria.
 */
function SenhaTemporaria({ senha, nome }: { senha: string; nome: string }) {
  const [copiado, setCopiado] = useState(false)
  return (
    <div className="space-y-2 rounded-(--radius-controle) border border-atencao/40 bg-atencao/10 p-3">
      <p className="text-sm font-medium text-fg">Senha de primeiro acesso de {nome}</p>
      <p className="font-mono text-lg tracking-wide text-fg">{senha}</p>
      <p className="text-xs text-fg-2">
        Entregue pessoalmente ou dite por telefone. <strong>Ela aparece uma vez só</strong> — o
        banco guarda apenas o hash. A pessoa será obrigada a trocá-la no primeiro acesso, e a
        configurar o autenticador antes de circular pelo sistema.
      </p>
      <Button
        tamanho="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(senha).then(() => setCopiado(true))
        }}
      >
        {copiado ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
  )
}

function Formulario({
  inicial,
  aoConcluir,
  aoCancelar,
}: {
  inicial?: UsuarioEditavel
  aoConcluir: (senha?: string, nome?: string) => void
  aoCancelar: () => void
}) {
  const [pendente, iniciar] = useTransition()
  const [nome, setNome] = useState(inicial?.nome ?? '')
  const [email, setEmail] = useState(inicial?.email ?? '')
  const [perfil, setPerfil] = useState<Perfil>(inicial?.perfil ?? 'recepcao')
  const [cro, setCro] = useState(inicial?.cro ?? '')
  const [ufCro, setUfCro] = useState(inicial?.ufCro ?? 'SP')
  const [cbos, setCbos] = useState(inicial?.cbos ?? '')
  const [comissao, setComissao] = useState(inicial?.comissaoPct ?? '0')
  const [especialidade, setEspecialidade] = useState(inicial?.especialidade ?? '')
  const [erro, setErro] = useState<string | null>(null)

  const precisaCro = exigeProfissional(perfil)

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        setErro(null)
        iniciar(async () => {
          const dados = {
            nome,
            email,
            perfil,
            cro: precisaCro ? cro : undefined,
            ufCro: precisaCro ? ufCro : undefined,
            cbos: precisaCro ? cbos : undefined,
            comissaoPct: precisaCro ? comissao : undefined,
            especialidade: precisaCro ? especialidade : undefined,
          }
          const r = inicial ? await salvarUsuario(inicial.id, dados) : await criarUsuario(dados)
          if (!r.ok) {
            setErro(r.mensagem)
            return
          }
          aoConcluir(r.senhaTemporaria, nome)
        })
      }}
    >
      {erro ? <Alerta tipo="critico">{erro}</Alerta> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="u-nome" className="block text-xs font-medium text-fg-2">
            Nome completo
          </label>
          <input
            id="u-nome"
            value={nome}
            onChange={(e) => setNome(e.currentTarget.value)}
            className={`${campo} mt-1`}
            required
          />
        </div>
        <div>
          <label htmlFor="u-email" className="block text-xs font-medium text-fg-2">
            E-mail (é o login)
          </label>
          <input
            id="u-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            className={`${campo} mt-1`}
            required
            disabled={!!inicial}
          />
          {inicial ? (
            <p className="mt-1 text-xs text-fg-3">
              O e-mail identifica a pessoa na trilha de auditoria e não muda. Para outra pessoa,
              cadastre outro usuário.
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="u-perfil" className="block text-xs font-medium text-fg-2">
            Perfil
          </label>
          <select
            id="u-perfil"
            value={perfil}
            onChange={(e) => setPerfil(e.currentTarget.value as Perfil)}
            className={`${campo} mt-1`}
          >
            {PERFIS.map((p) => (
              <option key={p} value={p}>
                {ROTULO_PERFIL[p]}
              </option>
            ))}
          </select>
        </div>

        {precisaCro ? (
          <>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="u-cro" className="block text-xs font-medium text-fg-2">
                  CRO
                </label>
                <input
                  id="u-cro"
                  value={cro}
                  onChange={(e) => setCro(e.currentTarget.value)}
                  className={`${campo} mt-1`}
                  required
                />
              </div>
              <div className="w-20">
                <label htmlFor="u-uf" className="block text-xs font-medium text-fg-2">
                  UF
                </label>
                <input
                  id="u-uf"
                  value={ufCro}
                  onChange={(e) => setUfCro(e.currentTarget.value)}
                  maxLength={2}
                  className={`${campo} mt-1 uppercase`}
                  required
                />
              </div>
            </div>
            <div>
              <label htmlFor="u-comissao" className="block text-xs font-medium text-fg-2">
                Comissão (%)
              </label>
              <input
                id="u-comissao"
                value={comissao}
                onChange={(e) => setComissao(e.currentTarget.value)}
                className={`${campo} mt-1`}
              />
              <p className="mt-1 text-xs text-fg-3">
                Calculada sobre o valor <strong>recebido</strong>, não sobre o executado — decisão
                da clínica. Zero para quem não é comissionado.
              </p>
            </div>
            <div>
              <label htmlFor="u-esp" className="block text-xs font-medium text-fg-2">
                Especialidade (opcional)
              </label>
              <input
                id="u-esp"
                value={especialidade}
                onChange={(e) => setEspecialidade(e.currentTarget.value)}
                className={`${campo} mt-1`}
              />
            </div>
            <div>
              <label htmlFor="u-cbos" className="block text-xs font-medium text-fg-2">
                CBO-S (opcional)
              </label>
              <input
                id="u-cbos"
                value={cbos}
                onChange={(e) => setCbos(e.currentTarget.value)}
                maxLength={6}
                placeholder="2232xx"
                className={`${campo} mt-1`}
              />
              <p className="mt-1 text-xs text-fg-3">
                Ocupação na tabela da ANS, obrigatória no faturamento por convênio (vai no XML
                TISS). Começa em <strong>2232</strong>, que é a família de cirurgião-dentista.
                Não é usada no particular — deixe em branco se este dentista não atende convênio.
              </p>
            </div>
          </>
        ) : null}
      </div>

      {perfil === 'admin' ? (
        <p className="text-xs text-fg-3">
          Administrador configura o sistema e gerencia usuários. <strong>Não</strong> é
          superusuário clínico: continua sem ler evolução e sem alterar cobrança.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" variante="primario" disabled={pendente}>
          {pendente ? 'Salvando…' : inicial ? 'Salvar' : 'Cadastrar e gerar senha'}
        </Button>
        <Button type="button" variante="fantasma" onClick={aoCancelar}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}

export function NovoUsuario() {
  const router = useRouter()
  const [aberto, setAberto] = useState(false)
  const [senha, setSenha] = useState<{ senha: string; nome: string } | null>(null)

  if (senha) {
    return (
      <div className="w-full max-w-lg">
        <SenhaTemporaria senha={senha.senha} nome={senha.nome} />
        <Button
          className="mt-2"
          onClick={() => {
            setSenha(null)
            setAberto(false)
            router.refresh()
          }}
        >
          Entendi, já entreguei
        </Button>
      </div>
    )
  }

  if (!aberto) {
    return (
      <Button variante="primario" onClick={() => setAberto(true)}>
        Novo usuário
      </Button>
    )
  }

  return (
    <div className="w-full rounded-(--radius-controle) border border-border bg-surface-2 p-3">
      <Formulario
        aoConcluir={(s, nome) => {
          if (s) setSenha({ senha: s, nome: nome ?? '' })
          else {
            setAberto(false)
            router.refresh()
          }
        }}
        aoCancelar={() => setAberto(false)}
      />
    </div>
  )
}

export function UsuarioControles({
  usuario,
  souEu,
  unicoAdminAtivo,
}: {
  usuario: UsuarioEditavel
  souEu: boolean
  unicoAdminAtivo: boolean
}) {
  const router = useRouter()
  const [pendente, iniciar] = useTransition()
  const [modo, setModo] = useState<'nada' | 'editar' | 'confirmar-desativar'>('nada')
  const [senha, setSenha] = useState<string | null>(null)
  const [aviso, setAviso] = useState<{ ok: boolean; mensagem: string } | null>(null)

  if (senha) {
    return (
      <div className="w-80">
        <SenhaTemporaria senha={senha} nome={usuario.nome} />
        <Button
          className="mt-2"
          tamanho="sm"
          onClick={() => {
            setSenha(null)
            router.refresh()
          }}
        >
          Entendi
        </Button>
      </div>
    )
  }

  if (modo === 'editar') {
    return (
      <div className="w-full min-w-80 rounded-(--radius-controle) border border-border bg-surface-2 p-3">
        <Formulario
          inicial={usuario}
          aoConcluir={() => {
            setModo('nada')
            router.refresh()
          }}
          aoCancelar={() => setModo('nada')}
        />
      </div>
    )
  }

  if (modo === 'confirmar-desativar') {
    return (
      <div className="w-72 space-y-2">
        <p className="text-xs text-fg-2">
          Desativar o acesso de <strong>{usuario.nome}</strong>? O histórico dela permanece —
          evolução assinada, execução e trilha de auditoria não mudam.
        </p>
        <div className="flex gap-1">
          <Button
            tamanho="sm"
            variante="perigo"
            disabled={pendente}
            onClick={() =>
              iniciar(async () => {
                const r = await desativarUsuario(usuario.id)
                setAviso(r)
                if (r.ok) {
                  setModo('nada')
                  router.refresh()
                }
              })
            }
          >
            {pendente ? '…' : 'Desativar'}
          </Button>
          <Button tamanho="sm" variante="fantasma" onClick={() => setModo('nada')}>
            Voltar
          </Button>
        </div>
        {aviso && !aviso.ok ? <p className="text-xs text-critico">{aviso.mensagem}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {aviso ? (
        <p className={aviso.ok ? 'text-xs text-sucesso' : 'text-xs text-critico'}>{aviso.mensagem}</p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button tamanho="sm" variante="fantasma" onClick={() => setModo('editar')}>
          Editar
        </Button>

        <Button
          tamanho="sm"
          variante="fantasma"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await resetarSenha(usuario.id)
              if (r.ok && r.senhaTemporaria) setSenha(r.senhaTemporaria)
              else setAviso(r)
            })
          }
        >
          Nova senha
        </Button>

        <Button
          tamanho="sm"
          variante="fantasma"
          disabled={pendente}
          onClick={() =>
            iniciar(async () => {
              const r = await resetarMfa(usuario.id)
              setAviso(r)
              router.refresh()
            })
          }
          title="Para quem trocou de celular. O segredo é apagado, não exibido."
        >
          Reiniciar 2 etapas
        </Button>

        {usuario.ativo ? (
          <Button
            tamanho="sm"
            variante="fantasma"
            disabled={souEu || unicoAdminAtivo}
            title={
              souEu
                ? 'Você não pode desativar o seu próprio acesso.'
                : unicoAdminAtivo
                  ? 'É o único administrador ativo — a clínica ficaria trancada fora do sistema.'
                  : undefined
            }
            onClick={() => setModo('confirmar-desativar')}
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
                const r = await reativarUsuario(usuario.id)
                setAviso(r)
                router.refresh()
              })
            }
          >
            Reativar
          </Button>
        )}
      </div>
    </div>
  )
}
