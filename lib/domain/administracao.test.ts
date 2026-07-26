import { describe, expect, it } from 'vitest'
import {
  type EstadoDaCadeira,
  type EstadoDoUsuario,
  adminsAtivos,
  diaAnterior,
  emailEhPlausivel,
  encaixarVigencia,
  exigeProfissional,
  normalizarEmail,
  normalizarProfissional,
  podeDesativarCadeira,
  podeDesativarUsuario,
  podeTrocarPerfil,
  validarProfissional,
} from './administracao'

function u(p: Partial<EstadoDoUsuario> & { id: string }): EstadoDoUsuario {
  return { perfil: 'recepcao', ativo: true, temProfissional: false, ...p }
}

const ADMIN_A = u({ id: 'a', perfil: 'admin' })
const ADMIN_B = u({ id: 'b', perfil: 'admin' })
const RECEPCAO = u({ id: 'r' })

describe('não se pode ficar sem administrador', () => {
  it('conta apenas admins ATIVOS', () => {
    expect(adminsAtivos([ADMIN_A, u({ id: 'b', perfil: 'admin', ativo: false }), RECEPCAO])).toBe(1)
  })

  it('recusa desativar o único admin ativo', () => {
    const r = podeDesativarUsuario(ADMIN_A, [ADMIN_A, RECEPCAO], 'outro')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toMatch(/único administrador/i)
  })

  it('permite quando existe um segundo admin ativo', () => {
    expect(podeDesativarUsuario(ADMIN_A, [ADMIN_A, ADMIN_B], 'b').ok).toBe(true)
  })

  it('admin inativo não conta como reserva', () => {
    const inativo = u({ id: 'b', perfil: 'admin', ativo: false })
    expect(podeDesativarUsuario(ADMIN_A, [ADMIN_A, inativo], 'outro').ok).toBe(false)
  })

  it('recusa desativar a si mesmo, mesmo havendo outro admin', () => {
    // Quem se desativa fica sem sessão no clique seguinte, e o socorro passa a
    // ser outra pessoa (ou o banco).
    const r = podeDesativarUsuario(ADMIN_A, [ADMIN_A, ADMIN_B], 'a')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toMatch(/seu próprio acesso/i)
  })

  it('recusa desativar quem já está inativo', () => {
    expect(podeDesativarUsuario(u({ id: 'x', ativo: false }), [ADMIN_A], 'a').ok).toBe(false)
  })

  it('recusa rebaixar o único admin', () => {
    const r = podeTrocarPerfil(ADMIN_A, 'recepcao', [ADMIN_A, RECEPCAO], 'outro')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toMatch(/único administrador/i)
  })

  it('recusa trocar o próprio perfil', () => {
    expect(podeTrocarPerfil(ADMIN_A, 'dentista', [ADMIN_A, ADMIN_B], 'a').ok).toBe(false)
  })

  it('permite promover outra pessoa a admin', () => {
    expect(podeTrocarPerfil(RECEPCAO, 'admin', [ADMIN_A, RECEPCAO], 'a').ok).toBe(true)
  })

  it('perfil igual ao atual nunca é recusado, nem sendo você mesmo', () => {
    // Salvar o formulário sem mexer no perfil não pode dar erro.
    expect(podeTrocarPerfil(ADMIN_A, 'admin', [ADMIN_A], 'a').ok).toBe(true)
  })

  it('rebaixar um admin quando há dois é permitido', () => {
    expect(podeTrocarPerfil(ADMIN_B, 'financeiro', [ADMIN_A, ADMIN_B], 'a').ok).toBe(true)
  })
})

describe('perfil dentista exige cadastro de profissional', () => {
  it('só dentista exige', () => {
    expect(exigeProfissional('dentista')).toBe(true)
    for (const p of ['recepcao', 'financeiro', 'admin'] as const) {
      expect(exigeProfissional(p), p).toBe(false)
    }
  })

  it('valida CRO e comissão', () => {
    expect(validarProfissional({ cro: '12345', ufCro: 'SP', comissaoPct: '40' }).ok).toBe(true)
    expect(validarProfissional({ cro: '', ufCro: 'SP', comissaoPct: '40' }).ok).toBe(false)
    expect(validarProfissional({ cro: '12345', ufCro: 'São Paulo', comissaoPct: '40' }).ok).toBe(false)
    expect(validarProfissional({ cro: '12345', ufCro: 'SP', comissaoPct: '101' }).ok).toBe(false)
    expect(validarProfissional({ cro: '12345', ufCro: 'SP', comissaoPct: '-1' }).ok).toBe(false)
    expect(validarProfissional({ cro: '12345', ufCro: 'SP', comissaoPct: 'abc' }).ok).toBe(false)
  })

  it('comissão zero é válida — nem todo dentista é comissionado', () => {
    expect(validarProfissional({ cro: '123', ufCro: 'sp', comissaoPct: '0' }).ok).toBe(true)
  })

  it('grava a UF em MAIÚSCULA', () => {
    // A folha de conferência do convênio é digitada por uma pessoa no portal da
    // operadora, onde "sp" é recusado. Já custou correção na Fase 13.
    const n = normalizarProfissional({ cro: ' 12345 ', ufCro: 'sp', comissaoPct: '40' })
    expect(n).toEqual({ cro: '12345', ufCro: 'SP', comissaoPct: '40.00' })
  })
})

describe('e-mail do staff', () => {
  it('normaliza para minúscula, porque o índice único é sobre lower(email)', () => {
    expect(normalizarEmail('  Ana@Clinica.LOCAL ')).toBe('ana@clinica.local')
  })

  it('aceita endereço comum e recusa o que não grava', () => {
    expect(emailEhPlausivel('ana.silva+trabalho@clinica.com.br')).toBe(true)
    expect(emailEhPlausivel('ana')).toBe(false)
    expect(emailEhPlausivel('a n a@x.com')).toBe(false)
    expect(emailEhPlausivel(`${'a'.repeat(250)}@x.com`)).toBe(false)
  })

  it('NÃO exige ponto no domínio', () => {
    // `admin@local` é a convenção do seed deste projeto, e `ana@clinica` é
    // endereço válido em rede interna. A versão que exigia `algo.algo` depois da
    // arroba impedia a clínica de cadastrar o próprio funcionário — encontrado
    // na primeira execução de `npm run admin:verificar`.
    expect(emailEhPlausivel('admin@local')).toBe(true)
    expect(emailEhPlausivel('ana@clinica')).toBe(true)
  })
})

describe('vigência da tabela negociada', () => {
  it('primeira vigência entra sem fechar nada', () => {
    const r = encaixarVigencia([], { vigenciaInicio: '2026-01-01', vigenciaFim: null })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fechar).toBeUndefined()
  })

  it('reajuste FECHA a vigência aberta no dia anterior', () => {
    const atual = { id: 'v1', vigenciaInicio: '2025-01-01', vigenciaFim: null }
    const r = encaixarVigencia([atual], { vigenciaInicio: '2026-03-01', vigenciaFim: null })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fechar).toEqual({ id: 'v1', em: '2026-02-28' })
  })

  it('o fechamento automático é o que impede DOIS preços válidos no mesmo dia', () => {
    // Sem ele, `precoVigenteEm` teria duas linhas candidatas e o valor faturado
    // passaria a depender da ordem da consulta.
    const atual = { id: 'v1', vigenciaInicio: '2025-01-01', vigenciaFim: null }
    const r = encaixarVigencia([atual], { vigenciaInicio: '2026-01-01', vigenciaFim: null })
    expect(r.ok && r.fechar?.em).toBe('2025-12-31')
  })

  it('recusa sobrepor vigência JÁ FECHADA — é erro de digitação, não reajuste', () => {
    const fechada = { id: 'v1', vigenciaInicio: '2025-01-01', vigenciaFim: '2025-12-31' }
    const r = encaixarVigencia([fechada], { vigenciaInicio: '2025-06-01', vigenciaFim: null })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toMatch(/indefinido o valor a faturar/i)
  })

  it('recusa reajuste que começa antes (ou no mesmo dia) do preço atual', () => {
    const atual = { id: 'v1', vigenciaInicio: '2026-01-01', vigenciaFim: null }
    expect(encaixarVigencia([atual], { vigenciaInicio: '2026-01-01', vigenciaFim: null }).ok).toBe(false)
    expect(encaixarVigencia([atual], { vigenciaInicio: '2025-06-01', vigenciaFim: null }).ok).toBe(false)
  })

  it('recusa fim antes do início', () => {
    expect(
      encaixarVigencia([], { vigenciaInicio: '2026-06-01', vigenciaFim: '2026-01-01' }).ok,
    ).toBe(false)
  })

  it('recusa período fechado dentro de vigência aberta', () => {
    const atual = { id: 'v1', vigenciaInicio: '2025-01-01', vigenciaFim: null }
    const r = encaixarVigencia([atual], { vigenciaInicio: '2026-01-01', vigenciaFim: '2026-06-30' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toMatch(/Feche a vigência atual/i)
  })

  it('vigências que não se tocam convivem', () => {
    const antiga = { id: 'v1', vigenciaInicio: '2024-01-01', vigenciaFim: '2024-12-31' }
    const r = encaixarVigencia([antiga], { vigenciaInicio: '2025-01-01', vigenciaFim: null })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fechar).toBeUndefined()
  })

  it('ignora a própria linha ao reavaliar (edição não conflita consigo)', () => {
    const ela = { id: 'v1', vigenciaInicio: '2026-01-01', vigenciaFim: null }
    const r = encaixarVigencia([ela], { id: 'v1', vigenciaInicio: '2026-01-01', vigenciaFim: null })
    expect(r.ok).toBe(true)
  })
})

describe('diaAnterior', () => {
  it('anda um dia para trás', () => {
    expect(diaAnterior('2026-03-15')).toBe('2026-03-14')
  })

  it('atravessa o começo do mês', () => {
    expect(diaAnterior('2026-03-01')).toBe('2026-02-28')
    expect(diaAnterior('2026-05-01')).toBe('2026-04-30')
  })

  it('acerta fevereiro em ano bissexto', () => {
    expect(diaAnterior('2028-03-01')).toBe('2028-02-29')
  })

  it('atravessa o ano', () => {
    expect(diaAnterior('2026-01-01')).toBe('2025-12-31')
  })
})

describe('cadeiras', () => {
  function c(p: Partial<EstadoDaCadeira> & { id: string }): EstadoDaCadeira {
    return { nome: 'Cadeira', ativo: true, agendamentosFuturos: 0, ...p }
  }

  it('recusa desativar cadeira com agendamento futuro', () => {
    const alvo = c({ id: '1', agendamentosFuturos: 3 })
    const r = podeDesativarCadeira(alvo, [alvo, c({ id: '2' })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toMatch(/3 agendamento/)
  })

  it('recusa desativar a última cadeira ativa', () => {
    const alvo = c({ id: '1' })
    const r = podeDesativarCadeira(alvo, [alvo, c({ id: '2', ativo: false })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toMatch(/única cadeira/i)
  })

  it('permite quando está livre e há outra ativa', () => {
    const alvo = c({ id: '1' })
    expect(podeDesativarCadeira(alvo, [alvo, c({ id: '2' })]).ok).toBe(true)
  })
})
