import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import { minutosParaHhmm } from './fuso'
import {
  type DiaSemana,
  HORARIO_PADRAO,
  type HorarioFuncionamento,
  abreNoDia,
  dentroDoFuncionamento,
  descreverDia,
  exigirHorarioValido,
  faixasDoDia,
  horariosPossiveis,
  limitesDaGrade,
  minutosDisponiveis,
} from './horario'

const TODOS_OS_DIAS: DiaSemana[] = [0, 1, 2, 3, 4, 5, 6]

describe('horário padrão de consultório', () => {
  it('fecha no domingo e abre de segunda a sábado', () => {
    expect(abreNoDia(HORARIO_PADRAO, 0)).toBe(false)
    for (const dia of [1, 2, 3, 4, 5, 6] as DiaSemana[]) {
      expect(abreNoDia(HORARIO_PADRAO, dia), `dia ${dia}`).toBe(true)
    }
  })

  it('tem duas faixas nos dias de semana — o almoço é a regra, não a exceção', () => {
    expect(faixasDoDia(HORARIO_PADRAO, 1)).toHaveLength(2)
    // Sábado só de manhã.
    expect(faixasDoDia(HORARIO_PADRAO, 6)).toHaveLength(1)
  })

  it('descreve o dia de forma legível', () => {
    expect(descreverDia(HORARIO_PADRAO, 1)).toBe('08:00–12:00 e 13:00–18:00')
    expect(descreverDia(HORARIO_PADRAO, 6)).toBe('08:00–12:00')
    expect(descreverDia(HORARIO_PADRAO, 0)).toBe('Fechado')
  })

  it('soma os minutos de atendimento do dia', () => {
    expect(minutosDisponiveis(HORARIO_PADRAO, 1)).toBe(240 + 300) // 4h + 5h
    expect(minutosDisponiveis(HORARIO_PADRAO, 6)).toBe(240)
    expect(minutosDisponiveis(HORARIO_PADRAO, 0)).toBe(0)
  })
})

describe('atendimento dentro do funcionamento', () => {
  it('aceita intervalo inteiro dentro de uma faixa', () => {
    // 09:00–10:00 na segunda.
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 1, 540, 600)).toBe(true)
    // Encostando exatamente no fechamento da manhã.
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 1, 660, 720)).toBe(true)
  })

  it('RECUSA atendimento que atravessa o almoço', () => {
    // 11:30–13:30: metade antes e metade depois do intervalo.
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 1, 690, 810)).toBe(false)
    // Inteiramente no almoço.
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 1, 750, 780)).toBe(false)
  })

  it('recusa antes de abrir e depois de fechar', () => {
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 1, 420, 480)).toBe(false) // 07:00
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 1, 1060, 1120)).toBe(false) // 17:40–18:40
  })

  it('recusa qualquer horário em dia fechado', () => {
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 0, 540, 600)).toBe(false)
  })

  it('recusa tarde no sábado, que fecha ao meio-dia', () => {
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 6, 540, 600)).toBe(true)
    expect(dentroDoFuncionamento(HORARIO_PADRAO, 6, 840, 900)).toBe(false)
  })
})

describe('limites da grade', () => {
  it('usa a abertura mais cedo e o fechamento mais tarde da semana', () => {
    const l = limitesDaGrade(HORARIO_PADRAO, TODOS_OS_DIAS)
    expect(l).toEqual({ inicioMin: 480, fimMin: 1080 }) // 08:00 às 18:00
  })

  it('não deixa o sábado cortar a tarde dos outros dias', () => {
    // Se olhasse dia a dia, o sábado (fecha 12:00) encurtaria a grade.
    const l = limitesDaGrade(HORARIO_PADRAO, [6, 1])
    expect(l.fimMin).toBe(1080)
  })

  it('abrange horário estendido de um dia só', () => {
    const comNoturno: HorarioFuncionamento = {
      ...HORARIO_PADRAO,
      3: [{ inicio: '07:00', fim: '21:00' }],
    }
    const l = limitesDaGrade(comNoturno, TODOS_OS_DIAS)
    expect(l).toEqual({ inicioMin: 420, fimMin: 1260 })
  })

  it('cai num padrão comercial quando nada está aberto — grade não pode ter altura zero', () => {
    const fechado: HorarioFuncionamento = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
    expect(limitesDaGrade(fechado, TODOS_OS_DIAS)).toEqual({ inicioMin: 480, fimMin: 1080 })
    expect(limitesDaGrade(HORARIO_PADRAO, [0])).toEqual({ inicioMin: 480, fimMin: 1080 })
  })
})

describe('horários possíveis para agendar', () => {
  it('fatia as duas faixas em passos de 15 minutos', () => {
    const h = horariosPossiveis({ horario: HORARIO_PADRAO, diaSemana: 1, duracaoMin: 30 })
    // Manhã: 08:00 até 11:30 (último que termina 12:00) = 15 opções.
    // Tarde: 13:00 até 17:30 = 19 opções.
    expect(h).toHaveLength(15 + 19)
    expect(minutosParaHhmm(h[0]!)).toBe('08:00')
    expect(minutosParaHhmm(h[14]!)).toBe('11:30')
    expect(minutosParaHhmm(h[15]!)).toBe('13:00')
    expect(minutosParaHhmm(h[h.length - 1]!)).toBe('17:30')
  })

  it('não oferece horário em que o atendimento não cabe inteiro', () => {
    // 90 minutos: o último da manhã é 10:30 (termina 12:00).
    const h = horariosPossiveis({ horario: HORARIO_PADRAO, diaSemana: 1, duracaoMin: 90 })
    const manha = h.filter((m) => m < 720).map(minutosParaHhmm)
    expect(manha[manha.length - 1]).toBe('10:30')
    // Nenhum horário permite atravessar o almoço.
    expect(h.some((m) => m + 90 > 720 && m < 780)).toBe(false)
  })

  it('não oferece nada quando a duração não cabe em faixa nenhuma', () => {
    // 6 horas não cabem nem na manhã (4h) nem na tarde (5h).
    expect(horariosPossiveis({ horario: HORARIO_PADRAO, diaSemana: 1, duracaoMin: 360 })).toEqual([])
  })

  it('não oferece nada em dia fechado', () => {
    expect(horariosPossiveis({ horario: HORARIO_PADRAO, diaSemana: 0, duracaoMin: 30 })).toEqual([])
  })

  it('alinha ao passo a partir da ABERTURA, não da meia-noite', () => {
    // Clínica que abre 08:10 deve oferecer 08:10, não 08:15.
    const h = horariosPossiveis({
      horario: { ...HORARIO_PADRAO, 1: [{ inicio: '08:10', fim: '12:00' }] },
      diaSemana: 1,
      duracaoMin: 30,
    })
    expect(minutosParaHhmm(h[0]!)).toBe('08:10')
    expect(minutosParaHhmm(h[1]!)).toBe('08:25')
  })

  it('respeita passo customizado', () => {
    const h = horariosPossiveis({
      horario: { ...HORARIO_PADRAO, 1: [{ inicio: '08:00', fim: '09:00' }] },
      diaSemana: 1,
      duracaoMin: 30,
      passoMin: 30,
    })
    expect(h.map(minutosParaHhmm)).toEqual(['08:00', '08:30'])
  })

  it('rejeita duração e passo inválidos', () => {
    expect(() =>
      horariosPossiveis({ horario: HORARIO_PADRAO, diaSemana: 1, duracaoMin: 0 }),
    ).toThrowError(ErroDominio)
    expect(() =>
      horariosPossiveis({ horario: HORARIO_PADRAO, diaSemana: 1, duracaoMin: 30, passoMin: 0 }),
    ).toThrowError(ErroDominio)
  })
})

describe('validação da configuração', () => {
  it('aceita o padrão', () => {
    expect(() => exigirHorarioValido(HORARIO_PADRAO)).not.toThrow()
  })

  it('recusa faixa com fim antes do início', () => {
    try {
      exigirHorarioValido({ ...HORARIO_PADRAO, 1: [{ inicio: '18:00', fim: '08:00' }] })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('FAIXA_INVERTIDA')
      expect((e as Error).message).toContain('Segunda')
    }
  })

  it('recusa faixas sobrepostas — o mesmo minuto seria contado duas vezes', () => {
    try {
      exigirHorarioValido({
        ...HORARIO_PADRAO,
        2: [{ inicio: '08:00', fim: '13:00' }, { inicio: '12:00', fim: '18:00' }],
      })
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('FAIXAS_SOBREPOSTAS')
      expect((e as Error).message).toContain('Terça')
    }
  })

  it('recusa faixas fora de ordem', () => {
    expect(() =>
      exigirHorarioValido({
        ...HORARIO_PADRAO,
        3: [{ inicio: '13:00', fim: '18:00' }, { inicio: '08:00', fim: '12:00' }],
      }),
    ).toThrowError(ErroDominio)
  })

  it('aceita dia fechado e dia com faixa única', () => {
    expect(() =>
      exigirHorarioValido({ ...HORARIO_PADRAO, 4: [], 5: [{ inicio: '08:00', fim: '18:00' }] }),
    ).not.toThrow()
  })
})
