import { FUSO_PADRAO, instanteDe } from '@/lib/domain/fuso'
import { HORARIO_PADRAO, type HorarioFuncionamento } from '@/lib/domain/horario'
import { describe, expect, it } from 'vitest'
import {
  type ItemGrade,
  agruparPorDia,
  empacotarFaixas,
  estruturaDaSemana,
  estruturaDoDia,
  inicioDaSemana,
  posicaoDoAgora,
} from './grade'

const DIA = '2026-09-01' // terça-feira

function item(id: string, de: string, ate: string, dia = DIA): ItemGrade {
  return { id, inicio: instanteDe(dia, de, FUSO_PADRAO), fim: instanteDe(dia, ate, FUSO_PADRAO) }
}

function empacotar(itens: readonly ItemGrade[], inicioGradeMin = 480) {
  return empacotarFaixas(itens, { inicioGradeMin, fuso: FUSO_PADRAO })
}

describe('empacotamento em faixas', () => {
  it('dá faixa única a itens que não se sobrepõem', () => {
    const r = empacotar([item('a', '08:00', '09:00'), item('b', '09:00', '10:00')])
    for (const p of r) {
      expect(p.deFaixas, p.id).toBe(1)
      expect(p.faixa, p.id).toBe(0)
    }
  })

  it('trata horários encostados como não sobrepostos', () => {
    // Termina 09:00 e o próximo começa 09:00: mesma semântica do tstzrange '[)'
    // usado na EXCLUDE constraint do banco.
    const r = empacotar([item('a', '09:00', '10:00'), item('b', '10:00', '11:00')])
    expect(r.every((p) => p.deFaixas === 1)).toBe(true)
  })

  it('separa em duas faixas quando há sobreposição', () => {
    const r = empacotar([item('a', '09:00', '10:00'), item('b', '09:30', '10:30')])
    expect(r.map((p) => p.deFaixas)).toEqual([2, 2])
    expect(new Set(r.map((p) => p.faixa))).toEqual(new Set([0, 1]))
  })

  it('agrupa por sobreposição TRANSITIVA — A cobre B, B cobre C', () => {
    // A 09:00–10:00, B 09:45–10:45, C 10:30–11:30.
    // A e C não se tocam, mas pertencem ao mesmo grupo por causa de B:
    // se a largura fosse calculada par a par, A e C ficariam largos e B estreito.
    const r = empacotar([
      item('a', '09:00', '10:00'),
      item('b', '09:45', '10:45'),
      item('c', '10:30', '11:30'),
    ])
    expect(r.every((p) => p.deFaixas === 2), JSON.stringify(r)).toBe(true)
    // A e C podem reaproveitar a mesma faixa, pois não se sobrepõem.
    const porId = new Map(r.map((p) => [p.id, p]))
    expect(porId.get('a')!.faixa).toBe(0)
    expect(porId.get('b')!.faixa).toBe(1)
    expect(porId.get('c')!.faixa).toBe(0)
  })

  it('não mistura grupos separados no tempo', () => {
    const r = empacotar([
      item('a', '08:00', '09:00'),
      item('b', '08:30', '09:30'),
      // Grupo distinto, muito depois.
      item('c', '15:00', '16:00'),
    ])
    const porId = new Map(r.map((p) => [p.id, p]))
    expect(porId.get('a')!.deFaixas).toBe(2)
    expect(porId.get('b')!.deFaixas).toBe(2)
    // O item isolado ocupa a largura inteira.
    expect(porId.get('c')!.deFaixas).toBe(1)
  })

  it('empilha três sobrepostos em três faixas', () => {
    const r = empacotar([
      item('a', '09:00', '10:00'),
      item('b', '09:10', '10:10'),
      item('c', '09:20', '10:20'),
    ])
    expect(r.every((p) => p.deFaixas === 3)).toBe(true)
    expect(new Set(r.map((p) => p.faixa))).toEqual(new Set([0, 1, 2]))
  })

  it('reaproveita a faixa liberada', () => {
    // A 09:00–09:30 e C 09:30–10:00 cabem na mesma faixa; B cobre as duas.
    const r = empacotar([
      item('a', '09:00', '09:30'),
      item('b', '09:00', '10:00'),
      item('c', '09:30', '10:00'),
    ])
    const porId = new Map(r.map((p) => [p.id, p]))
    expect(porId.get('a')!.faixa).toBe(porId.get('c')!.faixa)
    expect(porId.get('b')!.faixa).not.toBe(porId.get('a')!.faixa)
    expect(r.every((p) => p.deFaixas === 2)).toBe(true)
  })

  it('nenhum par na MESMA faixa se sobrepõe — a invariante que evita cartão escondido', () => {
    const itens = [
      item('a', '08:00', '09:30'),
      item('b', '08:15', '08:45'),
      item('c', '08:30', '10:00'),
      item('d', '09:00', '09:15'),
      item('e', '09:45', '11:00'),
      item('f', '10:00', '10:30'),
      item('g', '13:00', '14:00'),
    ]
    const r = empacotar(itens)
    const porId = new Map(itens.map((i) => [i.id, i]))

    for (const x of r) {
      for (const y of r) {
        if (x.id >= y.id || x.faixa !== y.faixa) continue
        const a = porId.get(x.id)!
        const b = porId.get(y.id)!
        const sobrepoe = a.inicio < b.fim && b.inicio < a.fim
        expect(sobrepoe, `${x.id} e ${y.id} na faixa ${x.faixa} se sobrepõem`).toBe(false)
      }
    }
  })

  it('posiciona pelo topo da grade, não pela meia-noite', () => {
    const r = empacotar([item('a', '09:00', '10:00')], 480) // grade abre 08:00
    expect(r[0]!.topoMin).toBe(60)
    expect(r[0]!.alturaMin).toBe(60)
  })

  it('garante altura mínima para atendimento curto ficar clicável', () => {
    const r = empacotar([item('a', '09:00', '09:10')])
    expect(r[0]!.alturaMin).toBe(20)
  })

  it('devolve lista vazia para entrada vazia', () => {
    expect(empacotar([])).toEqual([])
  })

  it('é determinístico — mesma entrada em outra ordem dá o mesmo layout', () => {
    const itens = [
      item('a', '09:00', '10:00'),
      item('b', '09:30', '10:30'),
      item('c', '09:45', '10:15'),
    ]
    const r1 = empacotar(itens)
    const r2 = empacotar([...itens].reverse())
    const chave = (r: readonly { id: string; faixa: number }[]) =>
      [...r].sort((x, y) => x.id.localeCompare(y.id)).map((p) => `${p.id}:${p.faixa}`).join(',')
    expect(chave(r1)).toBe(chave(r2))
  })
})

describe('início da semana', () => {
  it('devolve a segunda-feira', () => {
    expect(inicioDaSemana('2026-09-01')).toBe('2026-08-31') // terça → segunda
    expect(inicioDaSemana('2026-08-31')).toBe('2026-08-31') // segunda → ela mesma
    expect(inicioDaSemana('2026-09-05')).toBe('2026-08-31') // sábado
  })

  it('trata domingo como fim da semana que começou na segunda anterior', () => {
    // Domingo 06/09 pertence à semana de 31/08, não à de 07/09.
    expect(inicioDaSemana('2026-09-06')).toBe('2026-08-31')
  })

  it('atravessa a virada de mês e de ano', () => {
    expect(inicioDaSemana('2027-01-01')).toBe('2026-12-28') // sexta
  })
})

describe('estrutura da semana', () => {
  it('esconde os dias fechados por padrão', () => {
    const e = estruturaDaSemana({
      segundaIso: '2026-08-31',
      horario: HORARIO_PADRAO,
      hojeIso: '2026-09-01',
    })
    // Domingo fechado sai; segunda a sábado ficam.
    expect(e.dias).toHaveLength(6)
    expect(e.dias.map((d) => d.diaSemana)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('mostra os fechados quando pedido', () => {
    const e = estruturaDaSemana({
      segundaIso: '2026-08-31',
      horario: HORARIO_PADRAO,
      hojeIso: '2026-09-01',
      incluirFechados: true,
    })
    expect(e.dias).toHaveLength(7)
    expect(e.dias.find((d) => d.diaSemana === 0)!.aberto).toBe(false)
  })

  it('mantém a coluna de hoje mesmo se a clínica estiver fechada', () => {
    // 2026-09-06 é domingo. A recepção precisa ver "hoje" para saber que fechou.
    const e = estruturaDaSemana({
      segundaIso: '2026-08-31',
      horario: HORARIO_PADRAO,
      hojeIso: '2026-09-06',
    })
    const domingo = e.dias.find((d) => d.iso === '2026-09-06')
    expect(domingo).toBeDefined()
    expect(domingo!.aberto).toBe(false)
    expect(domingo!.ehHoje).toBe(true)
  })

  it('usa os limites da semana inteira, não de um dia', () => {
    const e = estruturaDaSemana({
      segundaIso: '2026-08-31',
      horario: HORARIO_PADRAO,
      hojeIso: '2026-09-01',
    })
    expect(e.inicioMin).toBe(480) // 08:00
    expect(e.fimMin).toBe(1080) // 18:00
    expect(e.alturaMin).toBe(600)
  })

  it('marca as horas cheias, incluindo a de fechamento', () => {
    const e = estruturaDaSemana({
      segundaIso: '2026-08-31',
      horario: HORARIO_PADRAO,
      hojeIso: '2026-09-01',
    })
    expect(e.marcas[0]).toBe(480)
    expect(e.marcas[e.marcas.length - 1]).toBe(1080)
    expect(e.marcas).toHaveLength(11) // 08:00 … 18:00
  })

  it('acompanha horário estendido de um dia', () => {
    const comNoturno: HorarioFuncionamento = {
      ...HORARIO_PADRAO,
      3: [{ inicio: '07:00', fim: '21:00' }],
    }
    const e = estruturaDaSemana({
      segundaIso: '2026-08-31',
      horario: comNoturno,
      hojeIso: '2026-09-01',
    })
    expect(e.inicioMin).toBe(420)
    expect(e.fimMin).toBe(1260)
  })
})

describe('estrutura do dia', () => {
  it('devolve uma coluna com os limites daquele dia', () => {
    const e = estruturaDoDia({
      diaIso: '2026-09-05', // sábado, fecha ao meio-dia
      horario: HORARIO_PADRAO,
      hojeIso: '2026-09-01',
    })
    expect(e.dias).toHaveLength(1)
    expect(e.inicioMin).toBe(480)
    expect(e.fimMin).toBe(720)
  })

  it('marca dia fechado', () => {
    const e = estruturaDoDia({
      diaIso: '2026-09-06', // domingo
      horario: HORARIO_PADRAO,
      hojeIso: '2026-09-06',
    })
    expect(e.dias[0]!.aberto).toBe(false)
    expect(e.dias[0]!.ehHoje).toBe(true)
  })
})

describe('agrupamento por dia', () => {
  it('agrupa pelo dia LOCAL do início', () => {
    const itens = [
      item('a', '09:00', '10:00', '2026-09-01'),
      item('b', '11:00', '12:00', '2026-09-01'),
      item('c', '09:00', '10:00', '2026-09-02'),
    ]
    const m = agruparPorDia(itens, FUSO_PADRAO)
    expect(m.get('2026-09-01')).toHaveLength(2)
    expect(m.get('2026-09-02')).toHaveLength(1)
  })

  it('usa o dia da clínica, não o do UTC', () => {
    // 2026-09-02T02:00Z é 01/09 às 23:00 em São Paulo.
    const noturno: ItemGrade = {
      id: 'x',
      inicio: new Date('2026-09-02T02:00:00Z'),
      fim: new Date('2026-09-02T03:00:00Z'),
    }
    const m = agruparPorDia([noturno], FUSO_PADRAO)
    expect(m.has('2026-09-01')).toBe(true)
    expect(m.has('2026-09-02')).toBe(false)
  })

  it('devolve mapa vazio para entrada vazia', () => {
    expect(agruparPorDia([], FUSO_PADRAO).size).toBe(0)
  })
})

describe('linha do agora', () => {
  const base = { inicioMin: 480, fimMin: 1080, fuso: FUSO_PADRAO }

  it('posiciona relativo ao topo da grade', () => {
    expect(
      posicaoDoAgora({ ...base, agora: instanteDe(DIA, '09:30', FUSO_PADRAO), diaIso: DIA }),
    ).toBe(90)
  })

  it('devolve null em outro dia', () => {
    expect(
      posicaoDoAgora({ ...base, agora: instanteDe('2026-09-02', '09:30', FUSO_PADRAO), diaIso: DIA }),
    ).toBeNull()
  })

  it('devolve null antes de abrir e depois de fechar', () => {
    expect(
      posicaoDoAgora({ ...base, agora: instanteDe(DIA, '07:00', FUSO_PADRAO), diaIso: DIA }),
    ).toBeNull()
    expect(
      posicaoDoAgora({ ...base, agora: instanteDe(DIA, '19:00', FUSO_PADRAO), diaIso: DIA }),
    ).toBeNull()
  })
})
