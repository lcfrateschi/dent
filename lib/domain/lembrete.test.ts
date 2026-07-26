import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import { horaLocal, instanteDe } from './fuso'
import {
  type RegraLembrete,
  REGRA_PADRAO,
  dentroDaJanela,
  proximaJanela,
  quandoEnviarLembrete,
} from './lembrete'

/** Atalho: instante local da clínica. */
function q(dia: string, hora: string): Date {
  return instanteDe(dia, hora, REGRA_PADRAO.fuso)
}

/** 'YYYY-MM-DD HH:MM' local, para asserção legível. */
function local(d: Date): string {
  return `${d.toLocaleDateString('sv-SE', { timeZone: REGRA_PADRAO.fuso })} ${horaLocal(d, REGRA_PADRAO.fuso)}`
}

describe('janela de envio', () => {
  it('reconhece dentro e fora', () => {
    expect(dentroDaJanela(q('2026-08-10', '08:00'))).toBe(true)
    expect(dentroDaJanela(q('2026-08-10', '13:30'))).toBe(true)
    expect(dentroDaJanela(q('2026-08-10', '20:00'))).toBe(true)
    expect(dentroDaJanela(q('2026-08-10', '07:59'))).toBe(false)
    expect(dentroDaJanela(q('2026-08-10', '20:01'))).toBe(false)
    expect(dentroDaJanela(q('2026-08-10', '03:00'))).toBe(false)
  })

  it('sobe para a abertura do mesmo dia quando é madrugada', () => {
    expect(local(proximaJanela(q('2026-08-10', '03:00')))).toBe('2026-08-10 08:00')
  })

  it('pula para o dia seguinte quando já fechou', () => {
    expect(local(proximaJanela(q('2026-08-10', '22:30')))).toBe('2026-08-11 08:00')
  })

  it('não mexe no que já está dentro', () => {
    const d = q('2026-08-10', '15:00')
    expect(proximaJanela(d).getTime()).toBe(d.getTime())
  })

  it('atravessa a virada do mês', () => {
    expect(local(proximaJanela(q('2026-08-31', '23:00')))).toBe('2026-09-01 08:00')
  })

  it('rejeita janela invertida', () => {
    const ruim: RegraLembrete = { ...REGRA_PADRAO, janelaAbertura: '20:00', janelaFechamento: '08:00' }
    expect(() => dentroDaJanela(q('2026-08-10', '10:00'), ruim)).toThrowError(ErroDominio)
  })
})

describe('quando enviar', () => {
  it('caso normal: 24h antes, dentro da janela', () => {
    const d = quandoEnviarLembrete(q('2026-08-12', '14:00'), q('2026-08-10', '09:00'))
    expect(d.enviar).toBe(true)
    if (!d.enviar) return
    expect(local(d.quando)).toBe('2026-08-11 14:00')
    expect(d.motivo).toBe('ideal')
  })

  it('atendimento cedo: o ideal cai antes da abertura e é empurrado', () => {
    // 07:00 menos 24h = 07:00 do dia anterior, antes das 08:00.
    const d = quandoEnviarLembrete(q('2026-08-12', '07:00'), q('2026-08-10', '09:00'))
    expect(d.enviar).toBe(true)
    if (!d.enviar) return
    expect(local(d.quando)).toBe('2026-08-11 08:00')
    expect(d.motivo).toBe('adiado_para_janela')
  })

  it('NUNCA agenda envio de madrugada', () => {
    // Plantão às 02:00: 24h antes é 02:00. Ninguém recebe mensagem às 2h.
    const d = quandoEnviarLembrete(q('2026-08-12', '02:00'), q('2026-08-09', '10:00'))
    expect(d.enviar).toBe(true)
    if (!d.enviar) return
    expect(horaLocal(d.quando, REGRA_PADRAO.fuso)).toBe('08:00')
    expect(dentroDaJanela(d.quando)).toBe(true)
  })

  it('marcado em cima da hora: envia agora, não no passado', () => {
    // Marcou hoje 16:00 para amanhã 09:00 — "24h antes" já passou.
    const agora = q('2026-08-10', '16:00')
    const d = quandoEnviarLembrete(q('2026-08-11', '09:00'), agora)
    expect(d.enviar).toBe(true)
    if (!d.enviar) return
    expect(d.quando.getTime()).toBe(agora.getTime())
    expect(d.motivo).toBe('imediato')
    expect(d.quando.getTime()).toBeGreaterThanOrEqual(agora.getTime())
  })

  it('processado de madrugada: espera a abertura, não sai às 4h', () => {
    // Atendimento hoje às 15:00, o job acordou às 04:00 de hoje. O ideal
    // (ontem 15:00) já passou, mas "imediato" não pode significar 04:00.
    const d = quandoEnviarLembrete(q('2026-08-11', '15:00'), q('2026-08-11', '04:00'))
    expect(d.enviar).toBe(true)
    if (!d.enviar) return
    expect(local(d.quando)).toBe('2026-08-11 08:00')
    expect(d.motivo).toBe('adiado_para_janela')
  })

  it('não envia lembrete de atendimento que já começou', () => {
    const d = quandoEnviarLembrete(q('2026-08-10', '09:00'), q('2026-08-10', '09:00'))
    expect(d).toEqual({ enviar: false, motivo: 'ja_passou' })

    const d2 = quandoEnviarLembrete(q('2026-08-09', '09:00'), q('2026-08-10', '09:00'))
    expect(d2).toEqual({ enviar: false, motivo: 'ja_passou' })
  })

  it('não envia quando falta menos que o mínimo — é caso de telefone', () => {
    // Falta 1h: o paciente não responde e a recepção não reage a tempo.
    const d = quandoEnviarLembrete(q('2026-08-10', '15:00'), q('2026-08-10', '14:00'))
    expect(d).toEqual({ enviar: false, motivo: 'muito_proximo' })
  })

  it('não finge que enviou quando a janela não alcança em tempo útil', () => {
    // Decidido às 22:00 para amanhã 09:00: próxima abertura 08:00, faltando 1h.
    const d = quandoEnviarLembrete(q('2026-08-11', '09:00'), q('2026-08-10', '22:00'))
    expect(d).toEqual({ enviar: false, motivo: 'sem_janela_util' })
  })

  it('quando decide enviar, o horário sempre respeita as duas regras', () => {
    // Varredura: todo atendimento de hora em hora, decidido em três momentos.
    const agoras = [q('2026-08-10', '06:00'), q('2026-08-10', '12:00'), q('2026-08-10', '23:30')]
    for (const agora of agoras) {
      for (let h = 0; h < 24 * 3; h++) {
        const inicio = new Date(q('2026-08-10', '00:00').getTime() + h * 3_600_000)
        const d = quandoEnviarLembrete(inicio, agora)
        if (!d.enviar) continue
        expect(dentroDaJanela(d.quando), `janela · ${local(d.quando)}`).toBe(true)
        expect(d.quando.getTime(), `não no passado · ${local(d.quando)}`).toBeGreaterThanOrEqual(
          agora.getTime(),
        )
        expect(
          inicio.getTime() - d.quando.getTime(),
          `sobra mínima · ${local(d.quando)}`,
        ).toBeGreaterThanOrEqual(REGRA_PADRAO.minimoHoras * 3_600_000)
        expect(d.quando.getTime(), 'nunca depois do atendimento').toBeLessThan(inicio.getTime())
      }
    }
  })

  it('regra incoerente é rejeitada', () => {
    const inicio = q('2026-08-12', '14:00')
    const agora = q('2026-08-10', '09:00')
    for (const ruim of [
      { antecedenciaHoras: 0 },
      { antecedenciaHoras: -1 },
      { minimoHoras: -1 },
      { minimoHoras: 24 },
      { minimoHoras: 48 },
    ]) {
      expect(
        () => quandoEnviarLembrete(inicio, agora, { ...REGRA_PADRAO, ...ruim }),
        JSON.stringify(ruim),
      ).toThrowError(ErroDominio)
    }
  })

  it('aceita antecedência configurada diferente de 24h', () => {
    const regra: RegraLembrete = { ...REGRA_PADRAO, antecedenciaHoras: 48 }
    const d = quandoEnviarLembrete(q('2026-08-12', '14:00'), q('2026-08-09', '09:00'), regra)
    expect(d.enviar).toBe(true)
    if (!d.enviar) return
    expect(local(d.quando)).toBe('2026-08-10 14:00')
  })
})
