import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Cifra do segredo TOTP em repouso.
 *
 * ── O que isto resolve, e o que NÃO resolve ─────────────────────────────────
 * `usuario.mfa_secret` estava em texto claro. Não era bypass de autenticação — o
 * login continua exigindo a senha — mas **agravava um vazamento de banco**: quem
 * lesse um dump passava a gerar códigos válidos de todo mundo, e o segundo fator
 * deixava de ser segundo fator. Um dump é o cenário realista (backup mal guardado,
 * réplica de leitura exposta, `pg_dump` num laptop), e é exatamente o cenário em que
 * cifrar ajuda.
 *
 * O que isto **não** resolve: aplicação comprometida. Quem executa código no
 * processo tem a chave e decifra. Cifra em repouso protege o dado separado do
 * sistema, não o sistema.
 *
 * ── A chave vem do AMBIENTE, nunca do banco ────────────────────────────────
 * É o ponto inteiro. Chave guardada ao lado do dado cifrado transforma cifra em
 * ofuscação: o mesmo dump que leva o segredo leva a chave. `MFA_CHAVE` vive no
 * ambiente do processo, e `exigirSegredoDeProducao()` recusa subir produção sem ela
 * ou com o valor de desenvolvimento.
 *
 * ── AES-256-GCM, e por que não CBC ─────────────────────────────────────────
 * GCM é AEAD: ele **autentica**. Trocar um byte do texto cifrado faz a decifragem
 * falhar, em vez de devolver lixo silenciosamente. Com CBC, adulterar o dado produz
 * um "segredo" diferente e plausível — e o efeito seria um usuário que
 * misteriosamente não consegue mais entrar, sem nada no log dizendo que a linha foi
 * mexida. Falha alta vale mais que falha silenciosa.
 *
 * ── HKDF, e por que não scrypt ─────────────────────────────────────────────
 * `scrypt` e `PBKDF2` existem para encarecer a força bruta de entrada de **baixa**
 * entropia — senha digitada por gente. `MFA_CHAVE` é 32+ bytes de `openssl rand`:
 * força bruta já é impossível, e um KDF caro só acrescentaria custo a cada login.
 * HKDF é a ferramenta certa para o trabalho que existe aqui: expandir um segredo de
 * alta entropia numa subchave com **separação de domínio** (o `info`), para que a
 * mesma `MFA_CHAVE` reusada em outro lugar nunca produza a mesma subchave.
 *
 * ── O `id` do usuário entra como AAD ───────────────────────────────────────
 * O dado associado autenticado amarra o texto cifrado À LINHA. Sem isso, o valor de
 * um usuário pode ser **copiado para a linha de outro** e continua decifrando: quem
 * conseguisse um `UPDATE` (ou uma restauração parcial que embaralhasse linhas)
 * poria o próprio segredo — de que já tem o autenticador — na conta do administrador.
 * Com AAD, o texto cifrado de A na linha de B não decifra. Custa nada e fecha isso.
 *
 * ── Formato ────────────────────────────────────────────────────────────────
 *   `v1$<nonce base64url>$<texto cifrado + tag base64url>`
 *
 * Autodescritivo de propósito, e é o que dispensou migration:
 *
 *   • a coluna já é `text`, o valor cifrado cabe;
 *   • o segredo TOTP legado é base32 (`[A-Z2-7]`), então **não tem `$`** — a
 *     ausência do prefixo identifica texto claro sem tabela de controle nem coluna
 *     nova;
 *   • `v1` → `v2` permite rotação de chave **sem parada**: o novo escreve `v2`, o
 *     antigo continua lendo `v1`, e a recifragem preguiçosa converge.
 *
 * base64url e não base64: `+` e `/` são inofensivos, mas `=` de padding e `/` em log
 * ou em URL de suporte irritam sem necessidade.
 */

/** Rótulo de separação de domínio do HKDF. Mudar isto invalida todo `v1` gravado. */
const INFO_V1 = 'facilident:mfa_secret:aes-256-gcm:v1'

/**
 * Valor de desenvolvimento, com default no `docker-compose.yml` pelo mesmo motivo de
 * `AUTH_SECRET`: sem default, `docker compose up` quebra. `lib/auth/segredo.ts`
 * recusa este valor em produção.
 */
export const MFA_CHAVE_DEV = 'dev-mfa-key-trocar-em-producao-0123456789abcdef'

const VERSAO_ATUAL = 'v1'
const BYTES_NONCE = 12 // padrão do GCM; 96 bits é o tamanho para o qual ele foi desenhado
const BYTES_TAG = 16
const MIN_CARACTERES_CHAVE = 32

/**
 * A subchave de 32 bytes, derivada uma vez por processo.
 *
 * Em cache porque o HKDF roda a cada login e a cada leitura de segredo — barato, mas
 * não gratuito. O cache é por valor da chave: se `MFA_CHAVE` mudar em memória (só
 * acontece em teste), a derivação refaz.
 */
let cache: { origem: string; subchave: Buffer } | undefined

function subchave(): Buffer {
  const bruta = process.env.MFA_CHAVE

  /**
   * Ausência de chave **estoura**, em qualquer ambiente. A tentação era cair para
   * texto claro quando a chave falta ("assim nada quebra") — e isso traria a dívida
   * de volta em silêncio, num deploy onde a variável se perdeu. Quem não tem chave
   * não grava segredo.
   */
  if (!bruta) {
    throw new Error(
      'MFA_CHAVE não definida: sem ela o segredo do segundo fator não pode ser ' +
        'cifrado. Gere uma com: openssl rand -base64 48',
    )
  }
  if (bruta.length < MIN_CARACTERES_CHAVE) {
    throw new Error(
      `MFA_CHAVE curta demais (${bruta.length} caracteres). ` +
        `Use pelo menos ${MIN_CARACTERES_CHAVE}: openssl rand -base64 48`,
    )
  }

  if (cache?.origem === bruta) return cache.subchave

  /**
   * `salt` vazio é deliberado e não é descuido. O salt do HKDF existe para separar
   * derivações quando a entrada tem entropia baixa ou é reusada entre contextos;
   * aqui a entrada é aleatória e a separação de contexto é feita pelo `info`. Um
   * salt aleatório teria de ser **guardado junto do dado**, ou seja: mais um campo
   * no formato, para benefício nenhum.
   */
  const derivada = Buffer.from(hkdfSync('sha256', bruta, Buffer.alloc(0), INFO_V1, 32))
  cache = { origem: bruta, subchave: derivada }
  return derivada
}

/** `true` quando o valor gravado é texto claro anterior à cifra. */
export function ehTextoClaro(valor: string): boolean {
  return !/^v\d+\$/.test(valor)
}

/**
 * Cifra um segredo TOTP para gravar.
 *
 * `usuarioId` entra como AAD — passe o dono da linha, sempre o mesmo em
 * `cifrarSegredo` e `decifrarSegredo`, senão a decifragem falha (e é bom que falhe).
 */
export function cifrarSegredo(segredo: string, usuarioId: string): string {
  if (segredo.length === 0) {
    throw new Error('Segredo vazio não se cifra.')
  }
  const nonce = randomBytes(BYTES_NONCE)
  const cifra = createCipheriv('aes-256-gcm', subchave(), nonce)
  cifra.setAAD(Buffer.from(usuarioId, 'utf8'))
  const corpo = Buffer.concat([cifra.update(segredo, 'utf8'), cifra.final(), cifra.getAuthTag()])
  return `${VERSAO_ATUAL}$${nonce.toString('base64url')}$${corpo.toString('base64url')}`
}

export interface SegredoDecifrado {
  readonly segredo: string
  /**
   * `true` quando o valor lido não está no formato atual — texto claro legado ou
   * versão anterior. Quem tem como escrever deve recifrar; ver `lib/auth/config.ts`.
   */
  readonly precisaRecifrar: boolean
}

/**
 * Devolve o segredo em claro para uso imediato (gerar ou verificar código).
 *
 * Aceita texto claro legado **de propósito**: é a migração preguiçosa. Segredo
 * gravado antes da cifra continua funcionando, e é recifrado na próxima vez que o
 * sistema o toca — ninguém precisa de janela de manutenção, e nenhum usuário perde o
 * autenticador.
 *
 * Estoura quando o valor está no formato cifrado e **não** decifra: chave errada,
 * chave rotacionada sem o caminho de leitura, ou linha adulterada. Estourar é o
 * comportamento certo — o alternativo seria tratar como "MFA não configurado", que
 * deixaria alguém entrar sem segundo fator por causa de um byte trocado.
 */
export function decifrarSegredo(valor: string, usuarioId: string): SegredoDecifrado {
  if (ehTextoClaro(valor)) {
    return { segredo: valor, precisaRecifrar: true }
  }

  const partes = valor.split('$')
  if (partes.length !== 3) {
    throw new Error('Segredo de MFA em formato inválido.')
  }
  const [versao, nonceB64, corpoB64] = partes as [string, string, string]

  if (versao !== 'v1') {
    // Aqui é onde `v2` entra quando a rotação acontecer: um `switch` que escolhe o
    // `info` e a subchave da versão lida. Hoje só existe uma, e afirmar isso é
    // melhor que aceitar em silêncio o que não se sabe decifrar.
    throw new Error(`Versão de cifra desconhecida no segredo de MFA: ${versao}.`)
  }

  const nonce = Buffer.from(nonceB64, 'base64url')
  const corpo = Buffer.from(corpoB64, 'base64url')
  if (nonce.length !== BYTES_NONCE || corpo.length <= BYTES_TAG) {
    throw new Error('Segredo de MFA truncado.')
  }

  const tag = corpo.subarray(corpo.length - BYTES_TAG)
  const cifrado = corpo.subarray(0, corpo.length - BYTES_TAG)

  const decifra = createDecipheriv('aes-256-gcm', subchave(), nonce)
  decifra.setAAD(Buffer.from(usuarioId, 'utf8'))
  decifra.setAuthTag(tag)

  let claro: string
  try {
    claro = decifra.update(cifrado, undefined, 'utf8') + decifra.final('utf8')
  } catch {
    /**
     * A mensagem não diz por que falhou — chave errada, AAD errado e byte trocado
     * dão a mesma. Distinguir ajudaria quem investiga e ajudaria mais quem ataca:
     * "AAD errado" confirma que o texto cifrado é válido e foi movido de linha.
     *
     * E **nada do valor entra na mensagem**: texto cifrado em log é material para
     * ataque offline no dia em que a chave vazar.
     */
    throw new Error(
      'Não foi possível decifrar o segredo de MFA deste usuário. ' +
        'Chave de cifra trocada, ou a linha foi alterada. ' +
        'O caminho de recuperação é reiniciar o MFA do usuário (o segredo é apagado, não lido).',
    )
  }

  return { segredo: claro, precisaRecifrar: false }
}

/**
 * Compara dois segredos em tempo constante.
 *
 * Existe para o `/configurar-mfa`, que precisa saber se o segredo que a tela mostrou
 * é o mesmo que está gravado sem vazar a resposta pelo tempo. Comparação com `===`
 * curto-circuita no primeiro byte diferente.
 */
export function segredosIguais(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
