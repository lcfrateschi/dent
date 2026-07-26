import { ArmazenamentoEmDisco } from './disco'
import { ArmazenamentoS3 } from './s3'
import { ErroArmazenamento, type ProvedorArmazenamento } from './tipos'

export { ArmazenamentoEmDisco } from './disco'
export { ArmazenamentoS3 } from './s3'
export * from './tipos'

/**
 * Escolha do provedor de armazenamento.
 *
 * **Disco é o padrão.** Mesma lógica do provedor simulado do WhatsApp: nunca cair
 * para o remoto por omissão. Com variáveis pela metade, escrever num bucket
 * errado — ou num bucket público — é pior que escrever em disco local.
 *
 * A raiz em disco tem default para `docker compose up` funcionar sem `.env`, mas
 * **em produção é obrigatório declarar** onde os anexos moram: um default
 * escondido dentro do container significa radiografia apagada no próximo deploy.
 */
let cache: ProvedorArmazenamento | null = null

export function armazenamento(env: NodeJS.ProcessEnv = process.env): ProvedorArmazenamento {
  if (cache) return cache
  cache = criar(env)
  return cache
}

/** Só para teste: descarta o provedor memorizado. */
export function esquecerArmazenamento(): void {
  cache = null
}

function criar(env: NodeJS.ProcessEnv): ProvedorArmazenamento {
  if (env.ARMAZENAMENTO === 's3') {
    const host = env.S3_HOST
    const accessKeyId = env.S3_ACCESS_KEY_ID
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY
    if (!host || !accessKeyId || !secretAccessKey) {
      throw new ErroArmazenamento(
        'NAO_CONFIGURADO',
        'ARMAZENAMENTO=s3 exige S3_HOST, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY. ' +
          'Não há queda automática para disco: metade da configuração significa ' +
          'anexo gravado no lugar errado.',
      )
    }
    return new ArmazenamentoS3({
      host,
      accessKeyId,
      secretAccessKey,
      region: env.S3_REGION ?? 'auto',
    })
  }

  const raiz = env.ARMAZENAMENTO_RAIZ
  if (!raiz) {
    if (env.NODE_ENV === 'production') {
      throw new ErroArmazenamento(
        'NAO_CONFIGURADO',
        'ARMAZENAMENTO_RAIZ é obrigatória em produção: sem ela os anexos do ' +
          'prontuário iriam para dentro do container e desapareceriam no deploy.',
      )
    }
    return new ArmazenamentoEmDisco('/tmp/dent-anexos')
  }
  return new ArmazenamentoEmDisco(raiz)
}
