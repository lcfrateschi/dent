/**
 * Recusa subir em produção com o segredo de desenvolvimento.
 *
 * O `docker-compose.yml` precisa ter um default para `AUTH_SECRET`, senão o
 * `docker compose up` de desenvolvimento quebra. Isso cria o risco de alguém
 * levar esse default para produção — e o segredo do JWT vazado significa
 * sessão forjada para qualquer perfil, inclusive admin.
 *
 * Então a checagem fica aqui, no runtime, onde `NODE_ENV` já é confiável.
 */

import { MFA_CHAVE_DEV } from './mfaSegredo'

const SEGREDO_DEV = 'dev-secret-trocar-em-producao-0123456789abcdef'
const MIN_CARACTERES = 32

/**
 * Segredo do webhook do WhatsApp, com default de desenvolvimento no compose pelo
 * mesmo motivo. O risco aqui é diferente e não menor: com ele, qualquer pessoa
 * assina um POST dizendo "o paciente cancelou" e **cancela consulta alheia**.
 */
const SEGREDO_WHATSAPP_DEV = 'dev-whatsapp-app-secret-trocar-em-producao'

export function exigirSegredoDeProducao(): void {
  if (process.env.NODE_ENV !== 'production') return

  /**
   * Durante `next build` esta checagem não se aplica.
   *
   * O build roda com `NODE_ENV=production` (é o que faz o bundle ser de
   * produção) e importa os módulos das páginas para coletar rotas — o que
   * executava esta função e fazia o **build da imagem exigir os segredos de
   * produção**. Compilar não é servir: quem constrói a imagem no CI não deve
   * precisar do App Secret da Meta.
   *
   * A garantia continua inteira: `phase-production-build` só existe dentro do
   * `next build`. Ao subir o servidor e a cada requisição, a checagem vale.
   */
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  /**
   * A chave que desliga o segundo fator não existe em produção.
   *
   * Vem primeiro de propósito: é a pior das configurações erradas. Sem MFA, uma
   * senha vazada abre o prontuário de todos os pacientes — e um `.env` copiado do
   * desenvolvimento é a forma mais comum de isso acontecer. Melhor o deploy
   * quebrar na cara de quem o fez.
   */
  if (process.env.MFA_DESABILITADO === 'true') {
    throw new Error(
      'MFA_DESABILITADO=true não é permitido em produção. Segundo fator é ' +
        'exigência de prontuário: sem ele, uma senha vazada abre o histórico ' +
        'clínico de todos os pacientes. Remova a chave do ambiente.',
    )
  }

  /**
   * A chave que cifra o segredo do segundo fator.
   *
   * Fica **junto** da checagem acima, e não no fim, porque as duas são sobre a mesma
   * coisa: quem for procurar "o que garante o MFA em produção" acha os dois casos no
   * mesmo lugar, em vez de descobrir metade.
   *
   * A gravidade é menor que a de `MFA_DESABILITADO` e é real: com a chave pública,
   * um dump de banco volta a entregar o segundo fator de todos os usuários. Não é
   * bypass — ainda exige a senha —, é o agravamento que cifrar existe para tirar. Sem
   * chave nenhuma, `cifrarSegredo()` estoura na primeira gravação, o que seria uma
   * falha em produção descoberta pelo usuário; melhor descobrir no boot.
   */
  const chaveMfa = process.env.MFA_CHAVE
  if (!chaveMfa) {
    throw new Error(
      'MFA_CHAVE não definida. Ela cifra o segredo do segundo fator em repouso — ' +
        'sem ela o sistema não consegue gravar segredo novo. ' +
        'Gere uma com: openssl rand -base64 48',
    )
  }
  if (chaveMfa === MFA_CHAVE_DEV) {
    throw new Error(
      'MFA_CHAVE está com o valor de desenvolvimento, que é público. ' +
        'Com ele, um dump do banco entrega o segundo fator de todos os usuários. ' +
        'Gere uma própria com: openssl rand -base64 48',
    )
  }
  if (chaveMfa.length < MIN_CARACTERES) {
    throw new Error(
      `MFA_CHAVE curta demais (${chaveMfa.length} caracteres). ` +
        `Use pelo menos ${MIN_CARACTERES}: openssl rand -base64 48`,
    )
  }

  /**
   * ⚠️ Trocar `MFA_CHAVE` num sistema em operação **tranca todo mundo fora do
   * segundo fator**: os valores gravados não decifram com a chave nova. O caminho de
   * troca está escrito em `lib/auth/mfaSegredo.ts` (versão `v2` no formato), e o
   * caminho de emergência é reiniciar o MFA dos usuários — que apaga o segredo, nunca
   * o mostra.
   */

  const whatsapp = process.env.WHATSAPP_APP_SECRET
  if (whatsapp === SEGREDO_WHATSAPP_DEV) {
    throw new Error(
      'WHATSAPP_APP_SECRET está com o valor de desenvolvimento. ' +
        'Use o App Secret da sua aplicação na Meta — com o valor público, ' +
        'qualquer pessoa consegue cancelar consultas pelo webhook.',
    )
  }

  const segredo = process.env.AUTH_SECRET

  if (!segredo) {
    throw new Error('AUTH_SECRET não definida. Gere uma com: openssl rand -base64 48')
  }
  if (segredo === SEGREDO_DEV) {
    throw new Error(
      'AUTH_SECRET está com o valor de desenvolvimento. ' +
        'Gere uma própria com: openssl rand -base64 48',
    )
  }
  if (segredo.length < MIN_CARACTERES) {
    throw new Error(
      `AUTH_SECRET curta demais (${segredo.length} caracteres). ` +
        `Use pelo menos ${MIN_CARACTERES}: openssl rand -base64 48`,
    )
  }
}
