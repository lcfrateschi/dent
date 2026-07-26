import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Icone } from '@/components/ui/Icone'
import { pode } from '@/lib/authz/politicas'
import { atorAtual } from '@/lib/authz/sessao'
import { deCentavos } from '@/lib/domain/dinheiro'
import { NOME_DIA_CURTO } from '@/lib/domain/horario'
import {
  type Sentido,
  type Variacao,
  formatarMinutos,
  formatarTaxa,
  tomDaVariacao,
  variacaoDeDinheiro,
  calcularVariacao,
} from '@/lib/domain/indicadores'
import { periodoAnterior, resolverPeriodo } from '@/lib/domain/periodo'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import {
  caixaDoPeriodo,
  montarPainel,
  procedimentosMaisExecutados,
  producaoDoPeriodo,
} from '@/lib/relatorios/consultas'
import { cn } from '@/lib/ui/cn'
import { reais } from '@/lib/ui/moeda'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

export const metadata: Metadata = { title: 'Painel' }

type Busca = { periodo?: string; de?: string; ate?: string }

/**
 * Painel da clínica.
 *
 * A tela é organizada por **quem pergunta o quê**, e o RBAC não é decoração aqui:
 * o dentista vê produção e agenda, o financeiro vê caixa, e nenhum dos dois vê o
 * bloco do outro. O admin vê os dois porque configura o sistema, mas continua sem
 * acesso a dado clínico de paciente — agregado não é prontuário.
 *
 * **Caixa e produção aparecem em cartões separados, e nunca somados.** É a decisão
 * mais importante desta fase: um "faturamento" que junta o que foi executado com o
 * que entrou responde a pergunta de ninguém. Executado em julho pode entrar em
 * outubro, e a comissão da clínica é sobre o recebido.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Busca> }) {
  // Entra quem tem ALGUM relatório; a separação fina vem depois, bloco por bloco.
  //
  // A checagem é feita à mão em vez de com `exigirPermissaoPagina` porque a regra
  // é "um OU outro", e aquela função redireciona na primeira negativa. Envolver
  // em try/catch seria pior: `redirect()` do Next funciona LANÇANDO, e capturar
  // engoliria o redirecionamento.
  const ator = await atorAtual()
  if (!ator) redirect('/entrar')

  const veCaixa = pode(ator.perfil, 'relatorio_financeiro', 'ler')
  const veClinico = pode(ator.perfil, 'relatorio_clinico', 'ler')

  if (!veCaixa && !veClinico) {
    redirect(`/sem-permissao?${new URLSearchParams({ recurso: 'relatorio_clinico', acao: 'ler' })}`)
  }

  const busca = await searchParams
  const hoje = await hojeDaClinica()
  const periodo = resolverPeriodo(hoje, busca)
  const anterior = periodoAnterior(periodo)
  const agora = new Date()

  const painel = await montarPainel(ator, periodo, agora)

  // O período anterior só é consultado para o que a tela vai mostrar.
  const [caixaAnterior, producaoAnterior] = await Promise.all([
    veCaixa ? caixaDoPeriodo(anterior) : Promise.resolve(null),
    veClinico ? producaoDoPeriodo(anterior) : Promise.resolve(null),
  ])

  const procedimentos = veClinico ? await procedimentosMaisExecutados(periodo, 10) : []

  const { caixa, producao, agenda, pacientes } = painel

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Painel</h1>
          <p className="text-sm text-fg-3">
            {periodo.rotulo} · comparado com {anterior.rotulo}
          </p>
        </div>
        <SeletorDePeriodo atual={periodo.tipo} />
      </div>

      {veCaixa ? (
        <Card>
          <CardHeader
            titulo="Caixa"
            descricao="O que ENTROU no período. Não é o mesmo que produção — um tratamento feito em julho pode ser recebido em outubro."
            acoes={
              pode(ator.perfil, 'relatorio_financeiro', 'exportar') ? (
                <BotaoCsv tipo="caixa" periodo={periodo.tipo} de={periodo.de} ate={periodo.ate} />
              ) : undefined
            }
          />
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Numero
                rotulo="Recebido"
                valor={reais(caixa.recebido)}
                apoio="Tudo que entrou"
                variacao={
                  caixaAnterior ? variacaoDeDinheiro(caixa.recebido, caixaAnterior.recebido) : null
                }
                sentido="maior_melhor"
              />
              <Numero
                rotulo="Conciliado"
                valor={reais(caixa.conciliado)}
                apoio="Conferido no extrato · base da comissão"
                variacao={
                  caixaAnterior
                    ? variacaoDeDinheiro(caixa.conciliado, caixaAnterior.conciliado)
                    : null
                }
                sentido="maior_melhor"
              />
              <Numero
                rotulo="Ticket médio"
                valor={
                  caixa.ticketMedioCentavos === null
                    ? '—'
                    : reais(deCentavos(caixa.ticketMedioCentavos))
                }
                apoio={`${caixa.pacientesQuePagaram} paciente(s) pagaram`}
              />
              <Numero
                rotulo="Aguardando conciliação"
                valor={reais(caixa.aguardandoConciliacao)}
                apoio="Ainda não conta para comissão"
                tom={Number(caixa.aguardandoConciliacao) > 0 ? 'atencao' : 'neutro'}
              />
            </div>

            {caixa.porForma.length > 0 ? (
              <Tabela
                colunas={['Forma', 'Pagamentos', 'Valor']}
                linhas={caixa.porForma.map((f) => [
                  ROTULO_FORMA[f.forma] ?? f.forma,
                  String(f.n),
                  reais(f.valor),
                ])}
              />
            ) : (
              <p className="text-sm text-fg-3">Nenhum pagamento no período.</p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {veClinico ? (
        <Card>
          <CardHeader
            titulo="Produção"
            descricao="O que foi EXECUTADO no período, no valor acordado com o paciente. Não é caixa."
            acoes={
              pode(ator.perfil, 'relatorio_clinico', 'exportar') ? (
                <BotaoCsv tipo="producao" periodo={periodo.tipo} de={periodo.de} ate={periodo.ate} />
              ) : undefined
            }
          />
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Numero
                rotulo="Valor executado"
                valor={reais(producao.valorExecutado)}
                apoio={`${producao.execucoes} procedimento(s)`}
                variacao={
                  producaoAnterior
                    ? variacaoDeDinheiro(producao.valorExecutado, producaoAnterior.valorExecutado)
                    : null
                }
                sentido="maior_melhor"
              />
              <Numero
                rotulo="Pacientes atendidos"
                valor={String(producao.pacientesAtendidos)}
                apoio="Distintos no período"
                variacao={
                  producaoAnterior
                    ? calcularVariacao(
                        producao.pacientesAtendidos,
                        producaoAnterior.pacientesAtendidos,
                      )
                    : null
                }
                sentido="maior_melhor"
              />
              <Numero
                rotulo="Pacientes novos"
                valor={String(pacientes.novos)}
                apoio={`${pacientes.ativos} ativos no total`}
              />
            </div>

            {producao.porProfissional.length > 0 ? (
              <Tabela
                colunas={['Profissional', 'Execuções', 'Valor']}
                linhas={producao.porProfissional.map((p) => [
                  p.nome,
                  String(p.execucoes),
                  reais(p.valor),
                ])}
              />
            ) : (
              <p className="text-sm text-fg-3">Nenhuma execução registrada no período.</p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {veClinico ? (
        <Card>
          <CardHeader
            titulo="Agenda"
            descricao="Reservada e realizada são perguntas diferentes: agenda cheia com muita falta é problema de confirmação, agenda vazia é problema de captação."
            acoes={
              pode(ator.perfil, 'relatorio_clinico', 'exportar') ? (
                <BotaoCsv tipo="agenda" periodo={periodo.tipo} de={periodo.de} ate={periodo.ate} />
              ) : undefined
            }
          />
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Numero
                rotulo="Ocupação reservada"
                valor={formatarTaxa(agenda.ocupacao.reservada)}
                apoio={`${formatarMinutos(agenda.ocupacao.minutosReservados)} de ${formatarMinutos(agenda.ocupacao.minutosDisponiveis)}`}
              />
              <Numero
                rotulo="Ocupação realizada"
                valor={formatarTaxa(agenda.ocupacao.realizada)}
                apoio={`${formatarMinutos(agenda.ocupacao.minutosRealizados)} atendidos`}
                tom="sucesso"
              />
              <Numero
                rotulo="Taxa de falta"
                valor={formatarTaxa(agenda.comparecimento.taxaDeFalta)}
                apoio={`${agenda.comparecimento.faltas} falta(s) · ${formatarMinutos(agenda.ocupacao.minutosPerdidosPorFalta)} perdidos`}
                tom={
                  (agenda.comparecimento.taxaDeFalta ?? 0) > 10
                    ? 'critico'
                    : (agenda.comparecimento.taxaDeFalta ?? 0) > 5
                      ? 'atencao'
                      : 'neutro'
                }
              />
              <Numero
                rotulo="Taxa de cancelamento"
                valor={formatarTaxa(agenda.comparecimento.taxaDeCancelamento)}
                apoio={`${agenda.comparecimento.cancelados} cancelado(s) — avisaram`}
              />
            </div>

            {/* O que a Fase 9 permite responder. */}
            <div className="rounded-(--radius-controle) border border-border bg-surface-2 px-3 py-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Icone nome="whatsapp" tamanho={14} />
                Confirmação faz diferença?
              </h3>
              {agenda.efeitoConfirmacao.diferencaEmPontos === null ? (
                <p className="mt-1 text-sm text-fg-3">
                  Ainda não há casos suficientes para comparar — precisa de pelo menos 10
                  atendimentos de cada lado.{' '}
                  {agenda.efeitoConfirmacao.faltaComConfirmacao !== null
                    ? `Falta entre quem confirmou: ${formatarTaxa(agenda.efeitoConfirmacao.faltaComConfirmacao)} (${agenda.efeitoConfirmacao.baseConfirmados} caso(s)).`
                    : ''}
                </p>
              ) : (
                <p className="mt-1 text-sm text-fg-2">
                  Quem confirmou faltou{' '}
                  <strong className="text-fg">
                    {formatarTaxa(agenda.efeitoConfirmacao.faltaComConfirmacao)}
                  </strong>{' '}
                  das vezes; quem não confirmou,{' '}
                  <strong className="text-fg">
                    {formatarTaxa(agenda.efeitoConfirmacao.faltaSemConfirmacao)}
                  </strong>
                  .{' '}
                  {agenda.efeitoConfirmacao.diferencaEmPontos > 0 ? (
                    <>
                      Confirmar reduziu a falta em{' '}
                      <strong className="text-sucesso">
                        {agenda.efeitoConfirmacao.diferencaEmPontos.toString().replace('.', ',')}{' '}
                        pontos
                      </strong>
                      .
                    </>
                  ) : (
                    <span className="text-atencao">
                      A confirmação não reduziu a falta neste período.
                    </span>
                  )}
                </p>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-fg">Faltas por dia da semana</h3>
                {agenda.faltasPorDiaSemana.length === 0 ? (
                  <p className="text-sm text-fg-3">Sem atendimentos no período.</p>
                ) : (
                  <Barras
                    itens={agenda.faltasPorDiaSemana.map((d) => ({
                      rotulo: NOME_DIA_CURTO[d.diaSemana as 0],
                      faltas: d.faltas,
                      total: d.total,
                    }))}
                  />
                )}
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-fg">Faltas por horário</h3>
                {agenda.faltasPorHora.length === 0 ? (
                  <p className="text-sm text-fg-3">Sem atendimentos no período.</p>
                ) : (
                  <Barras
                    itens={agenda.faltasPorHora.map((h) => ({
                      rotulo: `${String(h.hora).padStart(2, '0')}h`,
                      faltas: h.faltas,
                      total: h.total,
                    }))}
                  />
                )}
              </div>
            </div>

            {agenda.porProfissional.length > 0 ? (
              <Tabela
                colunas={['Profissional', 'Agenda reservada', 'Concluídos', 'Faltas']}
                linhas={agenda.porProfissional.map((p) => [
                  p.nome,
                  formatarMinutos(p.minutosReservados),
                  String(p.concluidos),
                  String(p.faltas),
                ])}
              />
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {veClinico && procedimentos.length > 0 ? (
        <Card>
          <CardHeader
            titulo="Procedimentos mais executados"
            descricao="Onde o tempo da clínica está indo."
            acoes={
              pode(ator.perfil, 'relatorio_clinico', 'exportar') ? (
                <BotaoCsv
                  tipo="procedimentos"
                  periodo={periodo.tipo}
                  de={periodo.de}
                  ate={periodo.ate}
                />
              ) : undefined
            }
          />
          <CardBody className="p-0">
            <Tabela
              semMargem
              colunas={['Código', 'Procedimento', 'Execuções', 'Valor']}
              linhas={procedimentos.map((p) => [
                p.codigo,
                p.nome,
                String(p.execucoes),
                reais(p.valor),
              ])}
            />
          </CardBody>
        </Card>
      ) : null}

      {pacientes.porOrigem.length > 0 && veClinico ? (
        <Card>
          <CardHeader
            titulo="Como chegaram"
            descricao="Origem dos pacientes cadastrados no período."
          />
          <CardBody className="p-0">
            <Tabela
              semMargem
              colunas={['Origem', 'Pacientes']}
              linhas={pacientes.porOrigem.map((o) => [o.origem, String(o.n)])}
            />
          </CardBody>
        </Card>
      ) : null}

      <p className="text-xs text-fg-3">
        Esta consulta foi registrada na trilha de auditoria, e cada exportação também é. Taxa com
        “—” significa que não há base para calcular no período — não que seja zero.
      </p>
    </div>
  )
}

const ROTULO_FORMA: Readonly<Record<string, string>> = {
  dinheiro: 'Dinheiro',
  pix: 'PIX',
  debito: 'Cartão de débito',
  credito: 'Cartão de crédito',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  convenio: 'Convênio',
}

function SeletorDePeriodo({ atual }: { atual: string }) {
  const opcoes = [
    { valor: 'mes', rotulo: 'Mês' },
    { valor: 'trimestre', rotulo: 'Trimestre' },
    { valor: 'ano', rotulo: 'Ano' },
  ]
  return (
    <div className="flex gap-1 text-sm">
      {opcoes.map((o) => (
        <Link
          key={o.valor}
          href={`/painel?periodo=${o.valor}`}
          className={cn(
            'rounded-(--radius-controle) border px-2.5 py-1.5',
            atual === o.valor
              ? 'border-primary bg-primary/10 font-medium text-primary'
              : 'border-border text-fg-2 hover:bg-surface-2',
          )}
        >
          {o.rotulo}
        </Link>
      ))}
    </div>
  )
}

function BotaoCsv({
  tipo,
  periodo,
  de,
  ate,
}: {
  tipo: string
  periodo: string
  de: string
  ate: string
}) {
  return (
    <a
      href={`/api/relatorios/${tipo}?periodo=${periodo}&de=${de}&ate=${ate}`}
      className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
    >
      <Icone nome="baixar" tamanho={14} />
      CSV
    </a>
  )
}

function Numero({
  rotulo,
  valor,
  apoio,
  tom = 'neutro',
  variacao,
  sentido,
}: {
  rotulo: string
  valor: string
  apoio: string
  tom?: 'neutro' | 'sucesso' | 'atencao' | 'critico'
  variacao?: Variacao | null
  sentido?: Sentido
}) {
  const cor = {
    neutro: 'text-fg',
    sucesso: 'text-sucesso',
    atencao: 'text-atencao',
    critico: 'text-critico',
  }[tom]

  const tomVar = variacao && sentido ? tomDaVariacao(variacao, sentido) : 'neutro'
  const corVar = { bom: 'text-sucesso', ruim: 'text-critico', neutro: 'text-fg-3' }[tomVar]
  // Dupla codificação: seta E cor. Ninguém deve depender de distinguir verde de
  // vermelho para saber se o número subiu.
  const seta =
    variacao?.direcao === 'subiu' || variacao?.direcao === 'do_nada'
      ? '▲'
      : variacao?.direcao === 'caiu'
        ? '▼'
        : ''

  return (
    <div className="rounded-(--radius-cartao) border border-border bg-surface px-4 py-3">
      <span className="block text-[11px] font-semibold tracking-wide text-fg-3 uppercase">
        {rotulo}
      </span>
      <span className={cn('mt-0.5 block text-xl font-semibold', cor)}>{valor}</span>
      <span className="mt-0.5 block text-xs text-fg-3">{apoio}</span>
      {variacao ? (
        <span className={cn('mt-1 block text-xs font-medium', corVar)}>
          <span aria-hidden>{seta}</span> {variacao.rotulo}
        </span>
      ) : null}
    </div>
  )
}

function Tabela({
  colunas,
  linhas,
  semMargem = false,
}: {
  colunas: readonly string[]
  linhas: readonly (readonly string[])[]
  semMargem?: boolean
}) {
  return (
    <div className={cn('overflow-x-auto', semMargem ? '' : 'rounded-(--radius-controle) border border-border')}>
      <table className="w-full text-sm">
        <thead className="border-b border-border bg-surface-2">
          <tr className="text-left text-xs tracking-wide text-fg-3 uppercase">
            {colunas.map((c, i) => (
              <th key={c} className={cn('px-4 py-2 font-semibold', i > 0 ? 'text-right' : '')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.join('|')} className="border-b border-border last:border-0">
              {linha.map((celula, i) => (
                <td
                  key={`${linha[0]}-${i}`}
                  className={cn('px-4 py-2', i === 0 ? 'text-fg' : 'text-right text-fg-2')}
                >
                  {celula}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Barras de falta sobre total.
 *
 * Sem biblioteca de gráfico: é uma proporção por linha, e um `div` com largura
 * percentual diz a mesma coisa. O número vem escrito ao lado — a barra é reforço
 * visual, não a única informação.
 */
function Barras({
  itens,
}: {
  itens: readonly { rotulo: string; faltas: number; total: number }[]
}) {
  const maior = Math.max(...itens.map((i) => i.total), 1)

  return (
    <ul className="space-y-1">
      {itens.map((i) => {
        const pctTotal = (i.total / maior) * 100
        const pctFalta = i.total === 0 ? 0 : (i.faltas / i.total) * 100
        return (
          <li key={i.rotulo} className="flex items-center gap-2 text-xs">
            <span className="w-8 shrink-0 text-fg-3">{i.rotulo}</span>
            <span className="h-3 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span
                className="block h-full rounded-full bg-primary/25"
                style={{ width: `${pctTotal}%` }}
              >
                <span
                  className="block h-full rounded-full bg-critico"
                  style={{ width: `${pctFalta}%` }}
                />
              </span>
            </span>
            <span className="w-20 shrink-0 text-right text-fg-2">
              {i.faltas}/{i.total}
              {i.total > 0 ? ` · ${Math.round(pctFalta)}%` : ''}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
