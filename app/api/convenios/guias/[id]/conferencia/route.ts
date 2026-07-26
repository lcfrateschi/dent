import { registrar } from '@/lib/auditoria/registrar'
import { pode } from '@/lib/authz/politicas'
import { atorAtual } from '@/lib/authz/sessao'
import { cabecalhoDaClinica } from '@/lib/orcamento/consultas'
import { acharGuia } from '@/lib/tiss/consultas'
import { folhaDeConferencia } from '@/lib/tiss/exportar'

/**
 * Folha de conferência da guia, em texto.
 *
 * É o artefato que a clínica usa de verdade: a recepção lê daqui e digita no portal
 * da operadora. A autorização é `convenio: exportar` — levar a guia embora é evento
 * próprio na trilha, distinto de ler a tela. O XML fica em `../xml`.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function servir(id: string): Promise<Response> {
  const formato = 'texto'

  const ator = await atorAtual()
  if (!ator) return new Response('Unauthorized', { status: 401 })

  if (!pode(ator.perfil, 'convenio', 'exportar')) {
    await registrar({
      ator,
      acao: 'exportacao',
      entidade: 'guia_tiss',
      entidadeId: id,
      detalhes: { negado: true, formato },
    })
    return new Response('Forbidden', { status: 403 })
  }

  const guia = await acharGuia(ator, id)
  if (!guia) return new Response('Not found', { status: 404 })

  const clinica = await cabecalhoDaClinica()

  const dados = {
    numero: guia.numero,
    registroAns: guia.registroAns,
    convenioNome: guia.convenioNome,
    numeroLote: guia.numeroLote,
    pacienteNome: guia.pacienteNome,
    pacienteCpf: guia.pacienteCpf,
    pacienteNascimento: guia.pacienteNascimento,
    numeroCarteirinha: guia.numeroCarteirinha,
    profissionalNome: guia.profissionalNome,
    cro: guia.cro,
    ufCro: guia.ufCro,
    clinicaNome: clinica?.nomeFantasia ?? clinica?.razaoSocial ?? 'Clínica',
    clinicaCnpj: clinica?.cnpj ?? null,
    emitidaEm: guia.emitidaEm,
    valorApresentado: guia.valorApresentado,
    itens: guia.itens.map((i) => ({
      codigoTuss: i.codigoTuss,
      descricao: i.descricao,
      denteFdi: i.denteFdi,
      faces: i.faces,
      quantidade: i.quantidade,
      dataExecucao: i.dataExecucao,
      valorApresentado: i.valorApresentado,
    })),
  }

  await registrar({
    ator,
    acao: 'exportacao',
    entidade: 'guia_tiss',
    entidadeId: id,
    pacienteId: guia.pacienteId,
    detalhes: { formato, numero: guia.numero },
  })

  return new Response(folhaDeConferencia(dados), {
    headers: {
      // `inline` em text/plain: a folha é para ler na tela e digitar no portal.
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  return servir(id)
}
