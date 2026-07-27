import { afterEach, describe, expect, it } from 'vitest'
import { mfaDesabilitado } from './mfa'
import { exigirSegredoDeProducao } from './segredo'

/**
 * Esta trava é a diferença entre "produção com segredo próprio" e "sessão
 * forjada de admin por quem leu o docker-compose". Ela já esteve errada nos dois
 * sentidos, então tem teste nos dois: precisa BARRAR o segredo público em
 * produção e precisa DEIXAR PASSAR durante o `next build`.
 */

const original = { ...process.env }

afterEach(() => {
  process.env = { ...original }
})

function ambiente(vars: Record<string, string | undefined>): void {
  process.env = { ...original, ...vars } as NodeJS.ProcessEnv
}

describe('exigirSegredoDeProducao', () => {
  it('não interfere fora de produção', () => {
    ambiente({
      NODE_ENV: 'development',
      AUTH_SECRET: 'dev-secret-trocar-em-producao-0123456789abcdef',
    })
    expect(() => exigirSegredoDeProducao()).not.toThrow()
  })

  it('barra o AUTH_SECRET de desenvolvimento em produção', () => {
    ambiente({
      NODE_ENV: 'production',
      NEXT_PHASE: undefined,
      AUTH_SECRET: 'dev-secret-trocar-em-producao-0123456789abcdef',
      WHATSAPP_APP_SECRET: 'segredo-real-da-meta',
    })
    expect(() => exigirSegredoDeProducao()).toThrow(/AUTH_SECRET está com o valor de desenvolvimento/)
  })

  it('barra o WHATSAPP_APP_SECRET de desenvolvimento em produção', () => {
    // Este é o pior dos dois: com ele, qualquer pessoa assina um POST no webhook
    // dizendo "o paciente cancelou" e cancela consulta alheia.
    ambiente({
      NODE_ENV: 'production',
      NEXT_PHASE: undefined,
      AUTH_SECRET: 'x'.repeat(48),
      WHATSAPP_APP_SECRET: 'dev-whatsapp-app-secret-trocar-em-producao',
    })
    expect(() => exigirSegredoDeProducao()).toThrow(/WHATSAPP_APP_SECRET/)
  })

  it('barra AUTH_SECRET ausente ou curta', () => {
    ambiente({ NODE_ENV: 'production', NEXT_PHASE: undefined, AUTH_SECRET: undefined })
    expect(() => exigirSegredoDeProducao()).toThrow(/não definida/)

    ambiente({ NODE_ENV: 'production', NEXT_PHASE: undefined, AUTH_SECRET: 'curta' })
    expect(() => exigirSegredoDeProducao()).toThrow(/curta demais/)
  })

  it('aceita segredo próprio e longo', () => {
    ambiente({
      NODE_ENV: 'production',
      NEXT_PHASE: undefined,
      AUTH_SECRET: 'K'.repeat(64),
      WHATSAPP_APP_SECRET: 'segredo-real-da-meta',
    })
    expect(() => exigirSegredoDeProducao()).not.toThrow()
  })

  it('NÃO se aplica durante o next build — compilar não é servir', () => {
    // O build roda com NODE_ENV=production e importa os módulos das páginas.
    // Sem esta saída, construir a imagem exigiria o App Secret da Meta no CI.
    ambiente({
      NODE_ENV: 'production',
      NEXT_PHASE: 'phase-production-build',
      AUTH_SECRET: 'dev-secret-trocar-em-producao-0123456789abcdef',
      WHATSAPP_APP_SECRET: 'dev-whatsapp-app-secret-trocar-em-producao',
    })
    expect(() => exigirSegredoDeProducao()).not.toThrow()
  })

  it('e a fase de build não é desculpa para o servidor rodando', () => {
    // `phase-production-server` é o que o Next põe ao SERVIR. Se a saída acima
    // fosse frouxa (um `startsWith('phase-production')`, por exemplo), produção
    // subiria com o segredo público.
    ambiente({
      NODE_ENV: 'production',
      NEXT_PHASE: 'phase-production-server',
      AUTH_SECRET: 'dev-secret-trocar-em-producao-0123456789abcdef',
      WHATSAPP_APP_SECRET: 'segredo-real-da-meta',
    })
    expect(() => exigirSegredoDeProducao()).toThrow(/AUTH_SECRET/)
  })

  it('BARRA MFA_DESABILITADO em produção — é a pior configuração errada', () => {
    // Um `.env` copiado do desenvolvimento para o servidor é a forma mais comum
    // de isso acontecer. Melhor o deploy quebrar do que a clínica rodar sem
    // segundo fator sem ninguém perceber.
    ambiente({
      NODE_ENV: 'production',
      NEXT_PHASE: undefined,
      AUTH_SECRET: 'K'.repeat(64),
      WHATSAPP_APP_SECRET: 'segredo-real-da-meta',
      MFA_DESABILITADO: 'true',
    })
    expect(() => exigirSegredoDeProducao()).toThrow(/MFA_DESABILITADO=true não é permitido/)
  })

  it('e a checagem do MFA vem ANTES das outras', () => {
    // Com tudo errado ao mesmo tempo, a mensagem tem de ser a do MFA: é a que
    // mais importa, e a primeira que a pessoa vai ler.
    ambiente({
      NODE_ENV: 'production',
      NEXT_PHASE: undefined,
      AUTH_SECRET: 'dev-secret-trocar-em-producao-0123456789abcdef',
      WHATSAPP_APP_SECRET: 'dev-whatsapp-app-secret-trocar-em-producao',
      MFA_DESABILITADO: 'true',
    })
    expect(() => exigirSegredoDeProducao()).toThrow(/MFA_DESABILITADO/)
  })
})

describe('mfaDesabilitado', () => {
  it('desliga só com o valor exatamente "true"', () => {
    for (const valor of ['true']) {
      ambiente({ NODE_ENV: 'development', MFA_DESABILITADO: valor })
      expect(mfaDesabilitado(), valor).toBe(true)
    }
    // Nada de "qualquer coisa não vazia": um `=0` deixaria o MFA desligado sem
    // que ninguém suspeitasse.
    for (const valor of ['false', '0', '1', 'sim', 'TRUE', '', undefined]) {
      ambiente({ NODE_ENV: 'development', MFA_DESABILITADO: valor })
      expect(mfaDesabilitado(), String(valor)).toBe(false)
    }
  })

  it('NUNCA desliga em produção, mesmo com a chave ligada', () => {
    // Dupla guarda: se alguém remover a checagem do boot, esta função continua
    // não desligando nada em produção.
    ambiente({ NODE_ENV: 'production', MFA_DESABILITADO: 'true' })
    expect(mfaDesabilitado()).toBe(false)
  })
})
