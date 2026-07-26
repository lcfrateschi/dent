import { marcarEnviada, marcarFalha, reivindicarMensagens } from './fila'
import { type ProvedorWhatsapp, provedorAtual } from './provedor'

/**
 * O laço de envio: reivindica pendentes, entrega ao provedor, grava o desfecho.
 *
 * **Nunca envia sem posse.** A linha só chega aqui depois de `reivindicarMensagens`
 * tê-la movido para `enviando` numa instrução atômica com `SKIP LOCKED`. Dois
 * workers rodando ao mesmo tempo pegam conjuntos disjuntos.
 *
 * **Falha não volta para a fila.** Ver a trigger de transição em
 * drizzle/0009_mensageria_travas.sql: se a chamada falhou depois de a Meta
 * receber, reenviar manda dois lembretes. O erro fica gravado e visível.
 */

export interface ResumoDespacho {
  readonly reivindicadas: number
  readonly enviadas: number
  readonly falhadas: number
  readonly provedor: string
}

export async function despacharPendentes(
  agora: Date = new Date(),
  opcoes: { readonly provedor?: ProvedorWhatsapp; readonly limite?: number } = {},
): Promise<ResumoDespacho> {
  const provedor = opcoes.provedor ?? provedorAtual()
  const lote = await reivindicarMensagens(agora, opcoes.limite ?? 20)

  let enviadas = 0
  let falhadas = 0

  for (const m of lote) {
    const r = await provedor.enviar({
      destino: m.destino,
      corpo: m.corpo,
      template: m.template,
      parametros: normalizarParametros(m.parametros),
    })

    if (r.ok) {
      await marcarEnviada(m.id, provedor.nome, r.idExterno)
      enviadas++
    } else {
      // O `transitorio` entra na mensagem para quem for decidir o reenvio:
      // "limite de envio atingido" pede outra tentativa, "número não tem
      // WhatsApp" pede corrigir o cadastro.
      await marcarFalha(
        m.id,
        r.codigo,
        `${r.mensagem}${r.transitorio ? ' (transitório — pode tentar de novo)' : ' (definitivo — corrija o cadastro)'}`,
      )
      falhadas++
    }
  }

  return { reivindicadas: lote.length, enviadas, falhadas, provedor: provedor.nome }
}

/** `parametros` vem de jsonb, então chega como `unknown`. */
function normalizarParametros(bruto: unknown): readonly string[] {
  if (!Array.isArray(bruto)) return []
  return bruto.filter((p): p is string => typeof p === 'string')
}
