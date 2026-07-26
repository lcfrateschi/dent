import { registrar } from '@/lib/auditoria/registrar'
import { pode } from '@/lib/authz/politicas'
import { atorAtual } from '@/lib/authz/sessao'
import { cabecalhoDaClinica } from '@/lib/orcamento/consultas'
import { acharGuia } from '@/lib/tiss/consultas'
import { xmlGuiaOdontologica } from '@/lib/tiss/exportar'

/**
 * XML TISS da guia.
 *
 * ⚠️ **Não validado contra o XSD da ANS nem enviado a operadora real.** Ver o aviso
 * no topo de `lib/tiss/exportar.ts`. O caminho que funciona hoje é a folha de
 * conferência — este arquivo existe para ser conferido quando houver o XSD.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ator = await atorAtual()
  if (!ator) return new Response('Unauthorized', { status: 401 })

  const { id } = await params

  if (!pode(ator.perfil, 'convenio', 'exportar')) {
    await registrar({
      ator,
      acao: 'exportacao',
      entidade: 'guia_tiss',
      entidadeId: id,
      detalhes: { negado: true, formato: 'xml' },
    })
    return new Response('Forbidden', { status: 403 })
  }

  const guia = await acharGuia(ator, id)
  if (!guia) return new Response('Not found', { status: 404 })

  const clinica = await cabecalhoDaClinica()

  const xml = xmlGuiaOdontologica({
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
  })

  await registrar({
    ator,
    acao: 'exportacao',
    entidade: 'guia_tiss',
    entidadeId: id,
    pacienteId: guia.pacienteId,
    detalhes: { formato: 'xml', numero: guia.numero },
  })

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': `attachment; filename="guia-${guia.numero}.xml"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
