import { ProvedorPixPsp } from './psp'
import { ProvedorPixSimulado } from './simulado'
import type { ProvedorPix } from './tipos'

export { ProvedorPixPsp } from './psp'
export { ProvedorPixSimulado } from './simulado'
export * from './tipos'

/**
 * Escolha do provedor Pix.
 *
 * **Simulado é o padrão, e isso é decisão de segurança, não conveniência.** Se a
 * escolha fosse "real quando não configurado explicitamente", um ambiente com
 * variáveis pela metade emitiria cobrança de verdade contra a conta da clínica.
 * Errar para o lado de não cobrar é reversível; cobrar não é.
 *
 * É a mesma regra de `provedorAtual()` do WhatsApp — e lá o custo do erro era mandar
 * mensagem de teste a paciente real. Aqui é dinheiro.
 *
 * `PIX_PROVEDOR=psp` sem as credenciais **estoura** em vez de cair para o simulado: um
 * ambiente que se acha configurado e silenciosamente não cobra ninguém é pior que um
 * que não sobe.
 */
/**
 * Qual provedor está configurado, **sem construir nenhum**.
 *
 * Existe para a tela poder avisar "provedor simulado" sem chamar `provedorPixAtual()`,
 * que valida credenciais e **estoura** quando `PIX_PROVEDOR=psp` está pela metade. Esse
 * estouro é correto no boot e péssimo numa página: derrubaria a tela de conciliação
 * exatamente no ambiente que mais precisa dela para diagnosticar a configuração.
 *
 * Só lê a variável. Não decide nada e não emite nada.
 */
export function provedorPixConfigurado(env: NodeJS.ProcessEnv = process.env): 'psp' | 'simulado' {
  return env.PIX_PROVEDOR === 'psp' ? 'psp' : 'simulado'
}

export function provedorPixAtual(env: NodeJS.ProcessEnv = process.env): ProvedorPix {
  if (env.PIX_PROVEDOR !== 'psp') {
    return new ProvedorPixSimulado(env.PIX_SEGREDO_WEBHOOK ?? undefined)
  }

  const base = env.PIX_PSP_BASE
  const token = env.PIX_PSP_TOKEN
  const segredoWebhook = env.PIX_SEGREDO_WEBHOOK
  const chave = env.PIX_CHAVE
  if (!base || !token || !segredoWebhook || !chave) {
    throw new Error(
      'PIX_PROVEDOR=psp exige PIX_PSP_BASE, PIX_PSP_TOKEN, PIX_SEGREDO_WEBHOOK e PIX_CHAVE. ' +
        'Sem elas o sistema NÃO cai para o simulado, de propósito: emitiria cobrança de ' +
        'verdade sem querer, ou deixaria de emitir sem ninguém perceber.',
    )
  }
  return new ProvedorPixPsp({
    base,
    token,
    segredoWebhook,
    chave,
    cabecalhoAssinatura: env.PIX_CABECALHO_ASSINATURA ?? undefined,
  })
}
