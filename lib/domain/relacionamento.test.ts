import { describe, expect, it } from 'vitest'
import {
  PRAZOS_EM_DIAS,
  type TipoTarefa,
  chaveDaTarefa,
  contatoEncerra,
  contatoResolve,
  dataDoRetorno,
  exigirMotivoDeDispensa,
  podeContatar,
  podeTransitar,
  prazoDaTarefa,
  urgenciaDaTarefa,
} from './relacionamento'
import { ErroDominio } from './erros'

describe('chave de idempotência', () => {
  it('é uma por FATO, não uma por tarefa aberta', () => {
    // Este é o teste que descreve a fase inteira. A mesma referência produz sempre
    // a mesma chave, então a segunda geração colide — inclusive quando a tarefa
    // existente está DISPENSADA. Se a chave levasse data, ou situação, ou um
    // contador, a tarefa dispensada voltaria na próxima passada do despachante.
    const a = chaveDaTarefa('orcamento_sem_resposta', 'b1ffc99a-9c0b-4ef8-bb6d-6bb9bd380a11')
    const b = chaveDaTarefa('orcamento_sem_resposta', 'b1ffc99a-9c0b-4ef8-bb6d-6bb9bd380a11')
    expect(a).toBe(b)
  })

  it('separa tipos sobre a mesma referência', () => {
    // Cenário real: o agendamento que gerou "faltou" é o mesmo que um dia poderá
    // gerar outra coisa. Sem o tipo no prefixo, o segundo gerador ficaria em
    // silêncio para sempre, porque colidiria com a chave do primeiro.
    const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
    expect(chaveDaTarefa('falta_sem_remarcar', id)).not.toBe(
      chaveDaTarefa('retorno_programado', id),
    )
  })

  it('recusa referência vazia', () => {
    expect(() => chaveDaTarefa('inadimplencia', '')).toThrowError(ErroDominio)
    expect(() => chaveDaTarefa('inadimplencia', '   ')).toThrowError(ErroDominio)
  })
})

describe('data do retorno', () => {
  it('conta em MESES do calendário, não em 30 dias', () => {
    // Raspagem em 31 de janeiro com retorno de 1 mês é 28 de fevereiro. Contar
    // "30 dias" daria 2 de março, e o paciente seria chamado depois do intervalo
    // clínico que o dentista definiu.
    expect(dataDoRetorno('2026-01-31', 1)).toBe('2026-02-28')
    expect(dataDoRetorno('2026-01-15', 6)).toBe('2026-07-15')
    expect(dataDoRetorno('2026-08-31', 6)).toBe('2027-02-28')
  })

  it('recusa intervalo inválido', () => {
    expect(() => dataDoRetorno('2026-01-31', 0)).toThrowError(ErroDominio)
    expect(() => dataDoRetorno('2026-01-31', -6)).toThrowError(ErroDominio)
    expect(() => dataDoRetorno('2026-01-31', 1.5)).toThrowError(ErroDominio)
  })
})

describe('prazo da tarefa', () => {
  it('soma o prazo do tipo à data do fato', () => {
    expect(prazoDaTarefa('falta_sem_remarcar', '2026-07-27')).toBe('2026-07-29')
    expect(prazoDaTarefa('orcamento_sem_resposta', '2026-07-27')).toBe('2026-08-03')
  })

  it('retorno programado vence NA data devida, sem folga', () => {
    // A folga já está no intervalo clínico: somar dias em cima atrasaria a
    // profilaxia de seis meses de propósito.
    expect(PRAZOS_EM_DIAS.retorno_programado).toBe(0)
    expect(prazoDaTarefa('retorno_programado', '2026-07-27')).toBe('2026-07-27')
  })

  it('todo tipo tem prazo declarado', () => {
    // Guarda contra tipo novo sem prazo: `PRAZOS_EM_DIAS[tipo]` devolveria
    // `undefined`, `addDias` receberia NaN e a tarefa nasceria com prazo inválido.
    const tipos: readonly TipoTarefa[] = [
      'orcamento_sem_resposta',
      'inadimplencia',
      'aprovado_nao_executado',
      'falta_sem_remarcar',
      'retorno_programado',
    ]
    for (const t of tipos) expect(Number.isInteger(PRAZOS_EM_DIAS[t]), t).toBe(true)
    expect(Object.keys(PRAZOS_EM_DIAS)).toHaveLength(tipos.length)
  })
})

describe('não incomodar', () => {
  it('o dia pedido AINDA não pode', () => {
    // "Não me liguem até dia 30" inclui o dia 30. A versão exclusiva produziria
    // exatamente uma ligação: no único dia em que a pessoa lembra do pedido.
    expect(podeContatar('2026-07-30', '2026-07-30')).toBe(false)
    expect(podeContatar('2026-07-30', '2026-07-29')).toBe(false)
    expect(podeContatar('2026-07-30', '2026-07-31')).toBe(true)
  })

  it('sem pedido, pode', () => {
    expect(podeContatar(null, '2026-07-30')).toBe(true)
  })
})

describe('resultado do contato', () => {
  it('"não quer" e "número errado" encerram; os outros não', () => {
    expect(contatoEncerra('nao_quer')).toBe(true)
    expect(contatoEncerra('numero_errado')).toBe(true)
    // `nao_atendeu` parece próximo de `nao_quer` e é o oposto operacional: pede
    // outra tentativa. Uma lista com só "sem sucesso" faria a recepção desistir de
    // quem só estava no banho.
    expect(contatoEncerra('nao_atendeu')).toBe(false)
    expect(contatoEncerra('falou')).toBe(false)
    expect(contatoEncerra('remarcou')).toBe(false)
  })

  it('só "remarcou" resolve — falar não é resolver', () => {
    expect(contatoResolve('remarcou')).toBe(true)
    // Conversa boa que não virou horário marcado não fecha a fila. Se fechasse, o
    // indicador de recuperação contaria como recuperado quem nunca voltou.
    expect(contatoResolve('falou')).toBe(false)
  })
})

describe('transições', () => {
  it('abre → em andamento → resolvida', () => {
    expect(podeTransitar('aberta', 'em_andamento')).toEqual({ ok: true, situacao: 'em_andamento' })
    expect(podeTransitar('em_andamento', 'resolvida')).toEqual({ ok: true, situacao: 'resolvida' })
  })

  it('devolver para a fila é permitido', () => {
    expect(podeTransitar('em_andamento', 'aberta')).toEqual({ ok: true, situacao: 'aberta' })
  })

  it('DISPENSADA não reabre — nem para aberta, nem para em_andamento', () => {
    // A trava mais importante do arquivo. A chave de idempotência usa
    // `dispensada` como "já tratamos disto"; reabrir por clique deixaria uma
    // tarefa aberta cuja chave já existe, e o gerador — que é o dono da criação —
    // não teria como saber.
    expect(podeTransitar('dispensada', 'aberta').ok).toBe(false)
    expect(podeTransitar('dispensada', 'em_andamento').ok).toBe(false)
    expect(podeTransitar('dispensada', 'resolvida').ok).toBe(false)
    expect(podeTransitar('dispensada', 'aberta')).toMatchObject({
      motivo: expect.stringContaining('não reabre'),
    })
  })

  it('RESOLVIDA também não reabre', () => {
    expect(podeTransitar('resolvida', 'aberta').ok).toBe(false)
    expect(podeTransitar('resolvida', 'em_andamento').ok).toBe(false)
  })

  it('para a MESMA situação é idempotente, não erro', () => {
    // Duplo clique em "dispensar" não deve virar mensagem de erro na cara da
    // recepção — o efeito pretendido já aconteceu.
    expect(podeTransitar('dispensada', 'dispensada').ok).toBe(true)
    expect(podeTransitar('aberta', 'aberta').ok).toBe(true)
  })
})

describe('motivo da dispensa', () => {
  it('exige texto com substância', () => {
    expect(exigirMotivoDeDispensa('Paciente pediu para não ligar mais')).toBe(
      'Paciente pediu para não ligar mais',
    )
    expect(() => exigirMotivoDeDispensa(null)).toThrowError(ErroDominio)
    expect(() => exigirMotivoDeDispensa('')).toThrowError(ErroDominio)
    expect(() => exigirMotivoDeDispensa('  ')).toThrowError(ErroDominio)
    // Dois caracteres é o "ok" que alguém digita para passar da validação.
    expect(() => exigirMotivoDeDispensa('ok')).toThrowError(ErroDominio)
  })

  it('devolve aparado, para o CHECK do banco não receber espaço', () => {
    expect(exigirMotivoDeDispensa('  mudou de cidade  ')).toBe('mudou de cidade')
  })
})

describe('urgência', () => {
  it('separa atrasada, vence hoje e no prazo', () => {
    expect(urgenciaDaTarefa('2026-07-26', '2026-07-27')).toBe('atrasada')
    expect(urgenciaDaTarefa('2026-07-27', '2026-07-27')).toBe('vence_hoje')
    expect(urgenciaDaTarefa('2026-07-28', '2026-07-27')).toBe('no_prazo')
  })
})
