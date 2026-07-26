import { verificarAssinatura, conferirDesafio } from '@/lib/mensageria/assinatura'
import { extrairEventos } from '@/lib/mensageria/payload'
import { aplicarStatus, processarMensagemRecebida } from '@/lib/mensageria/receber'
import type { NextRequest } from 'next/server'

/**
 * Webhook do WhatsApp.
 *
 * A rota mais exposta do sistema: é pública por necessidade e pode **alterar a
 * agenda**. Quem chegar aqui sem assinatura válida não passa.
 *
 * Quatro decisões que valem explicação:
 *
 * 1. **Lê o corpo como texto antes de qualquer `parse`.** O HMAC da Meta é sobre
 *    os bytes recebidos; reserializar o JSON muda a ordem das chaves e a
 *    assinatura deixa de casar. Ver lib/mensageria/assinatura.ts.
 * 2. **Responde 200 mesmo quando o conteúdo não interessa.** A Meta reentrega
 *    quem responde erro, e reentrega com backoff crescente. Um 500 por payload
 *    estranho viraria uma tempestade de reentregas.
 * 3. **Assinatura inválida responde 403 e não diz por quê.** O motivo vai para o
 *    log do servidor; dizer ao cliente "assinatura com tamanho errado" ajudaria
 *    quem está tentando adivinhar.
 * 4. **`nodejs` explícito.** Precisa de `node:crypto` para o HMAC.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Handshake de assinatura do webhook, feito uma vez no painel da Meta. */
export function GET(request: NextRequest): Response {
  const r = conferirDesafio(request.nextUrl.searchParams, process.env.WHATSAPP_VERIFY_TOKEN)
  if (!r.ok) {
    console.warn('[whatsapp] verificação de webhook recusada:', r.motivo)
    return new Response('Forbidden', { status: 403 })
  }
  // A Meta espera o challenge em texto puro.
  return new Response(r.desafio, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

export async function POST(request: NextRequest): Promise<Response> {
  const corpo = await request.text()

  const assinatura = verificarAssinatura(
    corpo,
    request.headers.get('x-hub-signature-256'),
    process.env.WHATSAPP_APP_SECRET,
  )
  if (!assinatura.valida) {
    console.warn('[whatsapp] webhook recusado:', assinatura.motivo)
    return new Response('Forbidden', { status: 403 })
  }

  let bruto: unknown
  try {
    bruto = JSON.parse(corpo)
  } catch {
    // Assinado corretamente mas não é JSON: aceitar e registrar. Reentregar não
    // conserta um corpo malformado.
    console.warn('[whatsapp] corpo assinado não é JSON válido')
    return Response.json({ recebido: true, processado: 0 })
  }

  const eventos = extrairEventos(bruto)
  const agora = new Date()

  let mensagens = 0
  let statuses = 0

  for (const m of eventos.mensagens) {
    try {
      const r = await processarMensagemRecebida(m, agora)
      if (r.registrada) mensagens++
    } catch (e) {
      // Uma mensagem com problema não pode impedir as outras do lote.
      console.error('[whatsapp] falha ao processar mensagem', m.idExterno, e)
    }
  }

  for (const s of eventos.statuses) {
    try {
      if (await aplicarStatus(s)) statuses++
    } catch (e) {
      console.error('[whatsapp] falha ao aplicar status', s.idExterno, e)
    }
  }

  if (eventos.ignorados > 0) {
    console.info('[whatsapp] entradas ignoradas no lote:', eventos.ignorados)
  }

  return Response.json({ recebido: true, mensagens, statuses })
}
