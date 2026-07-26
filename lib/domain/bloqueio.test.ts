import { describe, expect, it } from 'vitest'
import {
  ESCADA_PADRAO,
  LIMITE_POR_IP,
  MENSAGEM_CREDENCIAL_INVALIDA,
  bloqueioAtivo,
  decidirBloqueio,
  descreverEspera,
  esperaRestante,
  ipExcedeu,
} from './bloqueio'

const AGORA = new Date('2026-07-26T13:00:00Z')

describe('escada de bloqueio', () => {
  it('tolera os primeiros erros sem bloquear', () => {
    for (const falhas of [0, 1, 2, 3]) {
      const d = decidirBloqueio(falhas, AGORA)
      expect(d.bloqueado, `${falhas} falhas`).toBe(false)
      expect(d.ate).toBeNull()
      expect(d.mensagem).toBeNull()
    }
  })

  it('cresce a partir da quarta tentativa', () => {
    expect(decidirBloqueio(4, AGORA).minutos).toBe(1)
    expect(decidirBloqueio(5, AGORA).minutos).toBe(5)
    expect(decidirBloqueio(6, AGORA).minutos).toBe(15)
    expect(decidirBloqueio(7, AGORA).minutos).toBe(60)
  })

  it('PARA de crescer no último degrau — bloqueio eterno é negação de serviço', () => {
    // Quem sabe o e-mail do paciente não pode trancá-lo fora do portal para
    // sempre. Bloqueio de 30 dias é indistinguível de conta perdida.
    for (const falhas of [8, 20, 100, 10_000]) {
      const d = decidirBloqueio(falhas, AGORA)
      expect(d.minutos, `${falhas} falhas`).toBe(60)
      expect(d.bloqueado).toBe(true)
    }
  })

  it('devolve o instante do desbloqueio', () => {
    const d = decidirBloqueio(4, AGORA)
    expect(d.ate?.toISOString()).toBe('2026-07-26T13:01:00.000Z')
  })

  it('a mensagem diz quanto esperar sem revelar nada sobre a conta', () => {
    const d = decidirBloqueio(5, AGORA)
    expect(d.mensagem).toBe('Muitas tentativas. Tente de novo em 5 minutos.')
    // Não menciona e-mail, existência de conta, nem senha.
    expect(d.mensagem).not.toMatch(/e-mail|cadastr|senha|conta/i)
  })

  it('entrada inválida não bloqueia (e não estoura)', () => {
    for (const falhas of [-1, 1.5, Number.NaN]) {
      expect(decidirBloqueio(falhas, AGORA).bloqueado, String(falhas)).toBe(false)
    }
  })

  it('aceita escada configurada', () => {
    const rigida = { toleradas: 0, minutos: [10] }
    expect(decidirBloqueio(1, AGORA, rigida).minutos).toBe(10)
    expect(decidirBloqueio(50, AGORA, rigida).minutos).toBe(10)
  })

  it('a escada padrão é crescente', () => {
    const m = ESCADA_PADRAO.minutos
    for (let i = 1; i < m.length; i++) {
      expect(m[i]!, `degrau ${i}`).toBeGreaterThan(m[i - 1]!)
    }
  })
})

describe('bloqueio ativo', () => {
  it('vale enquanto o prazo não passa', () => {
    expect(bloqueioAtivo(new Date('2026-07-26T13:05:00Z'), AGORA)).toBe(true)
    expect(bloqueioAtivo(new Date('2026-07-26T12:59:00Z'), AGORA)).toBe(false)
    // No instante exato o bloqueio já acabou.
    expect(bloqueioAtivo(new Date('2026-07-26T13:00:00Z'), AGORA)).toBe(false)
  })

  it('sem prazo é sem bloqueio', () => {
    expect(bloqueioAtivo(null, AGORA)).toBe(false)
    expect(esperaRestante(null, AGORA)).toBeNull()
  })

  it('a espera restante arredonda para cima', () => {
    // 90 segundos restantes viram "2 minutos": dizer "1" e ainda barrar irrita.
    expect(esperaRestante(new Date('2026-07-26T13:01:30Z'), AGORA)).toBe('2 minutos')
    expect(esperaRestante(new Date('2026-07-26T13:00:30Z'), AGORA)).toBe('1 minuto')
  })
})

describe('descrição da espera', () => {
  it('singular, plural e horas', () => {
    expect(descreverEspera(1)).toBe('1 minuto')
    expect(descreverEspera(0)).toBe('1 minuto')
    expect(descreverEspera(5)).toBe('5 minutos')
    expect(descreverEspera(59)).toBe('59 minutos')
    expect(descreverEspera(60)).toBe('1 hora')
    expect(descreverEspera(120)).toBe('2 horas')
  })
})

describe('limite por IP', () => {
  it('existe e é mais folgado que o da conta', () => {
    // Sala de espera com wi-fi compartilha IP; varredura de cem contas não pode
    // custar nada.
    expect(LIMITE_POR_IP).toBeGreaterThan(ESCADA_PADRAO.toleradas)
    expect(ipExcedeu(LIMITE_POR_IP - 1)).toBe(false)
    expect(ipExcedeu(LIMITE_POR_IP)).toBe(true)
  })
})

describe('mensagem de credencial inválida', () => {
  it('NÃO distingue e-mail inexistente de senha errada', () => {
    // A distinção revelaria quem é paciente da clínica — e ser paciente de
    // consultório odontológico já é informação de saúde.
    expect(MENSAGEM_CREDENCIAL_INVALIDA).toBe('E-mail ou senha incorretos.')
    expect(MENSAGEM_CREDENCIAL_INVALIDA).not.toMatch(/não (existe|cadastrad)|inexistente|inativ/i)
  })
})
