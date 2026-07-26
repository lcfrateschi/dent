import { ProvedorMeta } from './meta'
import { ProvedorSimulado } from './simulado'
import type { ProvedorWhatsapp } from './tipos'

export { ProvedorMeta } from './meta'
export { ProvedorSimulado } from './simulado'
export type * from './tipos'

/**
 * Escolha do provedor.
 *
 * Simulado é o padrão. Isso é decisão de segurança, não conveniência: se a
 * escolha fosse "real quando não configurado explicitamente", um ambiente com
 * variáveis pela metade mandaria mensagem de teste para telefone de paciente
 * real. Errar para o lado de não enviar nada é reversível; mandar não é.
 */
export function provedorAtual(env: NodeJS.ProcessEnv = process.env): ProvedorWhatsapp {
  if (env.WHATSAPP_PROVEDOR !== 'meta') return new ProvedorSimulado()

  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID
  const token = env.WHATSAPP_TOKEN
  if (!phoneNumberId || !token) {
    throw new Error(
      'WHATSAPP_PROVEDOR=meta exige WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_TOKEN. ' +
        'Sem elas o sistema não cai para o simulado de propósito: enviaria mensagem de ' +
        'teste para paciente de verdade ou deixaria de enviar sem ninguém perceber.',
    )
  }
  return new ProvedorMeta({ phoneNumberId, token })
}
