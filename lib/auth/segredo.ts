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

export function exigirSegredoDeProducao(): void {
  if (process.env.NODE_ENV !== 'production') return

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
