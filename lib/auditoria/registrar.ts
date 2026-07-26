import type { Ator } from '@/lib/authz/sessao'
import { db } from '@/lib/db'
import { auditLog } from '@/lib/db/schema'
import { headers } from 'next/headers'

/**
 * Trilha de auditoria.
 *
 * **Leitura também é evento auditável.** Dado de saúde é dado sensível na LGPD:
 * a pergunta que a clínica precisa saber responder não é só "quem alterou este
 * prontuário?", é "quem *olhou* este prontuário?".
 *
 * Duas decisões de projeto:
 *
 * 1. **Nunca derruba a operação.** Se gravar o log falhar, o erro vai para o
 *    stderr e a ação do usuário continua. Prontuário indisponível por causa da
 *    auditoria é pior do que um registro de auditoria perdido — e o `audit_log`
 *    é append-only no banco, então falha aqui é infraestrutura, não corrupção.
 *
 * 2. **Nunca grava conteúdo clínico em `detalhes`.** O log registra QUE houve
 *    acesso, não O QUE foi visto. Copiar o texto da evolução para cá criaria uma
 *    segunda cópia do prontuário fora das regras de retenção e de permissão.
 */

export type Acao =
  | 'leitura'
  | 'criacao'
  | 'atualizacao'
  | 'exclusao'
  | 'exportacao'
  | 'impressao'
  | 'login'
  | 'login_falho'
  | 'logout'

export interface EventoAuditoria {
  readonly ator: Pick<Ator, 'usuarioId' | 'email'> | null
  readonly acao: Acao
  /** Nome da tabela ou do agregado: 'paciente', 'evolucao', 'cobranca'. */
  readonly entidade: string
  readonly entidadeId?: string | null
  /**
   * Paciente cujo dado foi acessado. Denormalizado de propósito: responde
   * "quem acessou o prontuário deste paciente?" por índice.
   */
  readonly pacienteId?: string | null
  /** Contexto. NUNCA dado clínico — só metadado (campos alterados, filtros). */
  readonly detalhes?: Record<string, unknown>
}

export async function registrar(evento: EventoAuditoria): Promise<void> {
  try {
    const { ip, userAgent } = await origemDaRequisicao()

    await db.insert(auditLog).values({
      atorTipo: evento.ator ? 'staff' : 'sistema',
      atorId: evento.ator?.usuarioId ?? null,
      atorEmail: evento.ator?.email ?? null,
      acao: evento.acao,
      entidade: evento.entidade,
      entidadeId: evento.entidadeId ?? null,
      pacienteId: evento.pacienteId ?? null,
      ip,
      userAgent,
      detalhes: evento.detalhes ?? null,
    })
  } catch (e) {
    // Ver decisão 1 no comentário do módulo.
    console.error('[auditoria] falha ao registrar evento', {
      acao: evento.acao,
      entidade: evento.entidade,
      erro: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Atalho para leitura de dado clínico — o caso mais frequente e o mais fácil de
 * esquecer, justamente por não ser uma escrita.
 */
export async function registrarLeitura(
  ator: Pick<Ator, 'usuarioId' | 'email'>,
  entidade: string,
  pacienteId: string,
  detalhes?: Record<string, unknown>,
): Promise<void> {
  await registrar({ ator, acao: 'leitura', entidade, entidadeId: pacienteId, pacienteId, detalhes })
}

async function origemDaRequisicao(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers()
    // Atrás de proxy reverso, o IP real vem no primeiro item do x-forwarded-for.
    const encaminhado = h.get('x-forwarded-for')
    const ip =
      encaminhado?.split(',')[0]?.trim() ??
      h.get('x-real-ip') ??
      null
    return { ip: ip && ip.length <= 45 ? ip : null, userAgent: h.get('user-agent') }
  } catch {
    // Fora de contexto de requisição (script, cron): sem origem.
    return { ip: null, userAgent: null }
  }
}
