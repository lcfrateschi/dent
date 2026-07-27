import { BotaoSair } from '@/components/ui/BotaoSair'
import { ROTULO_PERFIL, type Recurso, podeVer } from '@/lib/authz/politicas'
import { atorAtual } from '@/lib/authz/sessao'
import { cn } from '@/lib/ui/cn'
import { Marca } from '@/components/ui/Marca'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Icone, type NomeIcone } from '@/components/ui/Icone'

/**
 * Casca do realm de STAFF.
 *
 * `app/(staff)` e o futuro `app/(portal)` são realms separados por decisão de
 * segurança (CLAUDE.md, decisão 2): sessão, layout e consultas distintos.
 * Nada aqui dentro pode ser reaproveitado no portal do paciente.
 *
 * O menu só mostra o que o perfil pode ver — mas isso é conveniência, não
 * proteção: quem garante o acesso é `exigirPermissao` em cada action e page.
 */

interface ItemMenu {
  href: string
  rotulo: string
  /**
   * Recursos que dão acesso ao item. Basta UM.
   *
   * É lista porque o painel tem dois públicos com permissões diferentes: o
   * dentista entra por `relatorio_clinico`, o financeiro por
   * `relatorio_financeiro`, e cada um vê só o seu bloco lá dentro.
   */
  recursos: readonly Recurso[]
  icone: NomeIcone
  /** Fase que constrói a tela. Ausente = já existe. */
  fase?: number
}

const MENU: readonly ItemMenu[] = [
  {
    href: '/painel',
    rotulo: 'Painel',
    recursos: ['relatorio_clinico', 'relatorio_financeiro'],
    icone: 'painel',
  },
  { href: '/pacientes', rotulo: 'Pacientes', recursos: ['paciente'], icone: 'pacientes' },
  { href: '/agenda', rotulo: 'Agenda', recursos: ['agenda'], icone: 'agenda' },
  { href: '/whatsapp', rotulo: 'WhatsApp', recursos: ['mensageria'], icone: 'whatsapp' },
  { href: '/financeiro', rotulo: 'Financeiro', recursos: ['cobranca'], icone: 'financeiro' },
  {
    href: '/caixa',
    // "Caixa" e não "Despesas": a tela responde "quanto entrou e saiu do banco", e
    // despesa é uma parte. O rótulo do menu é a primeira pista de qual pergunta a tela
    // responde — e este módulo tem TRÊS respostas diferentes para o mesmo mês (caixa
    // por `pago_em`, custo por `competencia`, dívida por `vencimento`).
    rotulo: 'Caixa',
    // Recurso PRÓPRIO, não `cobranca`. Dinheiro que sai da clínica é confiança
    // diferente do dinheiro que entra do paciente: com `cobranca`, a recepção passaria
    // a poder pagar o aluguel e estornar a conta do laboratório.
    recursos: ['despesa'],
    // Vizinho de `/financeiro` de propósito, e ícone igual pelo mesmo motivo: são os
    // dois lados do mesmo assunto. Se a semelhança confundir na prática, o conserto é
    // um ícone próprio em `Icone.tsx`.
    icone: 'financeiro',
  },
  { href: '/auditoria', rotulo: 'Auditoria', recursos: ['auditoria'], icone: 'auditoria' },
  { href: '/convenios', rotulo: 'Convênios', recursos: ['convenio'], icone: 'convenios' },
  {
    href: '/relacionamento',
    rotulo: 'Relacionamento',
    recursos: ['relacionamento'],
    // `whatsapp` reusado: a fila é sobre FALAR com o paciente, e o ícone de conversa
    // diz isso melhor que um de lista. Ícone próprio quando o design system tiver um.
    icone: 'whatsapp',
  },
  {
    href: '/espera',
    rotulo: 'Lista de espera',
    // `relacionamento` reusado com argumento: é fila de contato ativo trabalhada pela
    // recepção, mesma forma e mesmo perfil das filas da Fase 18.
    recursos: ['relacionamento'],
    icone: 'agenda',
  },
  {
    href: '/laboratorio',
    rotulo: 'Laboratório',
    // `laboratorio` e não `plano_tratamento`, e o motivo é operacional: com
    // `plano_tratamento` a **recepção só tem `ler`** — e é ela quem liga para o
    // laboratório e marca que a peça voltou. Um módulo que a pessoa que o usa não pode
    // editar não é módulo, é relatório.
    recursos: ['laboratorio'],
    icone: 'cobranca',
  },
  { href: '/estoque', rotulo: 'Estoque', recursos: ['estoque'], icone: 'estoque' },
  {
    href: '/esterilizacao',
    rotulo: 'Esterilização',
    // `estoque` reusado: processamento de instrumental é o mundo da auxiliar, o mesmo
    // que já cuida de material e lote. Vizinho de Estoque pelo mesmo motivo.
    recursos: ['estoque'],
    icone: 'estoque',
  },
  { href: '/usuarios', rotulo: 'Usuários', recursos: ['usuario'], icone: 'usuarios' },
  { href: '/configuracoes', rotulo: 'Ajustes', recursos: ['configuracao'], icone: 'ajustes' },
]

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const ator = await atorAtual()
  // O middleware já barra; esta é a segunda tranca, caso o matcher mude.
  if (!ator) redirect('/entrar')

  const itens = MENU.filter((i) => i.recursos.some((r) => podeVer(ator.perfil, r)))

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
          <Link href="/pacientes" aria-label="Facilident — início">
            <Marca tamanho="sm" id="cabecalho" />
          </Link>

          <nav className="flex flex-wrap gap-1">
            {itens.map((i) =>
              // Item de fase futura fica visível mas inerte: mostra o caminho do
              // produto sem levar a um 404.
              i.fase ? (
                <span
                  key={i.href}
                  title={`Construído na Fase ${i.fase} — ver ROADMAP.md`}
                  aria-disabled
                  className="flex cursor-not-allowed items-center gap-1.5 rounded-(--radius-controle) px-2.5 py-1.5 text-sm text-fg-3/60"
                >
                  <Icone nome={i.icone} tamanho={15} />
                  {i.rotulo}
                </span>
              ) : (
                <Link
                  key={i.href}
                  href={i.href}
                  className={cn(
                    'flex items-center gap-1.5 rounded-(--radius-controle) px-2.5 py-1.5 text-sm text-fg-2',
                    'hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {/* Ícone acompanha o rótulo, nunca o substitui: a recepção
                      tem rotatividade e ícone sozinho exige decorar vocabulário. */}
                  <Icone nome={i.icone} tamanho={15} />
                  {i.rotulo}
                </Link>
              ),
            )}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="text-right leading-tight">
              <div className="text-sm font-medium text-fg">{ator.nome}</div>
              <div className="text-xs text-fg-3">{ROTULO_PERFIL[ator.perfil]}</div>
            </div>
            <BotaoSair />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-5">{children}</main>
    </div>
  )
}
