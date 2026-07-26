import { createHash } from 'node:crypto'
import { armazenamento } from '@/lib/armazenamento'
import { registrar } from '@/lib/auditoria/registrar'
import { pode } from '@/lib/authz/politicas'
import { atorAtual } from '@/lib/authz/sessao'
import { formatoDoMime, documentoParaDownload } from '@/lib/documentos/consultas'
import { FORMATOS, nomeParaDownload, podeExibirEmbutido } from '@/lib/domain/arquivo'
import type { NextRequest } from 'next/server'

/**
 * Download de documento do prontuário.
 *
 * **Por que os bytes passam por aqui e não por URL assinada do bucket.** URL
 * assinada é encaminhável: quem recebe o link vê a radiografia sem sessão, sem
 * perfil e sem aparecer na trilha de auditoria. Para dado de saúde isso troca uma
 * exigência legal por economia de banda. Então cada download é uma requisição
 * autenticada, autorizada e **registrada** — a pergunta "quem viu o exame deste
 * paciente?" tem resposta.
 *
 * Quatro decisões concretas:
 *
 * 1. **Integridade conferida na leitura.** O SHA-256 do que veio do storage é
 *    comparado com o que está no banco. Divergir significa arquivo trocado ou
 *    corrompido; a resposta é 500 com aviso, não a entrega do arquivo suspeito.
 *    O hash no banco é imutável por trigger, então não há como "ajustar" o hash
 *    para casar com um arquivo trocado.
 * 2. **`Content-Type` vem do formato DETECTADO na entrada**, gravado no banco —
 *    nunca do nome do arquivo nem de palpite. Servir `text/html` do nosso domínio
 *    seria XSS com o prontuário ao lado.
 * 3. **`Content-Disposition: attachment`, salvo para imagem e PDF.** E o nome do
 *    arquivo é higienizado (`nomeParaDownload`): aspas e CRLF quebrariam o
 *    cabeçalho.
 * 4. **Documento removido é 404**, igual ao inexistente. Dizer "existe mas foi
 *    removido" já é contar algo sobre o prontuário.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params

  // O middleware já barra sem sessão; esta é a segunda tranca, e é ela que
  // garante a checagem de PERFIL — o middleware não conhece o recurso.
  const ator = await atorAtual()
  if (!ator) return new Response('Unauthorized', { status: 401 })
  if (!pode(ator.perfil, 'documento', 'ler')) {
    await registrar({
      ator,
      acao: 'leitura',
      entidade: 'documento',
      entidadeId: id,
      detalhes: { negado: true, motivo: 'perfil sem permissão' },
    })
    return new Response('Forbidden', { status: 403 })
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 })

  const doc = await documentoParaDownload(id)
  if (!doc) return new Response('Not found', { status: 404 })

  let conteudo: Uint8Array
  try {
    conteudo = await armazenamento().ler(doc.storageKey)
  } catch (e) {
    console.error('[documentos] falha ao ler do storage', doc.storageKey, e)
    // O registro existe e o arquivo não: é problema de infraestrutura, e a
    // clínica precisa saber disso em vez de ver um erro genérico.
    return new Response('Arquivo indisponível no armazenamento.', { status: 502 })
  }

  const hash = createHash('sha256').update(conteudo).digest('hex')
  if (hash !== doc.sha256) {
    console.error('[documentos] INTEGRIDADE: hash divergente', {
      documentoId: doc.id,
      esperado: doc.sha256,
      obtido: hash,
    })
    await registrar({
      ator,
      acao: 'leitura',
      entidade: 'documento',
      entidadeId: doc.id,
      pacienteId: doc.pacienteId,
      detalhes: { integridadeFalhou: true },
    })
    return new Response(
      'O arquivo armazenado não corresponde ao registro do prontuário. Acesso bloqueado.',
      { status: 500 },
    )
  }

  const formato = formatoDoMime(doc.mimeType)
  const extensao = formato ? FORMATOS[formato].extensao : 'bin'
  const nome = nomeParaDownload(doc.nome, extensao)
  const embutido = formato !== null && podeExibirEmbutido(formato)

  await registrar({
    ator,
    acao: 'exportacao',
    entidade: 'documento',
    entidadeId: doc.id,
    pacienteId: doc.pacienteId,
    detalhes: { tipo: doc.tipo, tamanhoBytes: doc.tamanhoBytes, embutido },
  })

  return new Response(Buffer.from(conteudo), {
    status: 200,
    headers: {
      // Formato desconhecido cai em octet-stream: nunca adivinhar para cima.
      'content-type': formato ? FORMATOS[formato].mime : 'application/octet-stream',
      'content-length': String(conteudo.byteLength),
      'content-disposition': `${embutido ? 'inline' : 'attachment'}; filename="${nome}"`,
      // Impede o navegador de "corrigir" o tipo por sniffing.
      'x-content-type-options': 'nosniff',
      // Cache privado: é dado de saúde, não pode ficar em proxy compartilhado.
      'cache-control': 'private, no-store, max-age=0',
      // Segunda barreira contra conteúdo ativo servido do nosso domínio.
      'content-security-policy': "default-src 'none'; img-src 'self'; object-src 'none'; sandbox",
      referrerPolicy: 'no-referrer',
    },
  })
}
