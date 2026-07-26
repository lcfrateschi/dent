import { registrar } from '@/lib/auditoria/registrar'
import { pode } from '@/lib/authz/politicas'
import { atorAtual } from '@/lib/authz/sessao'
import { dinheiroCsv, gerarCsv, nomeDeArquivoCsv } from '@/lib/domain/csv'
import { formatarMinutos, formatarTaxa } from '@/lib/domain/indicadores'
import { NOME_DIA } from '@/lib/domain/horario'
import { resolverPeriodo } from '@/lib/domain/periodo'
import { hojeDaClinica } from '@/lib/orcamento/consultas'
import {
  caixaDoPeriodo,
  procedimentosMaisExecutados,
  producaoDoPeriodo,
  relatorioDeAgenda,
} from '@/lib/relatorios/consultas'
import type { NextRequest } from 'next/server'

/**
 * Exportação de relatório em CSV.
 *
 * **Cada exportação é um evento auditável próprio.** A LGPD separa leitura de
 * exportação, e com razão: quem exporta leva o dado embora — para o e-mail
 * pessoal, para o pendrive, para o contador. Saber "quem baixou a lista de
 * pacientes" é justamente o que a trilha precisa responder.
 *
 * A permissão é por tipo de relatório, e segue a mesma separação das telas:
 * caixa exige `relatorio_financeiro`, produção e agenda exigem
 * `relatorio_clinico`. O financeiro não leva produção clínica embora, e o
 * dentista não leva o caixa.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Tipo = 'caixa' | 'producao' | 'procedimentos' | 'agenda'

const PERMISSAO: Readonly<Record<Tipo, 'relatorio_financeiro' | 'relatorio_clinico'>> = {
  caixa: 'relatorio_financeiro',
  producao: 'relatorio_clinico',
  procedimentos: 'relatorio_clinico',
  agenda: 'relatorio_clinico',
}

const ROTULO: Readonly<Record<Tipo, string>> = {
  caixa: 'Caixa',
  producao: 'Producao',
  procedimentos: 'Procedimentos',
  agenda: 'Agenda',
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tipo: string }> },
): Promise<Response> {
  const ator = await atorAtual()
  if (!ator) return new Response('Unauthorized', { status: 401 })

  const { tipo: tipoBruto } = await params
  if (!(tipoBruto in PERMISSAO)) return new Response('Not found', { status: 404 })
  const tipo = tipoBruto as Tipo

  const recurso = PERMISSAO[tipo]
  if (!pode(ator.perfil, recurso, 'exportar')) {
    // Tentativa negada também vai para a trilha: é sinal de configuração errada
    // de perfil ou de alguém procurando o que não devia.
    await registrar({
      ator,
      acao: 'exportacao',
      entidade: recurso,
      detalhes: { negado: true, tipo },
    })
    return new Response('Forbidden', { status: 403 })
  }

  const hoje = await hojeDaClinica()
  const busca = request.nextUrl.searchParams
  const periodo = resolverPeriodo(hoje, {
    tipo: busca.get('periodo') ?? undefined,
    de: busca.get('de') ?? undefined,
    ate: busca.get('ate') ?? undefined,
  })

  const { cabecalho, linhas } = await montar(tipo, periodo, new Date())

  await registrar({
    ator,
    acao: 'exportacao',
    entidade: recurso,
    detalhes: { tipo, de: periodo.de, ate: periodo.ate, linhas: linhas.length, formato: 'csv' },
  })

  const csv = gerarCsv(cabecalho, linhas)
  const nome = nomeDeArquivoCsv(ROTULO[tipo], periodo.de, periodo.ate)

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${nome}"`,
      'cache-control': 'private, no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  })
}

async function montar(
  tipo: Tipo,
  periodo: Parameters<typeof relatorioDeAgenda>[0],
  agora: Date,
): Promise<{ cabecalho: readonly string[]; linhas: readonly (readonly unknown[])[] }> {
  if (tipo === 'caixa') {
    const caixa = await caixaDoPeriodo(periodo)
    return {
      cabecalho: ['Forma de pagamento', 'Pagamentos', 'Valor'],
      linhas: [
        ...caixa.porForma.map((f) => [f.forma, f.n, dinheiroCsv(f.valor)]),
        // Totais na mesma planilha, identificados — quem abre não precisa somar
        // à mão nem descobrir se a última linha é total.
        ['TOTAL RECEBIDO', '', dinheiroCsv(caixa.recebido)],
        ['TOTAL CONCILIADO', '', dinheiroCsv(caixa.conciliado)],
      ],
    }
  }

  if (tipo === 'producao') {
    const producao = await producaoDoPeriodo(periodo)
    return {
      cabecalho: ['Profissional', 'Execuções', 'Valor executado'],
      linhas: [
        ...producao.porProfissional.map((p) => [p.nome, p.execucoes, dinheiroCsv(p.valor)]),
        ['TOTAL', producao.execucoes, dinheiroCsv(producao.valorExecutado)],
      ],
    }
  }

  if (tipo === 'procedimentos') {
    const lista = await procedimentosMaisExecutados(periodo, 200)
    return {
      cabecalho: ['Código', 'Procedimento', 'Execuções', 'Valor'],
      linhas: lista.map((p) => [p.codigo, p.nome, p.execucoes, dinheiroCsv(p.valor)]),
    }
  }

  const agenda = await relatorioDeAgenda(periodo, agora)
  return {
    cabecalho: ['Indicador', 'Valor'],
    linhas: [
      ['Ocupação reservada', formatarTaxa(agenda.ocupacao.reservada)],
      ['Ocupação realizada', formatarTaxa(agenda.ocupacao.realizada)],
      ['Agenda disponível', formatarMinutos(agenda.ocupacao.minutosDisponiveis)],
      ['Agenda reservada', formatarMinutos(agenda.ocupacao.minutosReservados)],
      ['Perdido por falta', formatarMinutos(agenda.ocupacao.minutosPerdidosPorFalta)],
      ['Concluídos', agenda.comparecimento.concluidos],
      ['Faltas', agenda.comparecimento.faltas],
      ['Cancelados', agenda.comparecimento.cancelados],
      ['Taxa de falta', formatarTaxa(agenda.comparecimento.taxaDeFalta)],
      ['Taxa de cancelamento', formatarTaxa(agenda.comparecimento.taxaDeCancelamento)],
      ['Falta entre quem confirmou', formatarTaxa(agenda.efeitoConfirmacao.faltaComConfirmacao)],
      ['Falta entre quem não confirmou', formatarTaxa(agenda.efeitoConfirmacao.faltaSemConfirmacao)],
      [],
      ['Dia da semana', 'Faltas / Total'],
      ...agenda.faltasPorDiaSemana.map((d) => [
        NOME_DIA[d.diaSemana as 0],
        `${d.faltas} / ${d.total}`,
      ]),
      [],
      ['Hora', 'Faltas / Total'],
      ...agenda.faltasPorHora.map((h) => [
        `${String(h.hora).padStart(2, '0')}:00`,
        `${h.faltas} / ${h.total}`,
      ]),
    ],
  }
}
