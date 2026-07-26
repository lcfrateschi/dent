import { describe, expect, it } from 'vitest'
import {
  avaliarSenha,
  gerarHashSenha,
  gerarSenhaTemporaria,
  precisaRehash,
  verificarSenha,
} from './senha'

describe('hash de senha com scrypt', () => {
  it('verifica a senha correta', async () => {
    const hash = await gerarHashSenha('frase secreta bem longa')
    expect(await verificarSenha('frase secreta bem longa', hash)).toBe(true)
  })

  it('recusa a senha errada', async () => {
    const hash = await gerarHashSenha('frase secreta bem longa')
    expect(await verificarSenha('frase secreta bem longo', hash)).toBe(false)
    expect(await verificarSenha('', hash)).toBe(false)
  })

  it('gera hash diferente para a mesma senha — o salt é aleatório', async () => {
    const a = await gerarHashSenha('mesma senha aqui')
    const b = await gerarHashSenha('mesma senha aqui')
    expect(a).not.toBe(b)
    // E os dois validam.
    expect(await verificarSenha('mesma senha aqui', a)).toBe(true)
    expect(await verificarSenha('mesma senha aqui', b)).toBe(true)
  })

  it('guarda os parâmetros no próprio hash, para poder endurecê-los depois', async () => {
    const hash = await gerarHashSenha('senha de teste longa')
    const partes = hash.split('$')
    expect(partes[0]).toBe('scrypt')
    expect(Number(partes[1])).toBe(32768) // N
    expect(Number(partes[2])).toBe(8) // r
    expect(Number(partes[3])).toBe(1) // p
    expect(partes).toHaveLength(6)
  })

  it('trata Unicode de forma estável (normalização NFKC)', async () => {
    // "é" composto (e + acento) e pré-composto devem ser a mesma senha.
    const decomposto = 'senha café longa'
    const composto = 'senha café longa'
    const hash = await gerarHashSenha(decomposto)
    expect(await verificarSenha(composto, hash)).toBe(true)
  })

  it('nunca lança em hash malformado — devolve false', async () => {
    const ruins = [
      '',
      'nao-e-hash',
      'scrypt$1$2$3',
      'bcrypt$32768$8$1$abc$def',
      'scrypt$abc$8$1$YWJj$ZGVm',
      'scrypt$32768$8$1$$',
    ]
    for (const ruim of ruins) {
      await expect(verificarSenha('qualquer', ruim)).resolves.toBe(false)
    }
  })

  it('recusa parâmetros absurdos no hash — barreira contra DoS de memória', async () => {
    // N gigante pediria memória impossível se fosse aceito.
    const malicioso = `scrypt$${2 ** 30}$8$1$YWJjZGVm$YWJjZGVm`
    await expect(verificarSenha('qualquer', malicioso)).resolves.toBe(false)
  })

  it('detecta hash com parâmetros antigos', async () => {
    const atual = await gerarHashSenha('senha de teste longa')
    expect(precisaRehash(atual)).toBe(false)
    expect(precisaRehash('scrypt$16384$8$1$YWJj$ZGVm')).toBe(true)
    expect(precisaRehash('bcrypt$qualquer')).toBe(true)
  })
})

describe('política de senha', () => {
  it('aceita frase longa e variada', () => {
    const r = avaliarSenha('cadeira azul do consultorio')
    expect(r.aceita, r.problemas.join(' ')).toBe(true)
  })

  it('exige comprimento mínimo — comprimento vale mais que símbolo obrigatório', () => {
    expect(avaliarSenha('S3nh@!').aceita).toBe(false)
    expect(avaliarSenha('S3nh@!').problemas.join(' ')).toMatch(/12 caracteres/)
  })

  it('recusa sequência óbvia', () => {
    for (const ruim of ['abcdefghijkl', 'qwertyuiopas', 'senha123senha']) {
      expect(avaliarSenha(ruim).aceita, `"${ruim}"`).toBe(false)
    }
  })

  it('recusa pouca variedade e repetição', () => {
    expect(avaliarSenha('aaaaaaaaaaaa').aceita).toBe(false)
    expect(avaliarSenha('abababababab').aceita).toBe(false)
  })

  it('recusa senha que contém o nome ou o e-mail do usuário', () => {
    const r = avaliarSenha('frateschi123456', ['Luiz Frateschi', 'luiz@clinica.com'])
    expect(r.aceita).toBe(false)
    expect(r.problemas.join(' ')).toMatch(/nome ou e-mail/)
  })

  it('não confunde termo curto do contexto', () => {
    // "ana" tem 3 letras: curto demais para bloquear qualquer senha que a contenha.
    const r = avaliarSenha('banana com cadeira', ['Ana'])
    expect(r.aceita, r.problemas.join(' ')).toBe(true)
  })

  it('recusa espaço nas pontas — o usuário não vê e não consegue reproduzir', () => {
    expect(avaliarSenha(' cadeira azul do consultorio').aceita).toBe(false)
    expect(avaliarSenha('cadeira azul do consultorio ').aceita).toBe(false)
  })

  it('acumula todos os problemas de uma vez', () => {
    // Curta, pouco variada e sequencial.
    expect(avaliarSenha('123456').problemas.length).toBeGreaterThan(1)
  })
})

describe('senha temporária', () => {
  it('tem formato ditável e passa na própria política', () => {
    for (let i = 0; i < 20; i++) {
      const s = gerarSenhaTemporaria()
      expect(s).toMatch(/^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/)
      expect(avaliarSenha(s).aceita, `"${s}" reprovou: ${avaliarSenha(s).problemas}`).toBe(true)
    }
  })

  it('não usa caracteres ambíguos — vai ser ditada por telefone', () => {
    for (let i = 0; i < 50; i++) {
      expect(gerarSenhaTemporaria()).not.toMatch(/[0O1lI]/)
    }
  })

  it('é diferente a cada chamada', () => {
    const amostras = new Set(Array.from({ length: 30 }, () => gerarSenhaTemporaria()))
    expect(amostras.size).toBe(30)
  })
})
