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
