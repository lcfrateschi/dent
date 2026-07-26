import { describe, expect, it } from 'vitest'
import {
  type AgendamentoExistente,
  type StatusAgendamento,
  conflita,
  encontrarConflitos,
  exigirIntervaloValido,
  exigirSemConflito,
  exigirTransicao,
  podeTransicionar,
} from './agendamento'
import { ErroDominio } from './erros'

const h = (hora: string) => new Date(`2026-08-10T${hora}:00-03:00`)

describe('máquina de estados do agendamento', () => {
  it('percorre o caminho feliz', () => {
    expect(podeTransicionar('agendado', 'confirmado')).toBe(true)
    expect(podeTransicionar('confirmado', 'em_atendimento')).toBe(true)
    expect(podeTransicionar('em_atendimento', 'concluido')).toBe(true)
  })

  it('permite atender sem confirmação prévia — paciente que aparece sem confirmar', () => {
    expect(podeTransicionar('agendado', 'em_atendimento')).toBe(true)
  })

  it('trata concluido e faltou como terminais', () => {
    for (const terminal of ['concluido', 'faltou', 'cancelado'] as const) {
      for (const destino of [
        'agendado',
        'confirmado',
        'em_atendimento',
        'concluido',
        'faltou',
        'cancelado',
      ] as StatusAgendamento[]) {
        expect(podeTransicionar(terminal, destino), `${terminal} → ${destino}`).toBe(false)
      }
    }
  })

  it('não deixa desfazer conclusão nem voltar atrás', () => {
    expect(podeTransicionar('concluido', 'em_atendimento')).toBe(false)
    expect(podeTransicionar('confirmado', 'agendado')).toBe(false)
    expect(podeTransicionar('em_atendimento', 'faltou')).toBe(false)
  })

  it('exige motivo para cancelar', () => {
    try {
      exigirTransicao('agendado', 'cancelado')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('CANCELAMENTO_SEM_MOTIVO')
    }
    expect(() => exigirTransicao('agendado', 'cancelado', { motivoCancelamento: '   ' })).toThrowError(
      ErroDominio,
    )
    expect(() =>
      exigirTransicao('agendado', 'cancelado', { motivoCancelamento: 'paciente pediu' }),
    ).not.toThrow()
  })

  it('dá erro específico para estado final e para transição redundante', () => {
    try {
      exigirTransicao('concluido', 'faltou')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('TRANSICAO_INVALIDA')
      expect((e as Error).message).toContain('estado final')
    }
    try {
      exigirTransicao('agendado', 'agendado')
      expect.unreachable('deveria ter lançado')
    } catch (e) {
      expect((e as ErroDominio).codigo).toBe('TRANSICAO_REDUNDANTE')
    }
  })
})

describe('sobreposição de intervalos', () => {
  it('é meio-aberta: encostar não é conflitar', () => {
    // 09:00–10:00 e 10:00–11:00 são consecutivos, não sobrepostos.
    expect(conflita({ inicio: h('09:00'), fim: h('10:00') }, { inicio: h('10:00'), fim: h('11:00') })).toBe(false)
  })

  it('detecta sobreposição parcial nos dois sentidos', () => {
    const a = { inicio: h('09:00'), fim: h('10:00') }
    expect(conflita(a, { inicio: h('09:30'), fim: h('10:30') })).toBe(true)
    expect(conflita({ inicio: h('08:30'), fim: h('09:30') }, a)).toBe(true)
  })

  it('detecta contenção e identidade', () => {
    const a = { inicio: h('09:00'), fim: h('11:00') }
    expect(conflita(a, { inicio: h('09:30'), fim: h('10:00') })).toBe(true)
    expect(conflita({ inicio: h('09:30'), fim: h('10:00') }, a)).toBe(true)
    expect(conflita(a, a)).toBe(true)
  })

  it('rejeita intervalo invertido ou de duração zero', () => {
    expect(() => exigirIntervaloValido({ inicio: h('10:00'), fim: h('09:00') })).toThrowError(ErroDominio)
    expect(() => exigirIntervaloValido({ inicio: h('10:00'), fim: h('10:00') })).toThrowError(ErroDominio)
    expect(() => exigirIntervaloValido({ inicio: new Date('x'), fim: h('10:00') })).toThrowError(ErroDominio)
  })
})

const PROF_A = 'prof-a'
const PROF_B = 'prof-b'
const CADEIRA_1 = 'cadeira-1'
const CADEIRA_2 = 'cadeira-2'

function existente(over: Partial<AgendamentoExistente> = {}): AgendamentoExistente {
  return {
    id: 'ag-1',
    profissionalId: PROF_A,
    cadeiraId: CADEIRA_1,
    status: 'agendado',
    inicio: h('09:00'),
    fim: h('10:00'),
    ...over,
  }
}

describe('conflitos na agenda', () => {
  it('acusa conflito de profissional', () => {
    const c = encontrarConflitos(
      { profissionalId: PROF_A, cadeiraId: CADEIRA_2, inicio: h('09:30'), fim: h('10:30') },
      [existente()],
    )
    expect(c).toEqual([{ agendamentoId: 'ag-1', motivo: 'profissional' }])
  })

  it('acusa conflito de cadeira mesmo com profissional diferente', () => {
    const c = encontrarConflitos(
      { profissionalId: PROF_B, cadeiraId: CADEIRA_1, inicio: h('09:30'), fim: h('10:30') },
      [existente()],
    )
    expect(c).toEqual([{ agendamentoId: 'ag-1', motivo: 'cadeira' }])
  })

  it('libera quando profissional e cadeira são outros', () => {
    expect(
      encontrarConflitos(
        { profissionalId: PROF_B, cadeiraId: CADEIRA_2, inicio: h('09:30'), fim: h('10:30') },
        [existente()],
      ),
    ).toEqual([])
  })

  it('cancelado e falta liberam o horário — mesma regra da EXCLUDE constraint', () => {
    for (const status of ['cancelado', 'faltou'] as const) {
      expect(
        encontrarConflitos(
          { profissionalId: PROF_A, cadeiraId: CADEIRA_1, inicio: h('09:00'), fim: h('10:00') },
          [existente({ status })],
        ),
        `status ${status} deveria liberar`,
      ).toEqual([])
    }
  })

  it('concluído continua ocupando — o histórico não some da grade', () => {
    expect(
      encontrarConflitos(
        { profissionalId: PROF_A, cadeiraId: CADEIRA_1, inicio: h('09:00'), fim: h('10:00') },
        [existente({ status: 'concluido' })],
      ),
    ).toHaveLength(1)
  })

  it('ao reagendar, o próprio agendamento não conflita consigo', () => {
    expect(
      encontrarConflitos(
        { id: 'ag-1', profissionalId: PROF_A, cadeiraId: CADEIRA_1, inicio: h('09:15'), fim: h('10:15') },
        [existente()],
      ),
    ).toEqual([])
  })

  it('candidato sem cadeira só conflita por profissional', () => {
    expect(
      encontrarConflitos(
        { profissionalId: PROF_B, cadeiraId: null, inicio: h('09:00'), fim: h('10:00') },
        [existente()],
      ),
    ).toEqual([])
  })

  it('acumula conflitos de vários agendamentos', () => {
    const c = encontrarConflitos(
      { profissionalId: PROF_A, cadeiraId: CADEIRA_1, inicio: h('09:00'), fim: h('12:00') },
      [
        existente({ id: 'ag-1', inicio: h('09:00'), fim: h('10:00') }),
        existente({ id: 'ag-2', inicio: h('10:00'), fim: h('11:00') }),
        existente({ id: 'ag-3', inicio: h('14:00'), fim: h('15:00') }),
      ],
    )
    expect(c.map((x) => x.agendamentoId)).toEqual(['ag-1', 'ag-2'])
  })

  it('exigirSemConflito lança com mensagem por motivo', () => {
    expect(() =>
      exigirSemConflito(
        { profissionalId: PROF_A, cadeiraId: CADEIRA_2, inicio: h('09:30'), fim: h('10:30') },
        [existente()],
      ),
    ).toThrowError(/profissional já tem atendimento/)

    expect(() =>
      exigirSemConflito(
        { profissionalId: PROF_B, cadeiraId: CADEIRA_1, inicio: h('09:30'), fim: h('10:30') },
        [existente()],
      ),
    ).toThrowError(/cadeira já está ocupada/)
  })
})
