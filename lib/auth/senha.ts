import { type ScryptOptions, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'

/**
 * `promisify` escolhe a sobrecarga de 3 argumentos e perde o parâmetro de
 * opções — que é justamente onde vão N, r, p e maxmem. Daí o wrapper à mão.
 */
function scrypt(
  senha: string,
  salt: Buffer,
  tamanho: number,
  opcoes: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(senha, salt, tamanho, opcoes, (erro, chave) => {
      if (erro) reject(erro)
      else resolve(chave)
    })
  })
}

/**
 * Hash de senha com **scrypt** (RFC 7914), via `node:crypto`.
 *
 * Por que scrypt e não bcrypt/argon2: zero dependência — nem nativa, nem de
 * terceiros. Num sistema que guarda prontuário, cada pacote no caminho da
 * autenticação é superfície de ataque de cadeia de suprimentos. scrypt está no
 * runtime, é memory-hard e é primitiva reconhecida.
 *
 * Parâmetros: N=2^15 (32768), r=8, p=1 → ~32 MB por verificação, algo em torno
 * de 100 ms num servidor comum. Custo alto o bastante para força bruta e baixo
 * o bastante para a recepção não esperar no login.
 *
 * Formato guardado em `usuario.senha_hash`:
 *   scrypt$N$r$p$<salt-base64url>$<hash-base64url>
 * Os parâmetros ficam no próprio hash para poder endurecê-los depois sem
 * invalidar as senhas existentes.
 */

const N = 32768
const R = 8
const P = 1
const TAMANHO_HASH = 32
const TAMANHO_SALT = 16
/** `maxmem` do Node precisa acomodar 128 * N * r; o padrão de 32MB não basta. */
const MAX_MEM = 128 * N * R * 2

export async function gerarHashSenha(senha: string): Promise<string> {
  const salt = randomBytes(TAMANHO_SALT)
  const hash = await scrypt(senha.normalize('NFKC'), salt, TAMANHO_HASH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  })

  return ['scrypt', N, R, P, b64(salt), b64(hash)].join('$')
}

/**
 * Verifica a senha em tempo constante.
 *
 * Nunca lança: qualquer hash malformado devolve `false`. Um erro aqui viraria
 * mensagem diferente na tela de login e vazaria se o usuário existe.
 */
export async function verificarSenha(senha: string, armazenado: string): Promise<boolean> {
  try {
    const partes = armazenado.split('$')
    if (partes.length !== 6 || partes[0] !== 'scrypt') return false

    const [, nStr, rStr, pStr, saltB64, hashB64] = partes as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const n = Number(nStr)
    const r = Number(rStr)
    const p = Number(pStr)
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
    // Barreira contra hash adulterado no banco pedindo memória absurda (DoS).
    if (n > 1 << 20 || r > 32 || p > 16) return false

    const salt = deB64(saltB64)
    const esperado = deB64(hashB64)
    // Sem isto, um hash com salt e digest vazios validaria QUALQUER senha:
    // scrypt devolveria 0 bytes e `timingSafeEqual(vazio, vazio)` daria true.
    if (salt.length < 8 || esperado.length < 16) return false

    const obtido = await scrypt(senha.normalize('NFKC'), salt, esperado.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    })

    return obtido.length === esperado.length && timingSafeEqual(obtido, esperado)
  } catch {
    return false
  }
}

/** Indica que o hash usa parâmetros antigos e deve ser regerado no próximo login. */
export function precisaRehash(armazenado: string): boolean {
  const partes = armazenado.split('$')
  if (partes.length !== 6 || partes[0] !== 'scrypt') return true
  return Number(partes[1]) < N || Number(partes[2]) < R
}

// ── Política de senha ────────────────────────────────────────────────────────

export interface AvaliacaoSenha {
  readonly aceita: boolean
  readonly problemas: readonly string[]
}

const MIN_CARACTERES = 12

/**
 * Política de senha para staff.
 *
 * Comprimento acima de complexidade: 12 caracteres é o mínimo, e uma frase é
 * melhor do que `S3nh@!`. Exigir símbolo obrigatório empurra a pessoa para
 * padrões previsíveis e para o post-it no monitor.
 */
export function avaliarSenha(senha: string, contexto: readonly string[] = []): AvaliacaoSenha {
  const problemas: string[] = []

  if (senha.length < MIN_CARACTERES) {
    problemas.push(`Use pelo menos ${MIN_CARACTERES} caracteres.`)
  }
  if (/^\s|\s$/.test(senha)) {
    problemas.push('Não comece nem termine com espaço.')
  }
  if (new Set(senha).size < 5) {
    problemas.push('Varie mais os caracteres.')
  }
  if (/^(.)\1+$/.test(senha)) {
    problemas.push('Não repita o mesmo caractere.')
  }
  if (SEQUENCIAS.some((s) => senha.toLowerCase().includes(s))) {
    problemas.push('Evite sequências óbvias como "123456" ou "qwerty".')
  }
  if (COMUNS.has(senha.toLowerCase())) {
    problemas.push('Esta senha é muito comum.')
  }
  // Nome e e-mail do próprio usuário são o primeiro palpite de quem ataca.
  // Compara palavra por palavra: quem se chama "Luiz Frateschi" costuma usar
  // só o sobrenome, e o termo inteiro nunca casaria.
  const minuscula = senha.toLowerCase()
  const palavras = contexto
    .flatMap((termo) => termo.toLowerCase().split(/[^a-z0-9à-ú]+/))
    .filter((p) => p.length >= 4)

  if (palavras.some((p) => minuscula.includes(p))) {
    problemas.push('Não use seu nome ou e-mail na senha.')
  }

  return { aceita: problemas.length === 0, problemas }
}

const SEQUENCIAS = ['123456', 'abcdef', 'qwerty', 'asdfgh', '654321', 'password', 'senha123']

const COMUNS = new Set([
  'senha123456',
  'dentista123',
  'consultorio1',
  'password1234',
  '123456789012',
  'qwertyuiop12',
  'clinica12345',
])

// ── Utilidades ───────────────────────────────────────────────────────────────

function b64(b: Buffer): string {
  return b.toString('base64url')
}

function deB64(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

/** Senha aleatória legível, para o primeiro acesso. */
export function gerarSenhaTemporaria(): string {
  // Sem caracteres ambíguos (0/O, 1/l/I): a recepção vai ditar isto por telefone.
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(20)
  let s = ''
  for (const b of bytes) s += alfabeto[b % alfabeto.length]
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`
}
