import { createHash } from 'node:crypto'
import { armazenamento } from '@/lib/armazenamento'
import { registrarDoPaciente } from '@/lib/auditoria/registrar'
import { formatoDoMime } from '@/lib/documentos/consultas'
import { FORMATOS, nomeParaDownload } from '@/lib/domain/arquivo'
import { documentoDoPortalParaDownload } from '@/lib/portal/consultas'
import { sessaoAtual } from '@/lib/portal/sessao'
import { comContextoDeClinica } from '@/lib/tenant/contexto'

/**
 * Download de documento **pelo portal do paciente**.
 *
 * Rota separada de `/api/documentos/[id]`, e a separação é o ponto — CLAUDE.md,
 * decisão 2. A rota do staff autoriza por **perfil de clínica**
 * (`pode(ator.perfil, 'documento', 'ler')`); esta autoriza por **sessão de
 * paciente** e só entrega documento daquele paciente. Uma rota só, com dois modos
 * de autorização, seria a construção mais provável de um vazamento entre realms:
 * bastaria uma ordem de `if` errada.
 *
 * Três diferenças concretas em relação à rota do staff:
 *
 * 1. **Escopo.** `documentoDoPortalParaDownload` filtra por `sessao.pacienteId` e
 *    pelos tipos que o portal expõe — radiografia e foto clínica não passam.
 * 2. **Ator na auditoria.** Registra como `paciente`, não como `staff`.
 * 3. **Sem `inline` para PDF de terceiro.** Aqui tudo desce como anexo: o portal
 *    não precisa exibir embutido, e `attachment` elimina a superfície de conteúdo
 *    renderizado no nosso domínio.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sessao = await sessaoAtual()
  if (!sessao) return new Response('Unauthorized', { status: 401 })

  /**
   * ── Por que o corpo desta rota roda dentro de `comContextoDeClinica` ──────
   *
   * Server Component tem o store por requisição do React para carregar o tenant
   * (`lib/tenant/armazem.ts`). **Route handler não tem** — e o `enterWith` do
   * `AsyncLocalStorage` feito dentro de `sessaoAtual()` não sobrevive ao `await` de volta
   * para cá: o Next resume a continuação do handler com o contexto assíncrono
   * capturado antes dela.
   *
   * O sintoma é 500 com "sem contexto de clínica" numa rota que autenticou
   * corretamente. E num teste adversarial isso é pior que parece: **um 500 se
   * confunde com isolamento**, quando é só erro. Daí o envelope explícito —
   * `run()` garante o contexto para tudo o que roda dentro, sem depender de
   * propagação.
   */
  return await comContextoDeClinica(sessao.clinicaId, async () => {

  const { id } = await params
  const doc = await documentoDoPortalParaDownload(sessao, id)
  // Documento de outro paciente, removido, ou de tipo não exposto: todos 404.
  // Distinguir diria ao curioso que aquele documento existe.
  if (!doc) return new Response('Not found', { status: 404 })

  let conteudo: Uint8Array
  try {
    conteudo = await armazenamento().ler(doc.storageKey)
  } catch (e) {
    console.error('[portal] falha ao ler documento', doc.storageKey, e)
    return new Response('Arquivo indisponível.', { status: 502 })
  }

  const hash = createHash('sha256').update(conteudo).digest('hex')
  if (hash !== doc.sha256) {
    console.error('[portal] INTEGRIDADE: hash divergente', { documentoId: doc.id })
    await registrarDoPaciente({
      acao: 'leitura',
      entidade: 'documento',
      entidadeId: doc.id,
      pacienteId: sessao.pacienteId,
      detalhes: { integridadeFalhou: true, realm: 'portal' },
    })
    return new Response('Arquivo indisponível.', { status: 500 })
  }

  const formato = formatoDoMime(doc.mimeType)
  const extensao = formato ? FORMATOS[formato].extensao : 'bin'
  const nome = nomeParaDownload(doc.nome, extensao)

  await registrarDoPaciente({
    acao: 'exportacao',
    entidade: 'documento',
    entidadeId: doc.id,
    pacienteId: sessao.pacienteId,
    detalhes: { tipo: doc.tipo, realm: 'portal' },
  })

  return new Response(Buffer.from(conteudo), {
    status: 200,
    headers: {
      'content-type': formato ? FORMATOS[formato].mime : 'application/octet-stream',
      'content-length': String(conteudo.byteLength),
      // Sempre anexo — ver a decisão 3 no comentário do módulo.
      'content-disposition': `attachment; filename="${nome}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store, max-age=0',
      'content-security-policy': "default-src 'none'; sandbox",
      referrerPolicy: 'no-referrer',
    },
  })
  })
}
