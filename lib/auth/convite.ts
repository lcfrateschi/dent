import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Convite de primeiro acesso ao portal.
 *
 * **Por que convite em vez de senha temporária.** O sistema não envia e-mail, e a
 * recepção precisa de algo para entregar ao paciente. Senha temporária resolveria
 * — e criaria o problema: ela circula por WhatsApp, fica no histórico da conversa
 * e **continua válida** até alguém trocar. O convite morre no uso (trigger em
 * `drizzle/0013`) e expira em dias, não em nunca.
 *
 * **O token nunca é gravado.** O banco guarda só o SHA-256. Quem tem acesso de
 * leitura ao banco — um dump vazado, um backup mal guardado — não consegue entrar
 * na conta de nenhum paciente.
 *
 * SHA-256 sem sal, e isto é deliberado: o token tem 160 bits de entropia
 * aleatória, então não existe dicionário nem rainbow table que ajude. Sal e
 * scrypt protegem segredo escolhido por humano; aqui a proteção é a entropia.
 */

/**
 * 32 caracteres de um alfabeto de 32 símbolos = **160 bits** de entropia.
 *
 * A conta importa: cada caractere carrega log2(32) = 5 bits, então o número de
 * caracteres é o que define a força — não o número de bytes sorteados. Uma versão
 * anterior disto sorteava 20 bytes e gerava 20 caracteres, o que dá 100 bits e não
 * os 160 que o comentário prometia.
 *
 * `% 32` sobre um byte uniforme não introduz viés porque 256 é múltiplo de 32:
 * cada símbolo corresponde a exatamente 8 dos 256 valores possíveis.
 */
const CARACTERES_TOKEN = 32

/** Alfabeto sem caractere ambíguo: a recepção vai ditar isto por telefone. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const VALIDADE_CONVITE_DIAS = 7

export interface Convite {
  /** O token em claro. Entregue ao paciente e **nunca gravado**. */
  readonly token: string
  /** O que vai para o banco. */
  readonly hash: string
  readonly expiraEm: Date
}

/**
 * Gera um convite.
 *
 * `agora` é parâmetro para o teste poder verificar a expiração sem depender do
 * relógio.
 */
export function gerarConvite(agora: Date = new Date(), validadeDias = VALIDADE_CONVITE_DIAS): Convite {
  const bytes = randomBytes(CARACTERES_TOKEN)
  let token = ''
  for (const b of bytes) token += ALFABETO[b % ALFABETO.length]

  return {
    token,
    hash: hashDoToken(token),
    expiraEm: new Date(agora.getTime() + validadeDias * 86_400_000),
  }
}

export function hashDoToken(token: string): string {
  return createHash('sha256').update(normalizar(token), 'utf8').digest('hex')
}

/**
 * Normaliza o que o paciente digitou.
 *
 * Ele vai receber `A3F7-K92M-...` num papel e digitar com espaço, com hífen, em
 * minúscula. Recusar por causa disso transformaria um erro de digitação em
 * chamada telefônica. O que **não** é tolerado é caractere fora do alfabeto —
 * `O` em vez de `0` não existe aqui porque o alfabeto não tem nenhum dos dois.
 */
export function normalizar(token: string): string {
  return token.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Confere o token contra o hash guardado, em tempo constante.
 *
 * `timingSafeEqual` porque a comparação `===` sai no primeiro byte diferente, e a
 * diferença de tempo vaza o prefixo correto. Com 32 caracteres, vazar prefixo é
 * vazar o token inteiro em algumas centenas de tentativas.
 */
export function conferirConvite(token: string, hashGuardado: string | null): boolean {
  if (!hashGuardado || !/^[0-9a-f]{64}$/i.test(hashGuardado)) return false

  const limpo = normalizar(token)
  // Compara o número de CARACTERES. Comparar com o número de bytes sorteados
  // recusaria todo token válido — e foi o que aconteceu antes de o teste pegar.
  if (limpo.length !== CARACTERES_TOKEN) return false

  const a = Buffer.from(hashDoToken(limpo), 'hex')
  const b = Buffer.from(hashGuardado.toLowerCase(), 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** `A3F7-K92M-XY4B-...` — em blocos de 4, para ler e digitar sem errar. */
export function formatarConvite(token: string): string {
  return (normalizar(token).match(/.{1,4}/g) ?? []).join('-')
}

/** `true` se o prazo do convite passou. */
export function conviteExpirou(expiraEm: Date | null, agora: Date = new Date()): boolean {
  if (!expiraEm) return true
  return expiraEm.getTime() <= agora.getTime()
}

// ── Token de sessão ──────────────────────────────────────────────────────────

/** 32 bytes de entropia. Vai para o cookie; o banco guarda só o hash. */
export function gerarTokenDeSessao(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashDoTokenDeSessao(token) }
}

/**
 * Hash do token de sessão.
 *
 * Separado de `hashDoToken` de propósito: aquele normaliza (maiúsculas, remove
 * separador) porque o convite é digitado por uma pessoa. O token de sessão vem do
 * cookie e é usado como está — normalizar aqui reduziria o espaço de busca e
 * faria `abc` e `ABC` colidirem.
 */
export function hashDoTokenDeSessao(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
