import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import {
  FUSO_PADRAO,
  diaLocalIso,
  hhmmParaMinutos,
  horaLocal,
  inicioDoDia,
  instanteDe,
  minutosDoDia,
  minutosParaHhmm,
  offsetMinutos,
  paraInstante,
  partesLocais,
} from './fuso'

describe('partes locais', () => {
  it('quebra o instante no calendário da clínica, não do servidor', () => {
    // 2026-09-01T12:00Z é 09:00 em São Paulo (UTC-3).
    const l = partesLocais(new Date('2026-09-01T12:00:00Z'), FUSO_PADRAO)
    expect(l).toMatchObject({ ano: 2026, mes: 9, dia: 1, hora: 9, minuto: 0 })
  })

  it('vira o dia corretamente na borda', () => {
    // 2026-09-02T02:00Z ainda é dia 1 às 23:00 em São Paulo.
    const l = partesLocais(new Date('2026-09-02T02:00:00Z'), FUSO_PADRAO)
    expect(l).toMatchObject({ dia: 1, hora: 23 })
    expect(diaLocalIso(new Date('2026-09-02T02:00:00Z'))).toBe('2026-09-01')
  })

  it('trata meia-noite local como hora 0, não 24', () => {
    // 2026-09-01T03:00Z = 00:00 em São Paulo.
    const l = partesLocais(new Date('2026-09-01T03:00:00Z'), FUSO_PADRAO)
    expect(l.hora).toBe(0)
    expect(horaLocal(new Date('2026-09-01T03:00:00Z'))).toBe('00:00')
  })

  it('calcula o dia da semana do calendário local', () => {
    // 2026-09-01 é uma terça-feira.
    expect(partesLocais(new Date('2026-09-01T12:00:00Z')).diaSemana).toBe(2)
    // Instante que no UTC já é quarta, mas localmente ainda é terça.
    expect(partesLocais(new Date('2026-09-02T02:00:00Z')).diaSemana).toBe(2)
  })

  it('funciona em outro fuso, para clínica fora de SP', () => {
    const l = partesLocais(new Date('2026-09-01T12:00:00Z'), 'America/Manaus') // UTC-4
    expect(l.hora).toBe(8)
  })

  it('rejeita fuso desconhecido e instante inválido', () => {
    expect(() => partesLocais(new Date('2026-09-01T12:00:00Z'), 'Marte/Olympus')).toThrowError(
      ErroDominio,
    )
    expect(() => partesLocais(new Date('nao-e-data'))).toThrowError(ErroDominio)
  })
})

describe('offset', () => {
  it('devolve -180 para o horário de Brasília', () => {
    expect(offsetMinutos(new Date('2026-09-01T12:00:00Z'), FUSO_PADRAO)).toBe(-180)
    // O Brasil aboliu o horário de verão em 2019: janeiro também é -180.
    expect(offsetMinutos(new Date('2026-01-15T12:00:00Z'), FUSO_PADRAO)).toBe(-180)
  })

  it('devolve -240 para Manaus e 0 para UTC', () => {
    expect(offsetMinutos(new Date('2026-09-01T12:00:00Z'), 'America/Manaus')).toBe(-240)
    expect(offsetMinutos(new Date('2026-09-01T12:00:00Z'), 'UTC')).toBe(0)
  })
})

describe('ida e volta', () => {
  it('local → instante → local devolve o mesmo horário', () => {
    const casos = [
      { ano: 2026, mes: 9, dia: 1, hora: 8, minuto: 0 },
      { ano: 2026, mes: 1, dia: 1, hora: 0, minuto: 0 },
      { ano: 2026, mes: 12, dia: 31, hora: 23, minuto: 59 },
      { ano: 2028, mes: 2, dia: 29, hora: 14, minuto: 30 },
    ]
    for (const local of casos) {
      const instante = paraInstante(local, FUSO_PADRAO)
      const volta = partesLocais(instante, FUSO_PADRAO)
      expect(volta, JSON.stringify(local)).toMatchObject(local)
    }
  })

  it('mantém a ida e volta em fuso com horário de verão ativo', () => {
    // Lisboa muda de hora: verificar que a segunda passada corrige o offset.
    for (const local of [
      { ano: 2026, mes: 3, dia: 29, hora: 14, minuto: 0 },
      { ano: 2026, mes: 10, dia: 25, hora: 14, minuto: 0 },
      { ano: 2026, mes: 7, dia: 15, hora: 9, minuto: 30 },
    ]) {
      const volta = partesLocais(paraInstante(local, 'Europe/Lisbon'), 'Europe/Lisbon')
      expect(volta, JSON.stringify(local)).toMatchObject(local)
    }
  })

  it('08:00 em São Paulo é 11:00 UTC', () => {
    const i = instanteDe('2026-09-01', '08:00', FUSO_PADRAO)
    expect(i.toISOString()).toBe('2026-09-01T11:00:00.000Z')
  })

  it('início do dia local é 03:00 UTC em São Paulo', () => {
    expect(inicioDoDia('2026-09-01', FUSO_PADRAO).toISOString()).toBe('2026-09-01T03:00:00.000Z')
  })
})

describe('minutos do dia — coordenada Y da grade', () => {
  it('conta desde a meia-noite local', () => {
    expect(minutosDoDia(instanteDe('2026-09-01', '00:00'))).toBe(0)
    expect(minutosDoDia(instanteDe('2026-09-01', '08:00'))).toBe(480)
    expect(minutosDoDia(instanteDe('2026-09-01', '13:30'))).toBe(810)
    expect(minutosDoDia(instanteDe('2026-09-01', '23:59'))).toBe(1439)
  })

  it('não depende do fuso do servidor', () => {
    // O mesmo instante dá minutos diferentes em fusos diferentes — e é isso
    // que torna obrigatório passar o fuso da clínica explicitamente.
    const i = new Date('2026-09-01T12:00:00Z')
    expect(minutosDoDia(i, 'America/Sao_Paulo')).toBe(9 * 60)
    expect(minutosDoDia(i, 'America/Manaus')).toBe(8 * 60)
    expect(minutosDoDia(i, 'UTC')).toBe(12 * 60)
  })
})

describe('conversão HH:MM', () => {
  it('converte nos dois sentidos', () => {
    expect(hhmmParaMinutos('08:00')).toBe(480)
    expect(hhmmParaMinutos('8:00')).toBe(480)
    expect(hhmmParaMinutos('00:00')).toBe(0)
    expect(hhmmParaMinutos('23:59')).toBe(1439)
    expect(minutosParaHhmm(480)).toBe('08:00')
    expect(minutosParaHhmm(0)).toBe('00:00')
    expect(minutosParaHhmm(1439)).toBe('23:59')
  })

  it('rejeita entrada inválida', () => {
    for (const ruim of ['', '8', '25:00', '08:60', 'oito', '08-00']) {
      expect(() => hhmmParaMinutos(ruim), `"${ruim}"`).toThrowError(ErroDominio)
    }
    expect(() => minutosParaHhmm(-1)).toThrowError(ErroDominio)
  })

  it('rejeita data malformada', () => {
    for (const ruim of ['', '01/09/2026', '2026-9-1']) {
      expect(() => instanteDe(ruim, '08:00'), `"${ruim}"`).toThrowError(ErroDominio)
    }
  })
})
