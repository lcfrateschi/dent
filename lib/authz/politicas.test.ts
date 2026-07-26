import { describe, expect, it } from 'vitest'
import {
  ACOES,
  type Acao,
  type Perfil,
  type Recurso,
  acoesPermitidas,
  ehRecursoClinico,
  matrizCompleta,
  pode,
  podeVer,
} from './politicas'

const PERFIS: readonly Perfil[] = ['dentista', 'recepcao', 'financeiro', 'admin']

describe('as três separações que a clínica pediu', () => {
  it('recepção NÃO lê prontuário nem anamnese já respondida', () => {
    expect(pode('recepcao', 'prontuario', 'ler')).toBe(false)
    expect(pode('recepcao', 'prontuario', 'criar')).toBe(false)
    expect(pode('recepcao', 'prontuario', 'exportar')).toBe(false)
    expect(pode('recepcao', 'anamnese', 'ler')).toBe(false)
    expect(pode('recepcao', 'anamnese', 'editar')).toBe(false)
    // Mas pode aplicar o questionário no balcão.
    expect(pode('recepcao', 'anamnese', 'criar')).toBe(true)
  })

  it('recepção VÊ alerta clínico — é segurança do paciente na cadeira', () => {
    // Alergia e uso de anticoagulante têm que aparecer para quem atende.
    expect(pode('recepcao', 'alerta_clinico', 'ler')).toBe(true)
    // Sem poder criar nem alterar: diagnóstico é do dentista.
    expect(pode('recepcao', 'alerta_clinico', 'criar')).toBe(false)
    expect(pode('recepcao', 'alerta_clinico', 'editar')).toBe(false)
  })

  it('financeiro NÃO toca em nenhum dado clínico', () => {
    for (const recurso of [
      'prontuario',
      'anamnese',
      'alerta_clinico',
      'odontograma',
      'plano_tratamento',
      'relatorio_clinico',
    ] as Recurso[]) {
      for (const acao of ACOES) {
        expect(pode('financeiro', recurso, acao), `financeiro/${recurso}/${acao}`).toBe(false)
      }
    }
    // Mas lê o cadastro, para emitir cobrança e nota.
    expect(pode('financeiro', 'paciente', 'ler')).toBe(true)
    expect(pode('financeiro', 'cobranca', 'editar')).toBe(true)
  })

  it('dentista NÃO altera dinheiro', () => {
    expect(pode('dentista', 'cobranca', 'editar')).toBe(false)
    expect(pode('dentista', 'cobranca', 'criar')).toBe(false)
    expect(pode('dentista', 'cobranca', 'excluir')).toBe(false)
    for (const acao of ACOES) {
      expect(pode('dentista', 'pagamento', acao), `dentista/pagamento/${acao}`).toBe(false)
    }
    // Vê o que foi cobrado do paciente dele.
    expect(pode('dentista', 'cobranca', 'ler')).toBe(true)
  })
})

describe('prontuário', () => {
  it('só o dentista escreve e assina', () => {
    expect(pode('dentista', 'prontuario', 'criar')).toBe(true)
    expect(pode('dentista', 'prontuario', 'assinar')).toBe(true)
    for (const perfil of ['recepcao', 'financeiro', 'admin'] as Perfil[]) {
      expect(pode(perfil, 'prontuario', 'criar'), perfil).toBe(false)
      expect(pode(perfil, 'prontuario', 'assinar'), perfil).toBe(false)
    }
  })

  it('ninguém edita nem exclui evolução — nem o autor, nem o admin', () => {
    // O banco também impede por trigger; aqui a permissão nem existe.
    for (const perfil of PERFIS) {
      expect(pode(perfil, 'prontuario', 'editar'), perfil).toBe(false)
      expect(pode(perfil, 'prontuario', 'excluir'), perfil).toBe(false)
    }
  })

  it('admin não é superusuário clínico', () => {
    // A tentação de dar tudo ao admin é justamente o que a LGPD pune.
    expect(pode('admin', 'prontuario', 'ler')).toBe(false)
    expect(pode('admin', 'anamnese', 'ler')).toBe(false)
    expect(pode('admin', 'odontograma', 'ler')).toBe(false)
  })
})

describe('auditoria', () => {
  it('só o admin lê a trilha', () => {
    expect(pode('admin', 'auditoria', 'ler')).toBe(true)
    for (const perfil of ['dentista', 'recepcao', 'financeiro'] as Perfil[]) {
      expect(pode(perfil, 'auditoria', 'ler'), perfil).toBe(false)
    }
  })

  it('ninguém altera nem apaga a trilha', () => {
    // Trilha que se pode editar não é trilha. O banco impõe por trigger.
    for (const perfil of PERFIS) {
      for (const acao of ['criar', 'editar', 'excluir'] as Acao[]) {
        expect(pode(perfil, 'auditoria', acao), `${perfil}/${acao}`).toBe(false)
      }
    }
  })
})

describe('usuários e configuração', () => {
  it('só o admin administra usuários e configuração', () => {
    expect(pode('admin', 'usuario', 'criar')).toBe(true)
    expect(pode('admin', 'configuracao', 'editar')).toBe(true)
    for (const perfil of ['dentista', 'recepcao', 'financeiro'] as Perfil[]) {
      expect(podeVer(perfil, 'usuario'), perfil).toBe(false)
      expect(podeVer(perfil, 'configuracao'), perfil).toBe(false)
    }
  })
})

describe('agenda', () => {
  it('recepção tem controle total da agenda — é o trabalho dela', () => {
    for (const acao of ['ler', 'criar', 'editar', 'excluir'] as Acao[]) {
      expect(pode('recepcao', 'agenda', acao), acao).toBe(true)
    }
  })

  it('financeiro só consulta a agenda', () => {
    expect(pode('financeiro', 'agenda', 'ler')).toBe(true)
    expect(pode('financeiro', 'agenda', 'criar')).toBe(false)
    expect(pode('financeiro', 'agenda', 'editar')).toBe(false)
  })
})

describe('comportamento da matriz', () => {
  it('nega por omissão: recurso não listado é acesso zero', () => {
    // 'documento' não está no perfil financeiro.
    for (const acao of ACOES) {
      expect(pode('financeiro', 'documento', acao), acao).toBe(false)
    }
    expect(acoesPermitidas('financeiro', 'documento')).toEqual([])
    expect(podeVer('financeiro', 'documento')).toBe(false)
  })

  it("'*' concede todas as ações", () => {
    expect(acoesPermitidas('admin', 'usuario')).toEqual(ACOES)
    for (const acao of ACOES) {
      expect(pode('admin', 'usuario', acao), acao).toBe(true)
    }
  })

  it('podeVer concorda com acoesPermitidas em todo par perfil × recurso', () => {
    const recursos = Object.keys(matrizCompleta().admin) as Recurso[]
    for (const perfil of PERFIS) {
      for (const recurso of recursos) {
        expect(podeVer(perfil, recurso), `${perfil}/${recurso}`).toBe(
          acoesPermitidas(perfil, recurso).length > 0,
        )
      }
    }
  })

  it('nenhum perfil recebe ação fora da lista canônica', () => {
    const matriz = matrizCompleta()
    for (const perfil of PERFIS) {
      for (const [recurso, acoes] of Object.entries(matriz[perfil])) {
        for (const acao of acoes ?? []) {
          expect(ACOES, `${perfil}/${recurso}`).toContain(acao)
        }
      }
    }
  })

  it('todo perfil tem ao menos um recurso — perfil sem acesso não faz sentido', () => {
    const matriz = matrizCompleta()
    for (const perfil of PERFIS) {
      expect(Object.keys(matriz[perfil]).length, perfil).toBeGreaterThan(0)
    }
  })

  it("'assinar' só existe onde faz sentido", () => {
    const matriz = matrizCompleta()
    for (const perfil of PERFIS) {
      for (const [recurso, acoes] of Object.entries(matriz[perfil])) {
        if ((acoes ?? []).includes('assinar')) {
          expect(['prontuario', 'usuario', 'configuracao', 'convenio'], perfil).toContain(recurso)
        }
      }
    }
  })
})

describe('classificação de recurso clínico', () => {
  it('marca como clínico tudo que exige auditoria de leitura', () => {
    for (const recurso of [
      'prontuario',
      'anamnese',
      'alerta_clinico',
      'odontograma',
      'plano_tratamento',
      'relatorio_clinico',
    ] as Recurso[]) {
      expect(ehRecursoClinico(recurso), recurso).toBe(true)
    }
  })

  it('não marca como clínico o que é administrativo ou financeiro', () => {
    for (const recurso of [
      'agenda',
      'cobranca',
      'pagamento',
      'usuario',
      'configuracao',
      'convenio',
      'relatorio_financeiro',
    ] as Recurso[]) {
      expect(ehRecursoClinico(recurso), recurso).toBe(false)
    }
  })

  it('quem não é dentista não lê nenhum recurso clínico, com uma exceção declarada', () => {
    for (const perfil of ['recepcao', 'financeiro', 'admin'] as Perfil[]) {
      for (const recurso of [
        'prontuario',
        'anamnese',
        'odontograma',
        'relatorio_clinico',
      ] as Recurso[]) {
        if (perfil === 'admin' && recurso === 'relatorio_clinico') continue // agregado, sem paciente
        expect(pode(perfil, recurso, 'ler'), `${perfil}/${recurso}`).toBe(false)
      }
    }
    // A exceção: recepção lê alerta clínico, por segurança do paciente.
    expect(pode('recepcao', 'alerta_clinico', 'ler')).toBe(true)
  })

  describe('estoque — três perfis, três papéis sobre a mesma tabela', () => {
    it('dentista dá baixa do que usou, mas não mexe no inventário', () => {
      expect(pode('dentista', 'estoque', 'criar')).toBe(true)
      expect(pode('dentista', 'estoque', 'editar')).toBe(false)
      expect(pode('dentista', 'estoque', 'excluir')).toBe(false)
    })

    it('financeiro confere custo e exporta, mas não dá baixa', () => {
      // Baixa é fato clínico-operacional: quem não estava na cadeira não sabe
      // qual lote saiu, e um consumo lançado por terceiro corrompe a
      // rastreabilidade justamente onde ela importa (implante recolhido).
      expect(pode('financeiro', 'estoque', 'ler')).toBe(true)
      expect(pode('financeiro', 'estoque', 'exportar')).toBe(true)
      expect(pode('financeiro', 'estoque', 'criar')).toBe(false)
      expect(pode('financeiro', 'estoque', 'editar')).toBe(false)
    })

    it('recepção lança entrada e faz a contagem', () => {
      expect(pode('recepcao', 'estoque', 'criar')).toBe(true)
      expect(pode('recepcao', 'estoque', 'editar')).toBe(true)
      expect(pode('recepcao', 'estoque', 'excluir')).toBe(false)
    })

    it('estoque NÃO é recurso clínico — não dispara auditoria de prontuário', () => {
      expect(ehRecursoClinico('estoque')).toBe(false)
    })
  })
})
