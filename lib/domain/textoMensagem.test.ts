import { describe, expect, it } from 'vitest'
import { ErroDominio } from './erros'
import { instanteDe } from './fuso'
import {
  chaveLembrete,
  chaveRetorno,
  parametrosLembrete,
  primeiroNome,
  quandoEmPortugues,
  textoCancelado,
  textoConfirmado,
  textoLembrete,
  textoNaoEntendido,
} from './textoMensagem'

const INICIO = instanteDe('2026-08-13', '14:00') // quinta-feira

const DADOS = {
  pacienteNome: 'Maria Aparecida da Silva Santos',
  profissionalNome: 'Dra. Helena Marques',
  clinicaNome: 'Clínica Sorriso',
  inicio: INICIO,
}

describe('primeiro nome', () => {
  it('usa só o primeiro nome', () => {
    expect(primeiroNome('Maria Aparecida da Silva')).toBe('Maria')
    expect(primeiroNome('  João   Pedro  ')).toBe('João')
    expect(primeiroNome('Ana')).toBe('Ana')
  })

  it('rejeita nome vazio', () => {
    expect(() => primeiroNome('   ')).toThrowError(ErroDominio)
  })
})

describe('chave de idempotência', () => {
  it('é estável para o mesmo agendamento no mesmo horário', () => {
    expect(chaveLembrete('abc', INICIO)).toBe(chaveLembrete('abc', INICIO))
  })

  it('MUDA quando o atendimento é remarcado', () => {
    // É o que faz o horário novo receber lembrete próprio.
    const outro = instanteDe('2026-08-14', '14:00')
    expect(chaveLembrete('abc', outro)).not.toBe(chaveLembrete('abc', INICIO))
  })

  it('separa agendamentos diferentes', () => {
    expect(chaveLembrete('a', INICIO)).not.toBe(chaveLembrete('b', INICIO))
  })

  it('não depende do fuso de quem gera', () => {
    // ISO é UTC: dois servidores em fusos diferentes geram a mesma chave.
    expect(chaveLembrete('abc', INICIO)).toContain(INICIO.toISOString())
  })

  it('rejeita entrada inválida', () => {
    expect(() => chaveLembrete('', INICIO)).toThrowError(ErroDominio)
    expect(() => chaveLembrete('abc', new Date('nada'))).toThrowError(ErroDominio)
    expect(() => chaveRetorno(' ')).toThrowError(ErroDominio)
  })

  it('chaves de tipos diferentes não colidem', () => {
    expect(chaveRetorno('abc')).not.toBe(chaveLembrete('abc', INICIO))
  })
})

describe('quando em português', () => {
  it('diz o dia da semana junto com a data', () => {
    expect(quandoEmPortugues(INICIO)).toBe('quinta-feira, 13/08 às 14:00')
  })

  it('zero-pad em dia e mês de um dígito', () => {
    expect(quandoEmPortugues(instanteDe('2026-09-07', '09:30'))).toBe(
      'segunda-feira, 07/09 às 09:30',
    )
  })

  it('usa o dia local da clínica, não o UTC', () => {
    // 21:00 em São Paulo é 00:00 do dia seguinte em UTC.
    expect(quandoEmPortugues(instanteDe('2026-08-13', '21:00'))).toContain('13/08')
  })
})

describe('texto do lembrete', () => {
  const texto = textoLembrete(DADOS)

  it('cumprimenta pelo primeiro nome', () => {
    expect(texto).toContain('Olá, Maria!')
    expect(texto).not.toContain('Aparecida')
  })

  it('traz data, hora, dia da semana e profissional', () => {
    expect(texto).toContain('quinta-feira, 13/08 às 14:00')
    expect(texto).toContain('Dra. Helena Marques')
    expect(texto).toContain('Clínica Sorriso')
  })

  it('instrui como responder', () => {
    expect(texto).toContain('SIM')
    expect(texto).toContain('NÃO')
  })

  it('a instrução do texto é entendida pelo interpretador', async () => {
    // As duas metades do fluxo têm de concordar: se o texto pede SIM/NÃO,
    // `interpretarResposta` precisa aceitar exatamente isso.
    const { interpretarResposta } = await import('./whatsapp')
    expect(interpretarResposta('SIM')).toBe('confirmou')
    expect(interpretarResposta('NÃO')).toBe('cancelou')
  })

  it('NÃO menciona procedimento nem diagnóstico', () => {
    // Dado de saúde não vai para o WhatsApp — a tela do celular é pública.
    const comProcedimento = textoLembrete({ ...DADOS, profissionalNome: 'Dra. Helena' })
    for (const proibido of ['canal', 'extração', 'coroa', 'restauração', 'cárie', 'implante']) {
      expect(comProcedimento.toLowerCase(), proibido).not.toContain(proibido)
    }
  })

  it('caberia numa mensagem curta', () => {
    expect(texto.length).toBeLessThan(400)
  })
})

describe('template da Meta', () => {
  it('os parâmetros seguem a ordem cadastrada', () => {
    expect(parametrosLembrete(DADOS)).toEqual([
      'Maria',
      'Clínica Sorriso',
      'quinta-feira, 13/08 às 14:00',
      'Dra. Helena Marques',
    ])
  })

  it('nenhum parâmetro vem vazio — a Meta rejeita', () => {
    for (const p of parametrosLembrete(DADOS)) {
      expect(p.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('respostas automáticas', () => {
  it('confirmação fecha o assunto com data', () => {
    const t = textoConfirmado(DADOS)
    expect(t).toContain('Maria')
    expect(t).toContain('confirmada')
    expect(t).toContain('13/08')
  })

  it('cancelamento não promete horário novo', () => {
    const t = textoCancelado(DADOS)
    expect(t).toContain('cancelada')
    expect(t).toContain('recepção')
    // Prometer remarcação automática cria paciente que acha que tem horário.
    expect(t).not.toMatch(/remarcad[oa]|novo horário/i)
  })

  it('não entendido é honesto e repete a instrução', () => {
    const t = textoNaoEntendido(DADOS)
    expect(t).toContain('não consegui entender')
    expect(t).toContain('recepção')
    expect(t).toContain('SIM')
  })
})
