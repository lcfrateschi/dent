import { describe, expect, it } from 'vitest'
import {
  FINALIDADES_DO_PORTAL,
  NIVEL_ASSINATURA,
  REGRA_PADRAO,
  type RegraAutoatendimento,
  avaliarPedido,
  idadeEmAnos,
  janelaDeDias,
  podeDesmarcarSozinho,
  quemAssina,
} from './autoatendimento'
import { ErroDominio } from './erros'

const AGORA = new Date('2026-07-27T12:00:00Z')
const HORA = 3_600_000
const DIA = 24 * HORA

const LIGADA: RegraAutoatendimento = { ...REGRA_PADRAO, ativo: true }

function pedido(over: Partial<Parameters<typeof avaliarPedido>[0]> = {}) {
  return avaliarPedido({
    inicio: new Date(AGORA.getTime() + 3 * DIA),
    agora: AGORA,
    procedimentoLiberado: true,
    futurosDoPaciente: 0,
    regra: LIGADA,
    ...over,
  })
}

describe('avaliarPedido', () => {
  it('aceita o caso normal', () => {
    expect(pedido()).toBeNull()
  })

  it('o padrão é DESLIGADO — atualizar o sistema não abre a agenda para a internet', () => {
    // Se este teste virar vermelho porque alguém achou que "ativo: true" é mais
    // amigável, leia o comentário de REGRA_PADRAO: recurso que muda quem pode
    // escrever na agenda começa desligado.
    expect(REGRA_PADRAO.ativo).toBe(false)
    expect(pedido({ regra: REGRA_PADRAO })?.motivo).toBe('desligado')
  })

  it('recusa procedimento não liberado sem dizer qual é a lista', () => {
    const r = pedido({ procedimentoLiberado: false })
    expect(r?.motivo).toBe('procedimento_nao_liberado')
    // A mensagem não pode enumerar o catálogo interno nem dar motivo clínico.
    expect(r?.mensagem).not.toMatch(/exodontia|cirurgia|molar/i)
  })

  it('recusa dentro da antecedência mínima e aceita exatamente nela', () => {
    const limite = new Date(AGORA.getTime() + LIGADA.antecedenciaMinimaHoras * HORA)
    expect(pedido({ inicio: new Date(limite.getTime() - 60_000) })?.motivo).toBe(
      'antecedencia_minima',
    )
    // A fronteira aceita: `>=`, não `>`. Um limite de 24 h que recusa às 24 h em
    // ponto vira "recusou sem motivo" para quem contou os dias no calendário.
    expect(pedido({ inicio: limite })).toBeNull()
  })

  it('recusa além da antecedência máxima e aceita exatamente nela', () => {
    const teto = new Date(AGORA.getTime() + LIGADA.antecedenciaMaximaDias * DIA)
    expect(pedido({ inicio: new Date(teto.getTime() + 60_000) })?.motivo).toBe(
      'antecedencia_maxima',
    )
    expect(pedido({ inicio: teto })).toBeNull()
  })

  it('recusa quando o paciente já atingiu o teto de futuros', () => {
    expect(pedido({ futurosDoPaciente: 1 })).toBeNull()
    expect(pedido({ futurosDoPaciente: 2 })?.motivo).toBe('teto_de_futuros')
    expect(pedido({ futurosDoPaciente: 9 })?.motivo).toBe('teto_de_futuros')
  })

  it('a mensagem de antecedência fala em DIAS quando o limite é diário', () => {
    // Detalhe de quem lê: "marque com 48 horas de antecedência" faz o paciente
    // contar; "2 dias" ele entende na hora.
    expect(pedido({ inicio: AGORA, regra: { ...LIGADA, antecedenciaMinimaHoras: 48 } })?.mensagem)
      .toContain('2 dia')
    expect(pedido({ inicio: AGORA, regra: { ...LIGADA, antecedenciaMinimaHoras: 4 } })?.mensagem)
      .toContain('4 hora')
  })

  it('a ordem das recusas vai do geral ao específico', () => {
    // Com tudo errado ao mesmo tempo, quem tem o recurso desligado não deve ler
    // sobre antecedência — a mensagem tem de ser a que resolve.
    const r = avaliarPedido({
      inicio: AGORA,
      agora: AGORA,
      procedimentoLiberado: false,
      futurosDoPaciente: 99,
      regra: REGRA_PADRAO,
    })
    expect(r?.motivo).toBe('desligado')
  })
})

describe('janelaDeDias', () => {
  it('coincide com o que avaliarPedido aceita', () => {
    // Esta é a amarra que importa: a grade não pode oferecer dia que a regra
    // recusa. Oferecer e depois recusar parece defeito para quem escolheu.
    const { de, ate } = janelaDeDias(LIGADA, AGORA)
    expect(pedido({ inicio: de })).toBeNull()
    expect(pedido({ inicio: ate })).toBeNull()
    expect(pedido({ inicio: new Date(de.getTime() - 60_000) })).not.toBeNull()
    expect(pedido({ inicio: new Date(ate.getTime() + 60_000) })).not.toBeNull()
  })
})

describe('podeDesmarcarSozinho', () => {
  const base = {
    origem: 'portal',
    status: 'agendado',
    inicio: new Date(AGORA.getTime() + 3 * DIA),
    agora: AGORA,
    regra: LIGADA,
  }

  it('deixa desmarcar o que o próprio paciente marcou', () => {
    expect(podeDesmarcarSozinho(base)).toBe(true)
  })

  it('NÃO deixa desmarcar horário que a recepção deu', () => {
    // Aqui vale a decisão fechada: um toque errado não pode custar um horário que
    // a clínica organizou.
    for (const origem of ['recepcao', 'telefone', 'whatsapp', 'encaixe']) {
      expect(podeDesmarcarSozinho({ ...base, origem }), origem).toBe(false)
    }
  })

  it('NÃO deixa desmarcar depois de a clínica confirmar', () => {
    for (const status of ['confirmado', 'em_atendimento', 'concluido']) {
      expect(podeDesmarcarSozinho({ ...base, status }), status).toBe(false)
    }
  })

  it('NÃO deixa desmarcar dentro da antecedência mínima', () => {
    // É a janela em que a agenda do dia já foi organizada — a clínica precisa
    // saber, e é o caminho de "avisar".
    const emCimaDaHora = new Date(AGORA.getTime() + 2 * HORA)
    expect(podeDesmarcarSozinho({ ...base, inicio: emCimaDaHora })).toBe(false)
  })
})

describe('quemAssina', () => {
  const menor = { pacienteId: 'p-menor', responsavelLegalId: 'p-mae', ehMenor: true }

  it('adulto assina o próprio termo', () => {
    expect(
      quemAssina({
        pacienteId: 'p1',
        responsavelLegalId: null,
        ehMenor: false,
        sessaoPacienteId: 'p1',
      }),
    ).toEqual({ pacienteId: 'p1', assinadoPorId: null })
  })

  it('MENOR não assina o próprio termo, nem com sessão própria', () => {
    // O caso que a regra existe para impedir: o menor tem conta (irmão mais velho
    // compartilhou a senha, por exemplo) e clica em assinar.
    expect(() => quemAssina({ ...menor, sessaoPacienteId: 'p-menor' })).toThrowError(ErroDominio)
    expect(() => quemAssina({ ...menor, sessaoPacienteId: 'p-menor' })).toThrowError(
      /responsável legal/i,
    )
  })

  it('o responsável assina PELO menor, e a linha registra os dois lados', () => {
    expect(quemAssina({ ...menor, sessaoPacienteId: 'p-mae' })).toEqual({
      pacienteId: 'p-menor',
      assinadoPorId: 'p-mae',
    })
  })

  it('menor sem responsável cadastrado não assina de jeito nenhum', () => {
    expect(() =>
      quemAssina({
        pacienteId: 'p-menor',
        responsavelLegalId: null,
        ehMenor: true,
        sessaoPacienteId: 'p-menor',
      }),
    ).toThrowError(/responsável legal cadastrado/i)
  })

  it('adulto não assina pelo outro adulto', () => {
    expect(() =>
      quemAssina({
        pacienteId: 'p1',
        responsavelLegalId: null,
        ehMenor: false,
        sessaoPacienteId: 'p2',
      }),
    ).toThrowError(/próprio paciente/i)
  })
})

describe('idadeEmAnos', () => {
  it('conta anos completos, e o aniversário conta no dia', () => {
    expect(idadeEmAnos('2008-07-27', '2026-07-27')).toBe(18)
    expect(idadeEmAnos('2008-07-28', '2026-07-27')).toBe(17)
    expect(idadeEmAnos('2008-08-01', '2026-07-27')).toBe(17)
    expect(idadeEmAnos('2008-06-30', '2026-07-27')).toBe(18)
  })

  it('29 de fevereiro não vira maioridade um dia antes', () => {
    expect(idadeEmAnos('2008-02-29', '2026-02-28')).toBe(17)
    expect(idadeEmAnos('2008-02-29', '2026-03-01')).toBe(18)
  })
})

describe('assinatura eletrônica: o nível é declarado, não deduzido', () => {
  it('existe um nível só, e ele diz o que é', () => {
    // ⚖️ Se alguém acrescentar 'qualificada' aqui sem ICP-Brasil por trás, este
    // teste é o lugar de parar: o nome na coluna é o que um advogado vai ler.
    expect(NIVEL_ASSINATURA).toBe('eletronica_simples')
  })

  it('as finalidades do portal são as três declaradas', () => {
    expect(Object.values(FINALIDADES_DO_PORTAL)).toEqual([
      'anamnese_autodeclarada',
      'termo_de_atendimento',
      'politica_de_privacidade',
    ])
  })
})
